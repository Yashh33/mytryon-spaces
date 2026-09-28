import { useRef } from "react";
import {
  ARC_TYPES,
  ARM_SHAPES,
  BAND_TYPES,
  DASHED_GAP_TYPES,
  DOUBLE_DASHED_GAP_TYPES,
  FACING_VECTOR,
  GAP_TYPES,
  POINT_TYPES,
  UNKNOWN_TYPES,
  WALL_KEY,
  WINDOW_TYPES,
  armExtent,
  armParams,
  assignLabelRows,
  cameraGeometry,
  clamp01,
  featureFootprint,
  featureSpan,
  labelPosition,
  mergeAdjacentFeatures,
  placementRects,
  planGeometry,
  rectsOverlap,
  roomFeet,
  translatePlacement,
} from "../placement.js";

const WALLS = ["far", "left", "right", "near"];

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
function parallelLines(a, b, dashed) {
  const off1 = { x: a.nx * -2, y: a.ny * -2 };
  const off2 = { x: a.nx * 2, y: a.ny * 2 };
  const cls = "fp-window" + (dashed ? " fp-dashed" : "");
  return (
    <>
      <line x1={a.x + off1.x} y1={a.y + off1.y} x2={b.x + off1.x} y2={b.y + off1.y} className={cls} />
      <line x1={a.x + off2.x} y1={a.y + off2.y} x2={b.x + off2.x} y2={b.y + off2.y} className={cls} />
    </>
  );
}

function featureLabel(group) {
  if ((group.type === "unknown" || group.type === "other") && group.notes) return group.notes;
  return group.type || "feature";
}

const noop = () => {};

