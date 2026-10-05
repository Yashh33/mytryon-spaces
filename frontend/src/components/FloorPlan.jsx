import { useRef } from "react";
import {
  ARC_TYPES,
  ARM_SHAPES,
  BAND_TYPES,
  DASHED_GAP_TYPES,
  DOUBLE_DASHED_GAP_TYPES,
  GAP_TYPES,
  POINT_TYPES,
  WALL_KEY,
  WINDOW_TYPES,
  armExtent,
  armParams,
  assignLabelRows,
  cameraGeometry,
  clamp01,
  featureColor,
  featureFootprint,
  featureSpan,
  isBed,
  isDiningTable,
  isStraightSofa,
  labelPosition,
  mergeAdjacentFeatures,
  placementRects,
  planGeometry,
  rectsOverlap,
  roomFeet,
  shadeColor,
  sofaSeatCount,
  translatePlacement,
} from "../placement.js";

const WALLS = ["far", "left", "right", "near"];

// Wood tone for dining tables, and the fixed palette for bed pillows/sheet —
// drawing-only constants, not part of the block's own PALETTE colour.
const WOOD_FILL = "#E8D5C0";
const WOOD_BORDER = "#8B5A2B";

function wallLine(wall, geom) {
  const { roomX, roomY, roomW, roomH } = geom;
  if (wall === "far") return { x1: roomX, y1: roomY, x2: roomX + roomW, y2: roomY, axis: "x" };
  if (wall === "near") return { x1: roomX, y1: roomY + roomH, x2: roomX + roomW, y2: roomY + roomH, axis: "x" };
  if (wall === "left") return { x1: roomX, y1: roomY, x2: roomX, y2: roomY + roomH, axis: "y" };
  return { x1: roomX + roomW, y1: roomY, x2: roomX + roomW, y2: roomY + roomH, axis: "y" }; // right
}

/** Point along a wall at normalised `t` (0-1), and an inward normal to
 * offset symbols/blocks slightly off the wall line. */
function wallPoint(wall, t, geom) {
  const { roomX, roomY, roomW, roomH } = geom;
  if (wall === "far") return { x: roomX + t * roomW, y: roomY, nx: 0, ny: 1 };
  if (wall === "near") return { x: roomX + t * roomW, y: roomY + roomH, nx: 0, ny: -1 };
  if (wall === "left") return { x: roomX, y: roomY + t * roomH, nx: 1, ny: 0 };
  return { x: roomX + roomW, y: roomY + t * roomH, nx: -1, ny: 0 }; // right
}

function segmentBetween(line, from, to, geom) {
  if (from >= to) return { x1: line.x1, y1: line.y1, x2: line.x1, y2: line.y1 };
  if (line.axis === "x") {
    return { x1: line.x1 + from * geom.roomW, y1: line.y1, x2: line.x1 + to * geom.roomW, y2: line.y1 };
  }
  return { x1: line.x1, y1: line.y1 + from * geom.roomH, x2: line.x1, y2: line.y1 + to * geom.roomH };
}

/** Two thin lines spanning a gap, straddling the wall line — used for
 * windows (solid) and glazed openings (dashed, "doubled"). */
function parallelLines(a, b, dashed, stroke) {
  const off1 = { x: a.nx * -2, y: a.ny * -2 };
  const off2 = { x: a.nx * 2, y: a.ny * 2 };
  const cls = "fp-window" + (dashed ? " fp-dashed" : "");
  return (
    <>
      <line x1={a.x + off1.x} y1={a.y + off1.y} x2={b.x + off1.x} y2={b.y + off1.y} className={cls} stroke={stroke} />
      <line x1={a.x + off2.x} y1={a.y + off2.y} x2={b.x + off2.x} y2={b.y + off2.y} className={cls} stroke={stroke} />
    </>
  );
}

function featureLabel(group) {
  if ((group.type === "unknown" || group.type === "other") && group.notes) return group.notes;
  return group.type || "feature";
}

/** Feature types actually present on the plan right now, for the legend —
 * de-duplicated, in first-seen order. */
function presentFeatureTypes(layout) {
  const seen = [];
  WALLS.forEach((wall) => {
    const features = layout?.[WALL_KEY[wall]]?.features || [];
    features.forEach((f) => {
      if (f.type && !seen.includes(f.type)) seen.push(f.type);
    });
  });
  (layout?.obstructions || []).forEach((o) => {
    if (o.type && !seen.includes(o.type)) seen.push(o.type);
  });
  return seen;
}

const noop = () => {};

