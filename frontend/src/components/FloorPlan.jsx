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
  armFrame,
  armParams,
  assignLabelRows,
  cameraGeometry,
  cameraXFraction,
  clamp01,
  curvedFigure,
  featureColor,
  featureFootprint,
  featureSpan,
  frameApply,
  frameCss,
  frameSize,
  isBed,
  isChair,
  isDiningTable,
  isStraightSofa,
  lFigure,
  labelPosition,
  mergeAdjacentFeatures,
  nameLines,
  placementRects,
  planGeometry,
  rectFrame,
  rectsOverlap,
  roomFeet,
  rotateBy,
  rotateSteps,
  shadeColor,
  sofaName,
  sofaSeatCount,
  straightFigure,
  translatePlacement,
} from "../placement.js";

const WALLS = ["far", "left", "right", "near"];

// Wall names and the colour of each wall line on the plan.
const WALL_NAMES = { far: "FAR WALL", left: "LEFT WALL", right: "RIGHT WALL", near: "NEAR WALL" };
const WALL_COLORS = { far: "#1D4ED8", left: "#6D28D9", right: "#15803D", near: "#1A1815" };
const WALL_NAME_CHAR_PX = 8.6; // rough width of one 13px bold capital, for placing the name clear of feature labels

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

/** Far/left/right walls are drawn thick in their own colour; the near wall
 * keeps the plain ink line. */
