import { useRef } from "react";
import {
  ARC_TYPES,
  BAND_TYPES,
  DASHED_GAP_TYPES,
  GAP_TYPES,
  POINT_TYPES,
  WALL_KEY,
  clamp01,
  clampRectToRoom,
  facingArrowAngle,
  featureFootprint,
  featureSpan,
  rectsOverlap,
  roomAspect,
  snapRect,
} from "../placement.js";

const WALLS = ["far", "left", "right", "near"];

function viewBoxSize(depthVsWidth) {
  const [aw, ah] = roomAspect(depthVsWidth);
  const scale = 400 / Math.max(aw, ah);
  return [Math.round(aw * scale), Math.round(ah * scale)];
}

function wallLine(wall, W, H) {
  if (wall === "far") return { x1: 0, y1: 0, x2: W, y2: 0, axis: "x", length: W };
  if (wall === "near") return { x1: 0, y1: H, x2: W, y2: H, axis: "x", length: W };
  if (wall === "left") return { x1: 0, y1: 0, x2: 0, y2: H, axis: "y", length: H };
  return { x1: W, y1: 0, x2: W, y2: H, axis: "y", length: H }; // right
}

/** Point along a wall at normalised `t` (0-1), and an inward normal to
 * offset symbols/blocks slightly off the wall line. */
function wallPoint(wall, t, W, H) {
  if (wall === "far") return { x: t * W, y: 0, nx: 0, ny: 1 };
  if (wall === "near") return { x: t * W, y: H, nx: 0, ny: -1 };
  if (wall === "left") return { x: 0, y: t * H, nx: 1, ny: 0 };
  return { x: W, y: t * H, nx: -1, ny: 0 }; // right
}

function cameraX(cameraPosition, W) {
  const p = (cameraPosition || "").toLowerCase();
  if (p.includes("left")) return W * 0.15;
  if (p.includes("right")) return W * 0.85;
  return W * 0.5;
}

function featureLabel(feature) {
  return feature.type || "feature";
}