export function FloorPlan({
  room,
  blocks = [],
  selectedKey = null,
  onSelectBlock = noop,
  onMoveBlock = noop,
  onCommitBlock = noop,
  onResizeBlock = noop,
  onCommitResize = noop,
  onDropPendingAt = noop,
  pendingKey = null,
  addObstructionMode = false,
  onAddObstructionAt = noop,
  onTapFeature = noop,
  onTapObstruction = noop,
  readOnly = false,
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null); // { mode: "move"|"resize", key, pointerId, startX, startY, orig, moved }

  const layout = room.layout_json;
  const geom = planGeometry(layout?.depth_vs_width);
  const feet = roomFeet(layout?.depth_vs_width);

  function toNormalized(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * geom.planW;
    const py = ((clientY - rect.top) / rect.height) * geom.planH;
    return {
      x: clamp01((px - geom.roomX) / geom.roomW),
      y: clamp01((py - geom.roomY) / geom.roomH),
    };
  }

  function handleBackgroundPointerUp(e) {
    if (dragRef.current) return; // a block drag is finishing, not a background tap
    const { x, y } = toNormalized(e.clientX, e.clientY);
    if (addObstructionMode) {
      onAddObstructionAt(x, y);
      return;
    }
    if (pendingKey) {
      onDropPendingAt(pendingKey, x, y);
      return;
    }
    onSelectBlock(null);
  }

  function startDrag(e, block, mode) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toNormalized(e.clientX, e.clientY);
    dragRef.current = { mode, key: block.key, pointerId: e.pointerId, startX: p.x, startY: p.y, orig: block.placement, moved: false };
    onSelectBlock(block.key);
  }

  function moveDrag(e, block) {
    const drag = dragRef.current;
    if (!drag || drag.key !== block.key || drag.pointerId !== e.pointerId) return;
    const p = toNormalized(e.clientX, e.clientY);
    drag.moved = true;
    const resizeHandle = { resize: "length", "resize-short": "short", "resize-depth": "depth" }[drag.mode];
    if (resizeHandle) {
      onResizeBlock(block.key, drag.orig, p.x, p.y, resizeHandle);
    } else {
      onMoveBlock(block.key, translatePlacement(block.shape, drag.orig, p.x - drag.startX, p.y - drag.startY));
    }
  }

  function endDrag(e, block) {
    const drag = dragRef.current;
    if (!drag || drag.key !== block.key || drag.pointerId !== e.pointerId) return;
    // the svg's own pointerup would otherwise read this as a background tap and deselect
    e.stopPropagation();
    dragRef.current = null;
    if (!drag.moved) return;
    if (drag.mode === "resize" || drag.mode === "resize-short" || drag.mode === "resize-depth") onCommitResize(block.key);
    else onCommitBlock(block.key, block.placement);
  }

  function dragHandlers(block, mode) {
    if (readOnly) return {};
    return {
      onPointerDown: (e) => startDrag(e, block, mode),
      onPointerMove: (e) => moveDrag(e, block),
      onPointerUp: (e) => endDrag(e, block),
      onPointerCancel: (e) => endDrag(e, block),
    };
  }

  function renderWallFeatures(wall) {
    const wallData = layout?.[WALL_KEY[wall]];
    const partial = wallData?.confidence === "partial";
    const groups = mergeAdjacentFeatures(wallData?.features || []);
    const rows = assignLabelRows(groups, geom, wall);
    const line = wallLine(wall, geom);
    const elements = [];
    let cursor = 0;

    groups.forEach((group, gi) => {
      const [start, end] = group.span;
      const a = wallPoint(wall, start, geom);
      const b = wallPoint(wall, end, geom);
      const mid = wallPoint(wall, (start + end) / 2, geom);
      const key = `${wall}-feature-${gi}`;
      const type = group.type;
      const color = featureColor(type);

      if (GAP_TYPES.has(type)) {
        elements.push(<line key={`${key}-pre`} {...segmentBetween(line, cursor, start, geom)} className="fp-wall" />);
        cursor = end;
        if (WINDOW_TYPES.has(type)) {
          elements.push(<g key={`${key}-sym`}>{parallelLines(a, b, false, color.border)}</g>);
          elements.push(
            <line key={`${key}-fill`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color.fill} strokeWidth="4" strokeOpacity="0.6" />
          );
        } else if (DOUBLE_DASHED_GAP_TYPES.has(type)) {
          elements.push(<g key={`${key}-sym`}>{parallelLines(a, b, true, color.border)}</g>);
        } else if (DASHED_GAP_TYPES.has(type)) {
          elements.push(<line key={`${key}-d1`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="fp-dashed" stroke={color.border} strokeWidth="1.2" />);
        } else {
          // door / doorway / opening / unknown: a plain dashed gap-line in
          // the type's own colour, so even the ones without a dedicated
          // symbol below read as a coloured break in the wall.
          elements.push(<line key={`${key}-gap`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="fp-dashed" stroke={color.border} strokeWidth="1.2" />);
        }
        if (ARC_TYPES.has(type)) {
          const r = Math.hypot(b.x - a.x, b.y - a.y);
          const swingX = a.x + a.nx * r;
          const swingY = a.y + a.ny * r;
          elements.push(
            <path
              key={`${key}-arc`}
              d={`M ${b.x} ${b.y} A ${r} ${r} 0 0 1 ${swingX} ${swingY} M ${a.x} ${a.y} L ${swingX} ${swingY}`}
              className="fp-door-arc"
              stroke={color.border}
            />
          );
          elements.push(
            <path
              key={`${key}-leaf`}
              d={`M ${a.x} ${a.y} L ${swingX} ${swingY} L ${b.x} ${b.y} Z`}
              fill={color.fill}
              fillOpacity="0.5"
              stroke="none"
            />
          );
        }
      } else if (BAND_TYPES.has(type)) {
        elements.push(
          <line
            key={key}
            x1={a.x + a.nx * 5} y1={a.y + a.ny * 5}
            x2={b.x + a.nx * 5} y2={b.y + a.ny * 5}
            className="fp-band"
            stroke={color.border}
          />
        );
      } else if (POINT_TYPES.has(type)) {
        elements.push(
          <rect
            key={key}
            x={mid.x + mid.nx * 8 - 5} y={mid.y + mid.ny * 8 - 5} width="10" height="10"
            fill={color.fill} stroke={color.border} strokeWidth="1.5" rx="2"
          />
        );
      } else {
        // recess / step / other / unknown-but-not-a-gap and anything else
        // not otherwise symbolised: a neutral tinted band on the wall.
        elements.push(
          <line
            key={key}
            x1={a.x + a.nx * 5} y1={a.y + a.ny * 5}
            x2={b.x + a.nx * 5} y2={b.y + a.ny * 5}
            stroke={color.border}
            strokeWidth="3"
            strokeOpacity="0.7"
          />
        );
      }

      if (partial && !GAP_TYPES.has(type)) {
        elements.push(
          <rect
            key={`${key}-unsure`}
            x={Math.min(a.x, b.x) - 4} y={Math.min(a.y, b.y) - 4}
            width={Math.max(Math.abs(b.x - a.x), 8) + 8} height={Math.max(Math.abs(b.y - a.y), 8) + 8}
            className="fp-unsure"
          />
        );
      }

      const label = labelPosition(wall, group.span, rows[gi], geom);
      elements.push(<line key={`${key}-leader`} x1={mid.x} y1={mid.y} x2={label.x} y2={label.y} className="fp-leader" />);
      elements.push(
        <text key={`${key}-label`} x={label.x} y={label.y} className="fp-label fp-label-caps" textAnchor={label.anchor}>
          {featureLabel(group)}
          {partial ? " ?" : ""}
        </text>
      );

      elements.push(
        <rect
          key={`${key}-hit`}
          x={Math.min(a.x, b.x) - 6} y={Math.min(a.y, b.y) - 6}
          width={Math.max(Math.abs(b.x - a.x), 12) + 12} height={Math.max(Math.abs(b.y - a.y), 12) + 12}
          className="fp-hit"
          onPointerUp={
            readOnly
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onTapFeature(wall, group.indices);
                }
          }
        />
      );
    });

    elements.push(<line key={`${wall}-tail`} {...segmentBetween(line, cursor, 1, geom)} className="fp-wall" />);
    return elements;
  }

  function renderObstructions() {
    const obstructions = layout?.obstructions || [];
    return obstructions
      .map((o, index) => (o.x != null && o.y != null ? { o, index } : null))
      .filter(Boolean)
      .map(({ o, index }) => {
        const px = geom.roomX + o.x * geom.roomW;
        const py = geom.roomY + o.y * geom.roomH;
        const color = featureColor(o.type || "pillar");
        return (
          <g key={`obstruction-${index}`}>
            <rect x={px - 6} y={py - 6} width="12" height="12" fill={color.fill} stroke={color.border} strokeWidth="1.5" rx="2" />
            <text x={px} y={py - 12} className="fp-label fp-label-caps" textAnchor="middle">
              {o.type || "obstruction"}
            </text>
            <rect
              x={px - 14} y={py - 14} width="28" height="28"
              className="fp-hit"
              onPointerUp={
                readOnly
                  ? undefined
                  : (e) => {
                      e.stopPropagation();
                      onTapObstruction(index);
                    }
              }
            />
          </g>
        );
      });
  }

  function renderCamera() {
    if (!layout) return null;
    const cam = cameraGeometry(layout.camera_position, geom);
    return (
      <g className="fp-camera">
        <line x1={cam.cx} y1={cam.cy} x2={cam.fanLeft.x} y2={cam.fanLeft.y} className="fp-camera-fan" />
        <line x1={cam.cx} y1={cam.cy} x2={cam.fanRight.x} y2={cam.fanRight.y} className="fp-camera-fan" />
        <circle cx={cam.cx} cy={cam.cy} r={cam.r} />
        <text x={cam.cx} y={cam.labelY} className="fp-label" textAnchor="middle">
          Camera
        </text>
      </g>
    );
  }

  function blockOverlapWarning(block) {
    for (const rect of placementRects(block.shape, block.placement)) {
      for (const obstruction of layout?.obstructions || []) {
        if (obstruction.x == null) continue;
        const footprint = { x: obstruction.x - 0.02, y: obstruction.y - 0.02, w: 0.04, h: 0.04 };
        if (rectsOverlap(rect, footprint)) return "an obstruction";
      }
      for (const wall of WALLS) {
        const wallData = layout?.[WALL_KEY[wall]];
        for (const feature of wallData?.features || []) {
          if (!feature.blocks_furniture) continue;
          const span = featureSpan(feature.position, feature.size);
          if (!span) continue;
          if (rectsOverlap(rect, featureFootprint(wall, span))) return `the ${feature.type}`;
        }
      }
    }
    return null;
  }

  function pxRect(rect) {
    return { X: geom.roomX + rect.x * geom.roomW, Y: geom.roomY + rect.y * geom.roomH, W: rect.w * geom.roomW, H: rect.h * geom.roomH };
  }

  /** Arm params in plan pixels, with the bend offset into plan space. */
  function pxArms(placement) {
    const p = armParams(placement, { wFt: geom.roomW, hFt: geom.roomH });
    const q = { ...p, bx: p.bx + geom.roomX, by: p.by + geom.roomY };
    return { p: q, e: armExtent(q) };
  }

  /** Everything needed to draw and control a placed block, in plan pixels:
   * its outline, seat/arm/backrest parts, bounding box and where the resize
   * handle(s) sit. Facing is read only to know which side is the BACK (no
   * arrows drawn any more). */
  function blockDrawing(block) {
    const { shape, placement } = block;

    if (ARM_SHAPES.has(shape)) {
      const { p, e } = pxArms(placement);
      const { sx, sy, hLen, vLen } = e;
      const d = p.depthFt; // plan pixels here, despite the name
      const at = (u, v) => [p.bx + sx * u, p.by + sy * v];
      const bbox = { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
      const handle = p.longAxis === "x" ? at(hLen, d) : at(d, vLen);
      const secondHandle = { pos: p.longAxis === "x" ? at(d, vLen) : at(hLen, d), kind: "short" };

      if (shape === "curved") {
        const C = at(hLen, vLen);
        const rx = hLen;
        const ry = vLen;
        const irx = Math.max(rx - d, 1);
        const iry = Math.max(ry - d, 1);
        const sweep = sx * sy > 0 ? 1 : 0;
        const pt = (ex, ey, deg) => {
          const t = (deg * Math.PI) / 180;
          return [C[0] - sx * ex * Math.cos(t), C[1] - sy * ey * Math.sin(t)];
        };
        const o0 = pt(rx, ry, 0);
        const o90 = pt(rx, ry, 90);
        const i0 = pt(irx, iry, 0);
        const i90 = pt(irx, iry, 90);
        const outline =
          `M ${o0[0]} ${o0[1]} A ${rx} ${ry} 0 0 ${sweep} ${o90[0]} ${o90[1]} ` +
          `L ${i90[0]} ${i90[1]} A ${irx} ${iry} 0 0 ${1 - sweep} ${i0[0]} ${i0[1]} Z`;
        const bandOuter0 = pt(rx, ry, 4);
        const bandOuter1 = pt(rx, ry, 86);
        const bandInner0 = pt(rx - d * 0.3, ry - d * 0.3, 86);
        const bandInner1 = pt(rx - d * 0.3, ry - d * 0.3, 4);
        const backBand =
          `M ${bandOuter0[0]} ${bandOuter0[1]} A ${rx} ${ry} 0 0 ${sweep} ${bandOuter1[0]} ${bandOuter1[1]} ` +
          `L ${bandInner0[0]} ${bandInner0[1]} A ${rx - d * 0.3} ${ry - d * 0.3} 0 0 ${1 - sweep} ${bandInner1[0]} ${bandInner1[1]} Z`;
        const seatOuter0 = pt(rx - d * 0.3, ry - d * 0.3, 4);
        const seatOuter1 = pt(rx - d * 0.3, ry - d * 0.3, 86);
        const seat =
          `M ${seatOuter0[0]} ${seatOuter0[1]} A ${rx - d * 0.3} ${ry - d * 0.3} 0 0 ${sweep} ${seatOuter1[0]} ${seatOuter1[1]} ` +
          `L ${i90[0]} ${i90[1]} A ${irx} ${iry} 0 0 ${1 - sweep} ${i0[0]} ${i0[1]} Z`;
        const labelAtArr = pt((rx + irx) / 2, (ry + iry) / 2, 45);
        const labelAt = { x: labelAtArr[0], y: labelAtArr[1] };
        return { kind: "curved", outline, backBand, seat, bbox, handle, secondHandle, labelAt };
      }

      // L: one outline with a square inner turn and rounded outer corners
      const corners = [[0, 0], [hLen, 0], [hLen, d], [d, d], [d, vLen], [0, vLen]].map(([u, v]) => at(u, v));
      const outline = roundedPolygon(corners, [6, 6, 6, 0, 6, 6]);
      // Backrest runs along the FULL outer edge of the long arm (the arm
      // along longAxis), continuing behind the corner — i.e. the horizontal
      // top edge from x0 to x1 when long is horizontal, else the vertical
      // edge from y0 to y1. The short arm gets no backrest.
      const longIsHoriz = p.longAxis === "x";
      const backThick = Math.max(6, d * 0.22);
      const backRect = longIsHoriz
        ? { x0: e.x0, y0: sy > 0 ? e.y0 : e.y1 - backThick, x1: e.x1, y1: sy > 0 ? e.y0 + backThick : e.y1 }
        : { x0: sx > 0 ? e.x0 : e.x1 - backThick, y0: e.y0, x1: sx > 0 ? e.x0 + backThick : e.x1, y1: e.y1 };
      // Arm only at the far end of the long arm, away from the corner.
      const armLen = Math.min(d * 0.9, hLen * 0.22, vLen * 0.22) || d * 0.6;
      const armRect = longIsHoriz
        ? { x0: sx > 0 ? e.x1 - armLen : e.x0, y0: e.y0, x1: sx > 0 ? e.x1 : e.x0 + armLen, y1: e.y0 + d }
        : { x0: e.x0, y0: sy > 0 ? e.y1 - armLen : e.y0, x1: e.x0 + d, y1: sy > 0 ? e.y1 : e.y0 + armLen };
      // Long-arm seat cushions, excluding the backrest thickness and the arm.
      const longSeatStart = longIsHoriz ? (sx > 0 ? e.x0 : armRect.x1) : (sy > 0 ? e.y0 : armRect.y1);
      const longSeatEnd = longIsHoriz ? (sx > 0 ? armRect.x0 : e.x1) : (sy > 0 ? armRect.y0 : e.y1);
      const seatDepthStart = longIsHoriz ? backRect.y1 : backRect.x1;
      const seatDepthEnd = longIsHoriz ? (sy > 0 ? e.y1 : e.y0) : (sx > 0 ? e.x1 : e.x0);
      const seatDepth0 = Math.min(seatDepthStart, seatDepthEnd);
      const seatDepth1 = Math.max(seatDepthStart, seatDepthEnd);
      const n = Math.max(1, Math.round(Math.abs(longSeatEnd - longSeatStart) / Math.max(d, 1)));
      const seatRects = [];
      const span = longSeatEnd - longSeatStart;
      for (let i = 0; i < n; i += 1) {
        const a0 = longSeatStart + (span * i) / n;
        const a1 = longSeatStart + (span * (i + 1)) / n;
        seatRects.push(
          longIsHoriz
            ? { x0: Math.min(a0, a1), y0: seatDepth0, x1: Math.max(a0, a1), y1: seatDepth1 }
            : { x0: seatDepth0, y0: Math.min(a0, a1), x1: seatDepth1, y1: Math.max(a0, a1) }
        );
      }
      // Short arm: one long lounge cushion, no backrest, no outer arm.
      const shortSeat = longIsHoriz
        ? { x0: e.x0, y0: sy > 0 ? e.y0 : e.y1 - vLen, x1: e.x0 + d, y1: sy > 0 ? e.y0 + vLen : e.y1 }
        : { x0: sx > 0 ? e.x0 : e.x1 - hLen, y0: e.y0, x1: sx > 0 ? e.x0 + hLen : e.x1, y1: e.y0 + d };
      const labelAt = {
        x: (backRect.x0 + backRect.x1) / 2,
        y: (backRect.y0 + backRect.y1) / 2,
      };
      return {
        kind: "L", outline, backRect, armRect, seatRects, shortSeat, bbox, handle, secondHandle, labelAt, longIsHoriz,
      };
    }

    const { X, Y, W, H } = pxRect(placement);
    const bbox = { x0: X, y0: Y, x1: X + W, y1: Y + H };

    if (shape === "round") {
      const cx = X + W / 2;
      const cy = Y + H / 2;
      const r = Math.min(W, H) / 2;
      const outline = `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
      return {
        kind: "round",
        outline,
        bbox,
        handle: [cx + r * Math.SQRT1_2, cy + r * Math.SQRT1_2],
        secondHandle: null,
        labelAt: { x: cx, y: cy },
      };
    }

    // rect: back edge is the side opposite the facing direction (per the
    // existing rotation convention — rotation names the wall the back
    // faces, see FACING_VECTOR in placement.js, unchanged here).
    const outline = roundedPolygon([[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]], [6, 6, 6, 6]);
    const frontHandlePos = {
      0: [X + W * 0.25, Y + H],
      180: [X + W * 0.25, Y],
      90: [X + W, Y + H * 0.25],
      270: [X, Y + H * 0.25],
    }[placement.rotation];
    const secondHandle = { pos: frontHandlePos, kind: "depth" };
    return {
      kind: "rect",
      outline,
      bbox,
      rotation: placement.rotation,
      rectXYWH: { X, Y, W, H },
      handle: [X + W, Y + H],
      secondHandle,
      labelAt: { x: X + W / 2, y: Y + H / 2 },
    };
  }

  function renderStraightSofa(block, drawing) {
    const { X, Y, W, H } = drawing.rectXYWH;
    const rotation = drawing.rotation;
    const alongX = rotation % 180 === 0;
    const back = shadeColor(block.color, -0.35);
    const seatFill = shadeColor(block.color, 0.6);
    const seatBorder = shadeColor(block.color, 0.15);
    const arm = shadeColor(block.color, -0.1);

    // Thickness of the backrest strip and the arm caps, as a fraction of
    // the block's own depth/length so it scales with the piece.
    const depthPx = alongX ? H : W;
    const lengthPx = alongX ? W : H;
    const backThick = Math.max(6, depthPx * 0.26);
    const armThick = Math.max(10, Math.min(lengthPx * 0.16, depthPx * 1.1));
    const n = sofaSeatCount(block);

    // Build everything in a "local" frame where length runs along u (0..L)
    // and depth runs along v (0..D), back at v=0, then map to plan XY
    // depending on rotation (back = side opposite FACING_VECTOR, matching
    // the existing per-rotation back-edge mapping used throughout).
    const L = lengthPx;
    const D = depthPx;
    const toXY = {
      0: (u, v) => [X + u, Y + v], // back at top (far wall)
      180: (u, v) => [X + (L - u), Y + (D - v)], // back at bottom (near wall)
      90: (u, v) => [X + v, Y + (L - u)], // back at left wall
      270: (u, v) => [X + (D - v), Y + u], // back at right wall
    }[rotation];
    const rect = (u0, v0, u1, v1) => {
      const [x0, y0] = toXY(u0, v0);
      const [x1, y1] = toXY(u1, v1);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    };

    const parts = [];
    // Backrest strip along the full back edge.
    parts.push({ r: rect(0, 0, L, backThick), fill: back, stroke: back, label: `${n} SEATER` });
    // Arms at both short ends, full depth.
    parts.push({ r: rect(0, 0, armThick, D), fill: arm, stroke: arm });
    parts.push({ r: rect(L - armThick, 0, L, D), fill: arm, stroke: arm });
    // n seat cushions between the arms.
    const seatStart = armThick;
    const seatEnd = L - armThick;
    const seatSpan = Math.max(seatEnd - seatStart, 1);
    for (let i = 0; i < n; i += 1) {
      const u0 = seatStart + (seatSpan * i) / n + 1.5;
      const u1 = seatStart + (seatSpan * (i + 1)) / n - 1.5;
      parts.push({ r: rect(u0, backThick, u1, D - 2), fill: seatFill, stroke: seatBorder, isSeat: true });
    }

    const labelXY = toXY(L / 2, backThick / 2);
    const labelRotated = rotation === 90 || rotation === 270;

    return (
      <>
        {parts.map((part, i) => (
          <rect
            key={i}
            x={part.r.x} y={part.r.y} width={Math.max(part.r.w, 0)} height={Math.max(part.r.h, 0)}
            fill={part.fill} stroke={part.stroke} strokeWidth={part.isSeat ? 1 : 0.5} rx="5"
          />
        ))}
        <text
          x={labelXY[0]} y={labelXY[1] + 3}
          transform={labelRotated ? `rotate(-90 ${labelXY[0]} ${labelXY[1]})` : undefined}
          className="fp-sofa-label" textAnchor="middle"
        >
          {n} SEATER
        </text>
      </>
    );
  }

  function renderDiningTable(drawing) {
    return <path d={drawing.outline} fill={WOOD_FILL} stroke={WOOD_BORDER} strokeWidth="2" strokeLinejoin="round" />;
  }

  function renderBed(block, drawing) {
    const { X, Y, W, H } = drawing.rectXYWH;
    const rotation = drawing.rotation;
    const alongX = rotation % 180 === 0;
    const depthPx = alongX ? H : W;
    const lengthPx = alongX ? W : H;
    const headThick = Math.max(10, depthPx * 0.16);
    const L = lengthPx;
    const D = depthPx;
    const toXY = {
      0: (u, v) => [X + u, Y + v],
      180: (u, v) => [X + (L - u), Y + (D - v)],
      90: (u, v) => [X + v, Y + (L - u)],
      270: (u, v) => [X + (D - v), Y + u],
    }[rotation];
    const rect = (u0, v0, u1, v1) => {
      const [x0, y0] = toXY(u0, v0);
      const [x1, y1] = toXY(u1, v1);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    };
    const head = rect(0, 0, L, headThick);
    const pillowW = L * 0.28;
    const pillowH = headThick * 0.8;
    const pillow1 = rect(L * 0.12, headThick * 0.1, L * 0.12 + pillowW, headThick * 0.1 + pillowH);
    const pillow2 = rect(L * 0.6, headThick * 0.1, L * 0.6 + pillowW, headThick * 0.1 + pillowH);
    const headColor = shadeColor(block.color, -0.35);
    const labelXY = toXY(L / 2, headThick / 2);
    const labelRotated = rotation === 90 || rotation === 270;

    return (
      <>
        <rect x={head.x} y={head.y} width={head.w} height={head.h} fill={headColor} stroke={headColor} rx="4" />
        <rect x={pillow1.x} y={pillow1.y} width={pillow1.w} height={pillow1.h} fill="#fff" fillOpacity="0.85" stroke={shadeColor(block.color, 0.15)} rx="4" />
        <rect x={pillow2.x} y={pillow2.y} width={pillow2.w} height={pillow2.h} fill="#fff" fillOpacity="0.85" stroke={shadeColor(block.color, 0.15)} rx="4" />
        <text
          x={labelXY[0]} y={labelXY[1] + 3}
          transform={labelRotated ? `rotate(-90 ${labelXY[0]} ${labelXY[1]})` : undefined}
          className="fp-sofa-label" textAnchor="middle"
        >
          BED
        </text>
      </>
    );
  }

  function renderArmShape(block, drawing) {
    const back = shadeColor(block.color, -0.35);
    const seatFill = shadeColor(block.color, 0.6);
    const seatBorder = shadeColor(block.color, 0.15);
    const arm = shadeColor(block.color, -0.1);

    if (drawing.kind === "curved") {
      return (
        <>
          <path d={drawing.outline} fill={seatFill} stroke={seatBorder} strokeWidth="1" />
          <path d={drawing.backBand} fill={back} stroke={back} />
          <text x={drawing.labelAt.x} y={drawing.labelAt.y + 3} className="fp-sofa-label" textAnchor="middle">
            CURVED
          </text>
        </>
      );
    }

    // L shape
    const { backRect, armRect, seatRects, shortSeat, longIsHoriz } = drawing;
    const toRect = (r) => ({ x: Math.min(r.x0, r.x1), y: Math.min(r.y0, r.y1), w: Math.abs(r.x1 - r.x0), h: Math.abs(r.y1 - r.y0) });
    const br = toRect(backRect);
    const ar = toRect(armRect);
    const sr = toRect(shortSeat);
    const labelRotated = !longIsHoriz;
    return (
      <>
        <path d={drawing.outline} fill={seatFill} fillOpacity="0.5" stroke={seatBorder} strokeWidth="1" strokeLinejoin="round" />
        {seatRects.map((r, i) => {
          const rr = toRect(r);
          return <rect key={i} x={rr.x + 1.5} y={rr.y + 1.5} width={Math.max(rr.w - 3, 0)} height={Math.max(rr.h - 3, 0)} fill={seatFill} stroke={seatBorder} rx="5" />;
        })}
        <rect x={sr.x + 1.5} y={sr.y + 1.5} width={Math.max(sr.w - 3, 0)} height={Math.max(sr.h - 3, 0)} fill={seatFill} stroke={seatBorder} rx="5" />
        <rect x={ar.x} y={ar.y} width={ar.w} height={ar.h} fill={arm} stroke={arm} rx="5" />
        <rect x={br.x} y={br.y} width={br.w} height={br.h} fill={back} stroke={back} rx="5" />
        <text
          x={drawing.labelAt.x} y={drawing.labelAt.y + 3}
          transform={labelRotated ? `rotate(-90 ${drawing.labelAt.x} ${drawing.labelAt.y})` : undefined}
          className="fp-sofa-label" textAnchor="middle"
        >
          L-SHAPE
        </text>
      </>
    );
  }

  function renderBlock(block, drawing) {
    let body;
    if (ARM_SHAPES.has(block.shape)) {
      body = renderArmShape(block, drawing);
    } else if (isStraightSofa(block)) {
      body = (
        <>
          <path d={drawing.outline} fill={block.color} fillOpacity="0.12" stroke={block.color} strokeWidth="1" />
          {renderStraightSofa(block, drawing)}
        </>
      );
    } else if (isDiningTable(block)) {
      body = renderDiningTable(drawing);
    } else if (isBed(block)) {
      body = (
        <>
          <path d={drawing.outline} fill={block.color} fillOpacity="0.18" stroke={block.color} strokeWidth="1" />
          {renderBed(block, drawing)}
        </>
      );
    } else {
      body = <path d={drawing.outline} fill={block.color} fillOpacity="0.28" stroke={block.color} strokeWidth="1.5" strokeLinejoin="round" />;
    }

    const { bbox } = drawing;
    return (
      <g {...dragHandlers(block, "move")} style={readOnly ? undefined : { touchAction: "none", cursor: "grab" }}>
        {/* Hit area = full piece + 6px margin, so a tap near the edge still
           selects/drags it rather than falling through to the plan. */}
        <rect
          x={bbox.x0 - 6} y={bbox.y0 - 6}
          width={bbox.x1 - bbox.x0 + 12} height={bbox.y1 - bbox.y0 + 12}
          className="fp-hit"
        />
        {body}
        <text x={drawing.labelAt.x} y={drawing.labelAt.y + 4} className="fp-block-number" textAnchor="middle">
          {block.number}
        </text>
      </g>
    );
  }

  function renderResizeHandles(block, drawing) {
    const { handle, secondHandle } = drawing;
    return (
      <g key={`${block.key}-handles`}>
        <g {...dragHandlers(block, "resize")} style={{ touchAction: "none", cursor: "nwse-resize" }}>
          <circle cx={handle[0]} cy={handle[1]} r="22" className="fp-hit" />
          <circle cx={handle[0]} cy={handle[1]} r="11" className="fp-resize-handle" />
        </g>
        <text x={handle[0] + 14} y={handle[1] + 16} className="fp-size-label">
          {formatFeet(block.widthFt)} ft
        </text>
        {secondHandle ? (
          <g>
            <g
              {...dragHandlers(block, secondHandle.kind === "short" ? "resize-short" : "resize-depth")}
              style={{ touchAction: "none", cursor: "nwse-resize" }}
            >
              <circle cx={secondHandle.pos[0]} cy={secondHandle.pos[1]} r="22" className="fp-hit" />
              <circle cx={secondHandle.pos[0]} cy={secondHandle.pos[1]} r="11" className="fp-resize-handle" />
            </g>
            <text x={secondHandle.pos[0] + 14} y={secondHandle.pos[1] + 16} className="fp-size-label">
              {secondHandle.kind === "short"
                ? formatFeet(Math.round(armParams(block.placement, feet).shortFt * 2) / 2)
                : formatFeet(
                    Math.round(
                      (block.placement.rotation % 180 === 0
                        ? block.placement.h * feet.hFt
                        : block.placement.w * feet.wFt) * 2
                    ) / 2
                  )}{" "}
              ft
            </text>
          </g>
        ) : null}
      </g>
    );
  }

  const legendTypes = presentFeatureTypes(layout);

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${geom.planW} ${geom.planH}`}
        className="floor-plan-svg"
        style={{ aspectRatio: `${geom.planW} / ${geom.planH}` }}
        onPointerUp={readOnly ? undefined : handleBackgroundPointerUp}
      >
        <rect x={geom.roomX} y={geom.roomY} width={geom.roomW} height={geom.roomH} className="fp-floor" />
        {WALLS.map((wall) => (
          <g key={wall}>{renderWallFeatures(wall)}</g>
        ))}
        {renderObstructions()}
        {renderCamera()}

        {blocks
          .filter((b) => b.placement)
          .map((block) => {
            const selected = block.key === selectedKey;
            const warning = blockOverlapWarning(block);
            const drawing = blockDrawing(block);
            return (
              <g key={block.key} opacity={pendingKey && !selected ? 0.55 : 1}>
                {renderBlock(block, drawing)}
                {warning ? (
                  <>
                    {placementRects(block.shape, block.placement).map((rect, i) => {
                      const { X, Y, W, H } = pxRect(rect);
                      return <rect key={i} x={X - 2} y={Y - 2} width={W + 4} height={H + 4} className="fp-warning-outline" />;
                    })}
                    <text x={drawing.bbox.x0} y={drawing.bbox.y0 - 6} className="fp-warning-label">
                      Overlaps {warning}
                    </text>
                  </>
                ) : null}
                {selected ? (
                  <rect
                    x={drawing.bbox.x0 - 6} y={drawing.bbox.y0 - 6}
                    width={drawing.bbox.x1 - drawing.bbox.x0 + 12} height={drawing.bbox.y1 - drawing.bbox.y0 + 12}
                    fill="none" stroke={block.color} strokeWidth="1.5" strokeDasharray="4 3" rx="6"
                    pointerEvents="none"
                  />
                ) : null}
                {!readOnly && selected ? renderResizeHandles(block, drawing) : null}
              </g>
            );
          })}
      </svg>
      <div className="fp-legend">
        {legendTypes.map((t) => {
          const color = featureColor(t);
          return (
            <span className="fp-legend-item" key={t}>
              <span className="fp-legend-swatch" style={{ background: color.fill, borderColor: color.border }} />
              {t}
            </span>
          );
        })}
        <span className="fp-legend-item">Backrest = back of the sofa</span>
        <span className="fp-legend-item">
          <span className="fp-legend-dot" /> Blue dots = drag to resize
        </span>
      </div>
    </>
  );
}

/** Closed polygon path with each corner rounded by its own radius (0 keeps
 * it square), each radius capped at half the shorter adjoining edge. */
function roundedPolygon(points, radii) {
  const n = points.length;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const [x, y] = points[i];
    const [px, py] = points[(i - 1 + n) % n];
    const [nx, ny] = points[(i + 1) % n];
    const inLen = Math.hypot(x - px, y - py) || 1;
    const outLen = Math.hypot(nx - x, ny - y) || 1;
    const r = Math.min(radii[i] || 0, inLen / 2, outLen / 2);
    const a = [x + ((px - x) / inLen) * r, y + ((py - y) / inLen) * r];
    const b = [x + ((nx - x) / outLen) * r, y + ((ny - y) / outLen) * r];
    d += `${i === 0 ? "M" : "L"} ${a[0]} ${a[1]} Q ${x} ${y} ${b[0]} ${b[1]} `;
  }
  return `${d}Z`;
}

function formatFeet(ft) {
  return Number.isInteger(ft) ? String(ft) : ft.toFixed(1);
}