function wallStyle(wall) {
  return wall === "near" ? undefined : { stroke: WALL_COLORS[wall], strokeWidth: 6 };
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
  onRotateBlock = noop,
  onDropPendingAt = noop,
  pendingKey = null,
  addObstructionMode = false,
  onAddObstructionAt = noop,
  onTapFeature = noop,
  onTapObstruction = noop,
  readOnly = false,
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null); // { mode: "move"|"resize"|"rotate", key, pointerId, startX, startY, orig, moved, ... }

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

  /** Pointer position in plan pixels (the svg keeps its aspect, so angles
   * measured here are true angles). */
  function toPlanPx(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * geom.planW,
      y: ((clientY - rect.top) / rect.height) * geom.planH,
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
    if (mode === "rotate") {
      // angle of the pointer about the piece centre, compared on every move
      const { bbox } = blockDrawing(block);
      const centre = { x: (bbox.x0 + bbox.x1) / 2, y: (bbox.y0 + bbox.y1) / 2 };
      const pp = toPlanPx(e.clientX, e.clientY);
      Object.assign(dragRef.current, {
        centre,
        angle0: Math.atan2(pp.y - centre.y, pp.x - centre.x),
        clientX: e.clientX,
        clientY: e.clientY,
        steps: 0,
      });
    }
    onSelectBlock(block.key);
  }

  function moveDrag(e, block) {
    const drag = dragRef.current;
    if (!drag || drag.key !== block.key || drag.pointerId !== e.pointerId) return;
    if (drag.mode === "rotate") {
      // a few pixels of jitter is still a tap
      if (!drag.moved && Math.hypot(e.clientX - drag.clientX, e.clientY - drag.clientY) < 6) return;
      drag.moved = true;
      const pp = toPlanPx(e.clientX, e.clientY);
      const steps = rotateSteps(Math.atan2(pp.y - drag.centre.y, pp.x - drag.centre.x), drag.angle0);
      if (steps !== drag.steps) {
        drag.steps = steps;
        onMoveBlock(block.key, rotateBy(block.shape, drag.orig, feet, steps));
      }
      return;
    }
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
    if (drag.mode === "rotate") {
      if (!drag.moved) {
        if (e.type !== "pointercancel") onRotateBlock(block.key); // a plain tap turns it 90 degrees once
      } else {
        onCommitBlock(block.key, block.placement); // saved ONCE, on release
      }
      return;
    }
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
        elements.push(<line key={`${key}-pre`} {...segmentBetween(line, cursor, start, geom)} className="fp-wall" style={wallStyle(wall)} />);
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

    elements.push(<line key={`${wall}-tail`} {...segmentBetween(line, cursor, 1, geom)} className="fp-wall" style={wallStyle(wall)} />);
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
      // The figure is built in a local frame (origin = outer bend corner, u
      // along the long arm, back at v = 0) and placed with this one matrix.
      return {
        kind: shape === "curved" ? "curved" : "L",
        frame: armFrame(p),
        longPx: p.longFt,
        shortPx: p.shortFt,
        depthPx: d,
        bbox,
        handle,
        secondHandle,
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

  /** A rounded "pill" (hand-rest or back cushion) from a local u/v box. */
  function pill(r, key, props) {
    const w = r.u1 - r.u0;
    const h = r.v1 - r.v0;
    return <rect key={key} x={r.u0} y={r.v0} width={Math.max(w, 0)} height={Math.max(h, 0)} rx={Math.max(Math.min(w, h) / 2, 0)} {...props} />;
  }

  /** The seat name, written ON the seat and drawn outside the rotated
   * group so it stays upright. Two lines when the seat is narrow + tall. */
  function seatName(text, frame, r, color, key) {
    const c = frameApply(frame, (r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
    const [w, h] = frameSize(frame, r.u1 - r.u0, r.v1 - r.v0);
    const lines = nameLines(text, w, h);
    return (
      <text key={key} x={c[0]} y={c[1]} className="fp-fig-name" textAnchor="middle" dominantBaseline="central" fill={shadeColor(color, -0.5)}>
        {lines.map((line, i) => (
          <tspan key={i} x={c[0]} dy={i === 0 ? (lines.length > 1 ? "-0.55em" : 0) : "1.1em"}>
            {line}
          </tspan>
        ))}
      </text>
    );
  }

  /** Small white number badge on the piece's corner, clear of the name. */
  function numberBadge(block, bbox) {
    const cx = bbox.x1 - 8;
    const cy = bbox.y0 + 8;
    return (
      <g pointerEvents="none">
        <circle cx={cx} cy={cy} r="7.5" fill="#fff" stroke={block.color} strokeWidth="2" />
        <text x={cx} y={cy} className="fp-badge-num" textAnchor="middle" dominantBaseline="central" fill={block.color}>
          {block.number}
        </text>
      </g>
    );
  }

  /** Sofa / chair / L / curved: one local-frame figure placed with ONE
   * transform, its names drawn on top, upright, and a number badge. */
  function renderFigure(block, drawing) {
    const color = block.color;
    const seatFill = shadeColor(color, 0.82);
    const seatBorder = shadeColor(color, 0.05);
    const seatShape = (fig, key) => (
      <path key={key} d={roundedPolygon(fig.seatPoints, fig.seatRadii)} fill={seatFill} stroke={seatBorder} strokeWidth="1.5" strokeLinejoin="round" />
    );
    const handRests = (fig) => fig.handRests.map((r, i) => pill(r, `h${i}`, { fill: color, fillOpacity: 0.7 }));
    const backPills = (fig) => fig.backPills.map((r, i) => pill(r, `b${i}`, { fill: color }));
    let frame;
    let group;
    let names;

    if (drawing.kind === "curved") {
      frame = drawing.frame;
      const fig = curvedFigure(drawing.longPx, drawing.shortPx, drawing.depthPx);
      group = (
        <>
          <path d={fig.seat.d} fill={seatFill} stroke={seatBorder} strokeWidth={fig.seat.r * 2 + 3} strokeLinejoin="round" />
          <path d={fig.seat.d} fill={seatFill} stroke={seatFill} strokeWidth={fig.seat.r * 2} strokeLinejoin="round" />
          <path
            d={fig.back.d} fill="none" stroke={color} strokeWidth={fig.back.width} strokeLinecap="round"
            strokeDasharray={`${fig.back.dash} ${fig.back.gap}`} strokeDashoffset={fig.back.offset}
          />
          {handRests(fig)}
        </>
      );
      names = seatName("CURVED", frame, { u0: fig.label.u - fig.label.w / 2, u1: fig.label.u + fig.label.w / 2, v0: fig.label.v - fig.label.h / 2, v1: fig.label.v + fig.label.h / 2 }, color, "n");
    } else if (drawing.kind === "L") {
      frame = drawing.frame;
      const fig = lFigure(drawing.longPx, drawing.shortPx, drawing.depthPx);
      group = (
        <>
          {seatShape(fig, "seat")}
          {backPills(fig)}
          {handRests(fig)}
        </>
      );
      names = (
        <>
          {seatName("L-SHAPE", frame, fig.labelLong, color, "n1")}
          {seatName("LOUNGE", frame, fig.labelLounge, color, "n2")}
        </>
      );
    } else {
      const { X, Y, W, H } = drawing.rectXYWH;
      const alongX = drawing.rotation % 180 === 0;
      const L = alongX ? W : H;
      const D = alongX ? H : W;
      frame = rectFrame(X, Y, L, D, drawing.rotation);
      const chair = isChair(block);
      const fig = straightFigure(L, D, chair ? 1 : sofaSeatCount(block));
      group = (
        <>
          {seatShape(fig, "seat")}
          {backPills(fig)}
          {handRests(fig)}
        </>
      );
      names = seatName(chair ? "CHAIR" : sofaName(sofaSeatCount(block)), frame, fig.label, color, "n");
    }

    return (
      <>
        <g transform={frameCss(frame)}>{group}</g>
        {names}
        {numberBadge(block, drawing.bbox)}
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

  function renderBlock(block, drawing) {
    const figure = ARM_SHAPES.has(block.shape) || isStraightSofa(block) || isChair(block);
    let body;
    if (figure) {
      body = renderFigure(block, drawing);
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
        {figure ? null : (
          <text x={drawing.labelAt.x} y={drawing.labelAt.y + 4} className="fp-block-number" textAnchor="middle">
            {block.number}
          </text>
        )}
      </g>
    );
  }

  /** "FAR WALL" etc. in the wall's own colour, sitting in the label margin
   * at a spot that keeps clear of that wall's feature labels. Side walls
   * read vertically; the near wall's name sits beside the camera. */
  function renderWallName(wall) {
    const color = WALL_COLORS[wall];
    const text = WALL_NAMES[wall];
    const { roomX, roomY, roomW, roomH } = geom;
    const common = { className: "fp-wall-name", fill: color, textAnchor: "middle", dominantBaseline: "central" };

    if (wall === "near") {
      const camX = roomX + cameraXFraction(layout?.camera_position) * roomW;
      const toRight = camX < roomX + roomW * 0.65;
      return (
        <text key={wall} {...common} textAnchor={toRight ? "start" : "end"} x={camX + (toRight ? 24 : -24)} y={roomY + roomH + 24}>
          {text}
        </text>
      );
    }

    // along-the-wall pixel centres of the existing feature labels, so the
    // wall name can take the first free slot
    const isFarWall = wall === "far";
    const along = isFarWall ? roomW : roomH;
    const origin = isFarWall ? roomX : roomY;
    const nameLen = text.length * WALL_NAME_CHAR_PX;
    const groups = mergeAdjacentFeatures(layout?.[WALL_KEY[wall]]?.features || []);
    const rows = assignLabelRows(groups, geom, wall);
    const taken = groups.map((group, i) => {
      const mid = origin + ((group.span[0] + group.span[1]) / 2) * along + (isFarWall ? 0 : rows[i] * 12);
      return { mid, half: (featureLabel(group).length * 5.4) / 2 + 6 };
    });
    const free = (centre) => taken.every((t) => Math.abs(centre - t.mid) > t.half + nameLen / 2);
    const candidates = [0.5, 0.3, 0.7, 0.15, 0.85].map((t) => origin + Math.min(Math.max(t * along, nameLen / 2 + 4), along - nameLen / 2 - 4));
    const centre = candidates.find(free) ?? candidates[0];

    if (isFarWall) {
      return (
        <text key={wall} {...common} x={centre} y={roomY - 12}>
          {text}
        </text>
      );
    }
    const x = wall === "left" ? roomX - 12 : roomX + roomW + 12;
    return (
      <text key={wall} {...common} transform={`translate(${x} ${centre}) rotate(${wall === "left" ? -90 : 90})`}>
        {text}
      </text>
    );
  }

  /** Blue rotate handle at the selected piece's bottom-left corner: drag
   * about the piece to turn it in 90-degree steps; a tap turns it once. */
  function renderRotateHandle(block, drawing) {
    const { bbox } = drawing;
    const r = 16;
    const cx = Math.min(Math.max(bbox.x0 - 20, r + 2), geom.planW - r - 2);
    const cy = Math.min(Math.max(bbox.y1 + 20, r + 2), geom.planH - r - 18);
    return (
      <g key={`${block.key}-rotate`}>
        <line x1={bbox.x0} y1={bbox.y1} x2={cx} y2={cy} className="fp-rotate-link" />
        <g {...dragHandlers(block, "rotate")} style={{ touchAction: "none", cursor: "grab" }}>
          <circle cx={cx} cy={cy} r="24" className="fp-hit" />
          <circle cx={cx} cy={cy} r={r} className="fp-rotate-handle" />
          <g transform={`translate(${cx - 10} ${cy - 10}) scale(0.8333)`} className="fp-rotate-icon">
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </g>
        </g>
        <text x={cx} y={cy + r + 12} className="fp-rotate-label" textAnchor="middle">
          drag to rotate
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
        {WALLS.map((wall) => renderWallName(wall))}
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
                {!readOnly && selected && block.placement ? renderRotateHandle(block, drawing) : null}
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
