import { useRef } from "react";
import {
  ARC_TYPES,
  BAND_TYPES,
  DASHED_GAP_TYPES,
  DOUBLE_DASHED_GAP_TYPES,
  GAP_TYPES,
  POINT_TYPES,
  UNKNOWN_TYPES,
  WALL_KEY,
  WINDOW_TYPES,
  assignLabelRows,
  cameraGeometry,
  clamp01,
  clampRectToRoom,
  facingArrowAngle,
  featureFootprint,
  featureSpan,
  labelPosition,
  mergeAdjacentFeatures,
  planGeometry,
  rectsOverlap,
  snapRect,
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
  const dragRef = useRef(null); // { key, pointerId, grabDx, grabDy }

  const layout = room.layout_json;
  const geom = planGeometry(layout?.depth_vs_width);

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

  function startDrag(e, block, anchorRect) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toNormalized(e.clientX, e.clientY);
    dragRef.current = { key: block.key, pointerId: e.pointerId, grabDx: p.x - anchorRect.x, grabDy: p.y - anchorRect.y };
    onSelectBlock(block.key);
  }

  function moveDrag(e, block) {
    const drag = dragRef.current;
    if (!drag || drag.key !== block.key || drag.pointerId !== e.pointerId) return;
    const p = toNormalized(e.clientX, e.clientY);
    const rawX = p.x - drag.grabDx;
    const rawY = p.y - drag.grabDy;

    if (block.shape === "L") {
      const dx = rawX - block.placement.long.x;
      const dy = rawY - block.placement.long.y;
      const long = clampRectToRoom(snapRect({ ...block.placement.long, x: rawX, y: rawY }));
      const short = clampRectToRoom({
        ...block.placement.short,
        x: clamp01(block.placement.short.x + dx),
        y: clamp01(block.placement.short.y + dy),
      });
      onMoveBlock(block.key, { ...block.placement, long, short });
    } else {
      const rect = clampRectToRoom(snapRect({ ...block.placement, x: rawX, y: rawY }));
      onMoveBlock(block.key, rect);
    }
  }

  function endDrag(e, block) {
    const drag = dragRef.current;
    if (!drag || drag.key !== block.key || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    onCommitBlock(block.key, block.placement);
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
    const rects = block.shape === "L" ? [block.placement.long, block.placement.short] : [block.placement];
    for (const rect of rects) {
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

  function renderBlockRect(block, rect, selected) {
    const px = geom.roomX + rect.x * geom.roomW;
    const py = geom.roomY + rect.y * geom.roomH;
    const pw = rect.w * geom.roomW;
    const ph = rect.h * geom.roomH;
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    const angle = facingArrowAngle(rect.rotation);
    return (
      <g
        onPointerDown={readOnly ? undefined : (e) => startDrag(e, block, rect)}
        onPointerMove={readOnly ? undefined : (e) => moveDrag(e, block)}
        onPointerUp={readOnly ? undefined : (e) => endDrag(e, block)}
        onPointerCancel={readOnly ? undefined : (e) => endDrag(e, block)}
        style={readOnly ? undefined : { touchAction: "none", cursor: "grab" }}
      >
        <rect x={px} y={py} width={pw} height={ph} fill={block.color} fillOpacity="0.28" stroke={block.color} strokeWidth={selected ? 2.5 : 1.5} rx="3" />
        <g transform={`translate(${cx} ${cy}) rotate(${angle})`}>
          <path d="M 0 -9 L 5 1 L -5 1 Z" fill={block.color} />
        </g>
        <text x={cx} y={py + ph + 12} className="fp-block-number" textAnchor="middle">
          {block.number}
        </text>
      </g>
    );
  }

  function renderSelectedControls(block) {
    const anchor = block.shape === "L" ? block.placement.long : block.placement;
    const hx = geom.roomX + (anchor.x + anchor.w) * geom.roomW;
    const hy = geom.roomY + anchor.y * geom.roomH;
    return (
      <g key={`${block.key}-controls`}>
        <circle
          cx={hx} cy={hy} r="11" className="fp-handle fp-rotate-handle"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => {
            e.stopPropagation();
            onRotateBlock(block.key);
          }}
        />
        <text x={hx} y={hy + 4} textAnchor="middle" className="fp-handle-icon" onPointerUp={(e) => e.stopPropagation()}>
          &#8635;
        </text>
        {block.shape === "L" ? (
          <>
            <circle
              cx={hx - 26} cy={hy} r="11" className="fp-handle fp-flip-handle"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => {
                e.stopPropagation();
                onFlipBlock(block.key);
              }}
            />
            <text x={hx - 26} y={hy + 4} textAnchor="middle" className="fp-handle-icon" onPointerUp={(e) => e.stopPropagation()}>
              &#8646;
            </text>
          </>
        ) : null}
        <circle
          cx={hx - (block.shape === "L" ? 52 : 26)} cy={hy} r="11" className="fp-handle fp-remove-handle"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => {
            e.stopPropagation();
            onRemoveBlock(block.key);
          }}
        />
        <text
          x={hx - (block.shape === "L" ? 52 : 26)} y={hy + 4} textAnchor="middle" className="fp-handle-icon"
          onPointerUp={(e) => e.stopPropagation()}
        >
          &times;
        </text>
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
          return (
            <g key={block.key} opacity={pendingKey && !selected ? 0.55 : 1}>
              {block.shape === "L" ? (
                <>
                  {renderBlockRect(block, block.placement.long, selected)}
                  {renderBlockRect(block, block.placement.short, selected)}
                </>
              ) : (
                renderBlockRect(block, block.placement, selected)
              )}
              {warning ? (
                <>
                  {(block.shape === "L" ? [block.placement.long, block.placement.short] : [block.placement]).map((rect, i) => (
                    <rect
                      key={i}
                      x={geom.roomX + rect.x * geom.roomW - 2} y={geom.roomY + rect.y * geom.roomH - 2}
                      width={rect.w * geom.roomW + 4} height={rect.h * geom.roomH + 4}
                      className="fp-warning-outline"
                    />
                  ))}
                  <text
                    x={geom.roomX + (block.shape === "L" ? block.placement.long.x : block.placement.x) * geom.roomW}
                    y={geom.roomY + (block.shape === "L" ? block.placement.long.y : block.placement.y) * geom.roomH - 6}
                    className="fp-warning-label"
                  >
                    Overlaps {warning}
                  </text>
                </>
              ) : null}
              {!readOnly && selected ? renderSelectedControls(block) : null}
            </g>
          );
        })}
    </svg>
  );
}