export function FloorPlan({
  room,
  blocks = [],
  selectedKey = null,
  onSelectBlock = noop,
  onMoveBlock = noop,
  onCommitBlock = noop,
  onRotateBlock = noop,
  onFlipBlock = noop,
  onResizeBlock = noop,
  onCommitResize = noop,
  onRemoveBlock = noop,
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

      if (GAP_TYPES.has(type)) {
        elements.push(<line key={`${key}-pre`} {...segmentBetween(line, cursor, start, geom)} className="fp-wall" />);
        cursor = end;
        if (WINDOW_TYPES.has(type)) {
          elements.push(<g key={`${key}-sym`}>{parallelLines(a, b, false)}</g>);
        } else if (DOUBLE_DASHED_GAP_TYPES.has(type)) {
          elements.push(<g key={`${key}-sym`}>{parallelLines(a, b, true)}</g>);
        } else if (DASHED_GAP_TYPES.has(type)) {
          elements.push(<line key={`${key}-d1`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="fp-wall fp-dashed" />);
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
            />
          );
        }
        if (UNKNOWN_TYPES.has(type)) {
          elements.push(
            <text key={`${key}-q`} x={mid.x + mid.nx * 11} y={mid.y + mid.ny * 11 + 3} className="fp-unknown-mark" textAnchor="middle">
              ?
            </text>
          );
        }
      } else if (BAND_TYPES.has(type)) {
        elements.push(
          <line
            key={key}
            x1={a.x + a.nx * 5} y1={a.y + a.ny * 5}
            x2={b.x + a.nx * 5} y2={b.y + a.ny * 5}
            className="fp-band"
          />
        );
      } else if (POINT_TYPES.has(type)) {
        elements.push(<rect key={key} x={mid.x + mid.nx * 8 - 5} y={mid.y + mid.ny * 8 - 5} width="10" height="10" className="fp-pillar" />);
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
        <text key={`${key}-label`} x={label.x} y={label.y} className="fp-label" textAnchor={label.anchor}>
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
        return (
          <g key={`obstruction-${index}`}>
            <rect x={px - 6} y={py - 6} width="12" height="12" className="fp-pillar" />
            <text x={px} y={py - 12} className="fp-label" textAnchor="middle">
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
   * its outline, back markings, facing arrows, bounding box and where the
   * resize handle sits. */
  function blockDrawing(block) {
    const { shape, placement } = block;

    if (ARM_SHAPES.has(shape)) {
      const { p, e } = pxArms(placement);
      const { sx, sy, hLen, vLen } = e;
      const d = p.depthFt; // plan pixels here, despite the name
      const at = (u, v) => [p.bx + sx * u, p.by + sy * v];
      const bbox = { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
      const handle = p.longAxis === "x" ? at(hLen, d) : at(d, vLen);

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
        const b0 = pt(rx - 3, ry - 3, 6);
        const b1 = pt(rx - 3, ry - 3, 84);
        const back = [`M ${b0[0]} ${b0[1]} A ${rx - 3} ${ry - 3} 0 0 ${sweep} ${b1[0]} ${b1[1]}`];
        const front = pt(irx, iry, 45);
        const len = Math.hypot(C[0] - front[0], C[1] - front[1]) || 1;
        const arrows = [{ x: front[0], y: front[1], dx: (C[0] - front[0]) / len, dy: (C[1] - front[1]) / len }];
        const labelAt = pt((rx + irx) / 2, (ry + iry) / 2, 45);
        const secondHandle = { pos: p.longAxis === "x" ? at(d, vLen) : at(hLen, d), kind: "short" };
        return { outline, back, arrows, bbox, handle, secondHandle, labelAt };
      }

      // L: one outline with a square inner turn and rounded outer corners
      const corners = [[0, 0], [hLen, 0], [hLen, d], [d, d], [d, vLen], [0, vLen]].map(([u, v]) => at(u, v));
      const outline = roundedPolygon(corners, [6, 6, 6, 0, 6, 6]);
      const hb0 = at(6, 3);
      const hb1 = at(hLen - 6, 3);
      const vb0 = at(3, 6);
      const vb1 = at(3, vLen - 6);
      const back = [`M ${hb0[0]} ${hb0[1]} L ${hb1[0]} ${hb1[1]}`, `M ${vb0[0]} ${vb0[1]} L ${vb1[0]} ${vb1[1]}`];
      const hFront = at((d + hLen) / 2, d);
      const vFront = at(d, (d + vLen) / 2);
      const arrows = [
        { x: hFront[0], y: hFront[1], dx: 0, dy: sy },
        { x: vFront[0], y: vFront[1], dx: sx, dy: 0 },
      ];
      const secondHandle = { pos: p.longAxis === "x" ? at(d, vLen) : at(hLen, d), kind: "short" };
      return { outline, back, arrows, bbox, handle, secondHandle, labelAt: at(d / 2, d / 2) };
    }

    const { X, Y, W, H } = pxRect(placement);
    const [fx, fy] = FACING_VECTOR[placement.rotation];
    const bbox = { x0: X, y0: Y, x1: X + W, y1: Y + H };

    if (shape === "round") {
      const cx = X + W / 2;
      const cy = Y + H / 2;
      const r = Math.min(W, H) / 2;
      const outline = `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
      const backAngle = Math.atan2(-fy, -fx);
      const br = Math.max(r - 3, 1);
      const a0 = backAngle - Math.PI / 4;
      const a1 = backAngle + Math.PI / 4;
      const back = [
        `M ${cx + br * Math.cos(a0)} ${cy + br * Math.sin(a0)} A ${br} ${br} 0 0 1 ${cx + br * Math.cos(a1)} ${cy + br * Math.sin(a1)}`,
      ];
      const arrows = [{ x: cx + fx * r, y: cy + fy * r, dx: fx, dy: fy }];
      return {
        outline, back, arrows, bbox,
        handle: [cx + r * Math.SQRT1_2, cy + r * Math.SQRT1_2],
        secondHandle: null,
        labelAt: [cx, cy],
      };
    }

    // rect: back edge is the side opposite the facing direction
    const outline = roundedPolygon([[X, Y], [X + W, Y], [X + W, Y + H], [X, Y + H]], [6, 6, 6, 6]);
    const inset = 3;
    const backLine = {
      0: [X + 6, Y + inset, X + W - 6, Y + inset],
      180: [X + 6, Y + H - inset, X + W - 6, Y + H - inset],
      90: [X + inset, Y + 6, X + inset, Y + H - 6],
      270: [X + W - inset, Y + 6, X + W - inset, Y + H - 6],
    }[placement.rotation];
    const back = [`M ${backLine[0]} ${backLine[1]} L ${backLine[2]} ${backLine[3]}`];
    const frontCentre = [X + W / 2 + (fx * W) / 2, Y + H / 2 + (fy * H) / 2];
    const arrows = [{ x: frontCentre[0], y: frontCentre[1], dx: fx, dy: fy }];
    const frontHandlePos = {
      0: [X + W * 0.25, Y + H],
      180: [X + W * 0.25, Y],
      90: [X + W, Y + H * 0.25],
      270: [X, Y + H * 0.25],
    }[placement.rotation];
    const secondHandle = { pos: frontHandlePos, kind: "depth" };
    return { outline, back, arrows, bbox, handle: [X + W, Y + H], secondHandle, labelAt: [X + W / 2, Y + H / 2] };
  }

  function renderBlock(block, selected, drawing) {
    const { outline, back, arrows, labelAt } = drawing;
    return (
      <g {...dragHandlers(block, "move")} style={readOnly ? undefined : { touchAction: "none", cursor: "grab" }}>
        <path d={outline} fill={block.color} fillOpacity="0.28" stroke={block.color} strokeWidth={selected ? 2.5 : 1.5} strokeLinejoin="round" />
        {back.map((d, i) => (
          <path key={`back-${i}`} d={d} className="fp-block-back" stroke={block.color} />
        ))}
        {arrows.map((a, i) => (
          <FacingArrow key={`arrow-${i}`} {...a} color={block.color} />
        ))}
        <text x={labelAt[0]} y={labelAt[1] + 4} className="fp-block-number" textAnchor="middle">
          {block.number}
        </text>
      </g>
    );
  }

  function renderSelectedControls(block, drawing) {
    const { bbox, handle, secondHandle } = drawing;
    const buttons = [
      { key: "remove", cls: "fp-remove-handle", icon: "×", onTap: () => onRemoveBlock(block.key) },
      { key: "rotate", cls: "fp-rotate-handle", icon: "↻", onTap: () => onRotateBlock(block.key) },
    ];
    if (ARM_SHAPES.has(block.shape)) {
      buttons.push({ key: "flip", cls: "fp-flip-handle", icon: "⇔", onTap: () => onFlipBlock(block.key) });
    }
    const spacing = 26;
    const rowWidth = (buttons.length - 1) * spacing;
    const centreX = Math.min(Math.max((bbox.x0 + bbox.x1) / 2, 12 + rowWidth / 2), geom.planW - 12 - rowWidth / 2);
    const rowY = Math.max(bbox.y0 - 16, 12);
    const stop = (e) => e.stopPropagation();

    return (
      <g key={`${block.key}-controls`}>
        {buttons.map((b, i) => {
          const cx = centreX - rowWidth / 2 + i * spacing;
          return (
            <g key={b.key}>
              <circle
                cx={cx} cy={rowY} r="11" className={`fp-handle ${b.cls}`}
                onPointerDown={stop}
                onPointerUp={(e) => {
                  e.stopPropagation();
                  b.onTap();
                }}
              />
              <text x={cx} y={rowY + 4} textAnchor="middle" className="fp-handle-icon">
                {b.icon}
              </text>
            </g>
          );
        })}
        <g {...dragHandlers(block, "resize")} style={{ touchAction: "none", cursor: "nwse-resize" }}>
          <circle cx={handle[0]} cy={handle[1]} r="14" className="fp-hit" />
          <circle cx={handle[0]} cy={handle[1]} r="6.5" fill={block.color} className="fp-resize-handle" />
        </g>
        <text x={handle[0] + 10} y={handle[1] + 16} className="fp-size-label">
          {formatFeet(block.widthFt)} ft
        </text>
        {secondHandle ? (
          <g>
            <g
              {...dragHandlers(block, secondHandle.kind === "short" ? "resize-short" : "resize-depth")}
              style={{ touchAction: "none", cursor: "nwse-resize" }}
            >
              <circle cx={secondHandle.pos[0]} cy={secondHandle.pos[1]} r="14" className="fp-hit" />
              <circle cx={secondHandle.pos[0]} cy={secondHandle.pos[1]} r="6.5" fill={block.color} className="fp-resize-handle" />
            </g>
            <text x={secondHandle.pos[0] + 10} y={secondHandle.pos[1] + 16} className="fp-size-label">
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

  return (
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
              {renderBlock(block, selected, drawing)}
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
              {!readOnly && selected ? renderSelectedControls(block, drawing) : null}
            </g>
          );
        })}
    </svg>
  );
}

/** A solid arrow whose tail sits at (x, y), pointing along (dx, dy). */
function FacingArrow({ x, y, dx, dy, color }) {
  const px = -dy;
  const py = dx;
  const tip = [x + dx * 13, y + dy * 13];
  const baseL = [x + dx * 6 + px * 4.5, y + dy * 6 + py * 4.5];
  const baseR = [x + dx * 6 - px * 4.5, y + dy * 6 - py * 4.5];
  return (
    <g className="fp-facing-arrow">
      <line x1={x} y1={y} x2={x + dx * 7} y2={y + dy * 7} stroke={color} strokeWidth="1.8" />
      <path d={`M ${tip[0]} ${tip[1]} L ${baseL[0]} ${baseL[1]} L ${baseR[0]} ${baseR[1]} Z`} fill={color} />
    </g>
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