export function FloorPlan({
  room,
  blocks,
  selectedKey,
  onSelectBlock,
  onMoveBlock,
  onCommitBlock,
  onRotateBlock,
  onFlipBlock,
  onRemoveBlock,
  onDropPendingAt,
  pendingKey,
  addObstructionMode,
  onAddObstructionAt,
  onTapFeature,
  onTapObstruction,
}) {
  const svgRef = useRef(null);
  const dragRef = useRef(null); // { key, pointerId, grabDx, grabDy }

  const layout = room.layout_json;
  const [W, H] = viewBoxSize(layout?.depth_vs_width);

  function toNormalized(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height),
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
    const features = wallData?.features || [];
    const partial = wallData?.confidence === "partial";
    const line = wallLine(wall, W, H);
    const elements = [];
    let cursor = 0;

    features.forEach((feature, index) => {
      const span = featureSpan(feature.position, feature.size);
      if (!span) return;
      const [start, end] = span;
      const a = wallPoint(wall, start, W, H);
      const b = wallPoint(wall, end, W, H);
      const mid = wallPoint(wall, (start + end) / 2, W, H);
      const dashed = partial ? "6 4" : DASHED_GAP_TYPES.has(feature.type) ? "5 5" : null;
      const key = `${wall}-feature-${index}`;

      if (GAP_TYPES.has(feature.type)) {
        // solid wall segment before the gap
        elements.push(<line key={`${key}-pre`} {...segmentBetween(line, cursor, start, W, H)} className="fp-wall" />);
        cursor = end;
        if (DASHED_GAP_TYPES.has(feature.type)) {
          elements.push(<line key={`${key}-d1`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="fp-wall fp-dashed" />);
        }
        if (ARC_TYPES.has(feature.type)) {
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
      } else if (feature.type === "window") {
        const offset1 = { x: a.nx * 3, y: a.ny * 3 };
        const offset2 = { x: a.nx * 7, y: a.ny * 7 };
        elements.push(
          <g key={key}>
            <line x1={a.x + offset1.x} y1={a.y + offset1.y} x2={b.x + offset1.x} y2={b.y + offset1.y} className="fp-window" />
            <line x1={a.x + offset2.x} y1={a.y + offset2.y} x2={b.x + offset2.x} y2={b.y + offset2.y} className="fp-window" />
          </g>
        );
      } else if (BAND_TYPES.has(feature.type)) {
        elements.push(
          <line
            key={key}
            x1={a.x + a.nx * 5} y1={a.y + a.ny * 5}
            x2={b.x + a.nx * 5} y2={b.y + a.ny * 5}
            className="fp-band"
            strokeDasharray="4 3"
          />
        );
      } else if (POINT_TYPES.has(feature.type)) {
        elements.push(
          <rect
            key={key}
            x={mid.x + mid.nx * 8 - 5} y={mid.y + mid.ny * 8 - 5}
            width="10" height="10"
            className="fp-pillar"
          />
        );
      }

      if (dashed && !GAP_TYPES.has(feature.type)) {
        // partial-confidence outline for a non-gap feature: a faint dashed box around it
        elements.push(
          <rect
            key={`${key}-unsure`}
            x={Math.min(a.x, b.x) - 4} y={Math.min(a.y, b.y) - 4}
            width={Math.max(Math.abs(b.x - a.x), 8) + 8} height={Math.max(Math.abs(b.y - a.y), 8) + 8}
            className="fp-unsure"
          />
        );
      }

      elements.push(
        <text key={`${key}-label`} x={mid.x + mid.nx * 14} y={mid.y + mid.ny * 14} className="fp-label" textAnchor="middle">
          {featureLabel(feature)}
          {partial ? " ?" : ""}
        </text>
      );

      elements.push(
        <rect
          key={`${key}-hit`}
          x={Math.min(a.x, b.x) - 6} y={Math.min(a.y, b.y) - 6}
          width={Math.max(Math.abs(b.x - a.x), 12) + 12} height={Math.max(Math.abs(b.y - a.y), 12) + 12}
          className="fp-hit"
          onPointerUp={(e) => {
            e.stopPropagation();
            onTapFeature(wall, index);
          }}
        />
      );
    });

    elements.push(<line key={`${wall}-tail`} {...segmentBetween(line, cursor, 1, W, H)} className="fp-wall" />);
    return elements;
  }

  function renderObstructions() {
    const obstructions = layout?.obstructions || [];
    return obstructions
      .map((o, index) => (o.x != null && o.y != null ? { o, index } : null))
      .filter(Boolean)
      .map(({ o, index }) => (
        <g key={`obstruction-${index}`}>
          <rect x={o.x * W - 6} y={o.y * H - 6} width="12" height="12" className="fp-pillar" />
          <text x={o.x * W} y={o.y * H - 12} className="fp-label" textAnchor="middle">
            {o.type || "obstruction"}
          </text>
          <rect
            x={o.x * W - 14} y={o.y * H - 14} width="28" height="28"
            className="fp-hit"
            onPointerUp={(e) => {
              e.stopPropagation();
              onTapObstruction(index);
            }}
          />
        </g>
      ));
  }

  function renderCamera() {
    if (!layout) return null;
    const cx = cameraX(layout.camera_position, W);
    return (
      <g className="fp-camera">
        <circle cx={cx} cy={H + 14} r="7" />
        <text x={cx} y={H + 32} className="fp-label" textAnchor="middle">camera</text>
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
    const cx = (rect.x + rect.w / 2) * W;
    const cy = (rect.y + rect.h / 2) * H;
    const angle = facingArrowAngle(rect.rotation);
    return (
      <g
        key={selected ? `${block.key}-rect` : undefined}
        onPointerDown={(e) => startDrag(e, block, rect)}
        onPointerMove={(e) => moveDrag(e, block)}
        onPointerUp={(e) => endDrag(e, block)}
        onPointerCancel={(e) => endDrag(e, block)}
        style={{ touchAction: "none", cursor: "grab" }}
      >
        <rect
          x={rect.x * W} y={rect.y * H} width={rect.w * W} height={rect.h * H}
          fill={block.color} fillOpacity="0.28" stroke={block.color} strokeWidth={selected ? 2.5 : 1.5}
          rx="3"
        />
        <g transform={`translate(${cx} ${cy}) rotate(${angle})`}>
          <path d="M 0 -9 L 5 1 L -5 1 Z" fill={block.color} />
        </g>
        <text x={cx} y={cy + (rect.h * H) / 2 + 12} className="fp-block-number" textAnchor="middle">
          {block.number}
        </text>
      </g>
    );
  }

  function renderSelectedControls(block) {
    const anchor = block.shape === "L" ? block.placement.long : block.placement;
    const hx = (anchor.x + anchor.w) * W;
    const hy = anchor.y * H;
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
      viewBox={`0 0 ${W} ${H}`}
      className="floor-plan-svg"
      onPointerUp={handleBackgroundPointerUp}
    >
      <rect x="0" y="0" width={W} height={H} className="fp-floor" />
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
                  {(block.shape === "L" ? [block.placement.long, block.placement.short] : [block.placement]).map(
                    (rect, i) => (
                      <rect
                        key={i}
                        x={rect.x * W - 2} y={rect.y * H - 2} width={rect.w * W + 4} height={rect.h * H + 4}
                        className="fp-warning-outline"
                      />
                    )
                  )}
                  <text
                    x={(block.shape === "L" ? block.placement.long.x : block.placement.x) * W}
                    y={(block.shape === "L" ? block.placement.long.y : block.placement.y) * H - 6}
                    className="fp-warning-label"
                  >
                    Overlaps {warning}
                  </text>
                </>
              ) : null}
              {selected ? renderSelectedControls(block) : null}
            </g>
          );
        })}
    </svg>
  );
}

function segmentBetween(line, from, to, W, H) {
  if (from >= to) return { x1: line.x1, y1: line.y1, x2: line.x1, y2: line.y1 };
  if (line.axis === "x") {
    return { x1: line.x1 + from * W, y1: line.y1, x2: line.x1 + to * W, y2: line.y1 };
  }
  return { x1: line.x1, y1: line.y1 + from * H, x2: line.x1, y2: line.y1 + to * H };
}
