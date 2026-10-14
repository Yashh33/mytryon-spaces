import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { PlacementCard } from "../components/PlacementCard.jsx";
import { useAdjustMode } from "../adjustMode.js";
import {
  SET_PIECE_SNAP_FT,
  SINGLE_PIECE_SNAP_FT,
  defaultPlacement,
  flipPlacement,
  itemsToBlocks,
  resizePlacement,
  rotatePlacement,
} from "../placement.js";
import {
  BACK_LINE_PX,
  DEFAULT_FLOOR_QUAD,
  FLOOR_POINT_MAX,
  FLOOR_POINT_MIN,
  OUTLINE_PX,
  SIDE_OPACITY,
  TOP_OPACITY,
  applyH,
  darker,
  floorTransform,
  guideBoxes,
  guidePieces,
  planFeetFor,
} from "../floorGuide.js";

const SAVE_DELAY_MS = 400;
const DOT_R = 16; // CSS px: big enough for a finger
const FLOOR_PAD = 0.12; // room around the photo (fraction of its width) so a dot can sit just outside it
const GRID_LINES = 6;

/** "Draw on photo (Beta)": A) mark the 4 corners of the floor on the photo
 * (once per room photo), B) place the pieces on a top-down plan of that floor
 * with the usual plan editor, while a live preview draws them on the photo
 * as see-through boxes — the same guide image the picture is made from. */
export default function DrawOnPhoto() {
  const { id } = useParams();
  const adjust = useAdjustMode(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [stage, setStage] = useState(null); // "floor" | "plan"
  const [quad, setQuad] = useState(DEFAULT_FLOOR_QUAD);
  const [savingFloor, setSavingFloor] = useState(false);
  const [blocks, setBlocks] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [size, setSize] = useState(null); // the photo's natural { w, h }
  const [saveState, setSaveState] = useState("saved");
  const [fullScreen, setFullScreen] = useState(false);
  const saveTimer = useRef(null);
  const latest = useRef([]);

  function buildBlocks(att) {
    const saved = att.shapes?.version === 2 ? att.shapes.blocks || [] : [];
    const byKey = Object.fromEntries(saved.map((b) => [`${b.item_id}-${b.sub_index}`, b]));
    const pieces = guidePieces(att.items);
    const colourByKey = Object.fromEntries(pieces.map((p) => [p.key, p.colour.hex]));
    return itemsToBlocks(att.items).map((b) => ({
      ...b,
      placement: byKey[b.key]?.geometry || null,
      widthFt: byKey[b.key]?.width_ft || b.widthFt,
      color: colourByKey[b.key],
      photo_url: att.items.find((i) => i.id === b.itemId)?.photo_url,
    }));
  }

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setQuad(data.attempt.room.floor_quad || DEFAULT_FLOOR_QUAD);
      setStage((prev) => prev || (data.attempt.room.floor_quad ? "plan" : "floor"));
      const fresh = buildBlocks(data.attempt);
      setBlocks(fresh);
      latest.current = fresh;
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const room = attempt?.room;
  const feet = useMemo(() => planFeetFor(room), [room]);
  const pieces = useMemo(() => (attempt ? guidePieces(attempt.items) : []), [attempt]);

  // ---- saving the plan ----------------------------------------------------
  function savePlan(next) {
    latest.current = next;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const plan = {
        version: 2,
        blocks: latest.current
          .filter((b) => b.placement)
          .map((b) => ({ item_id: b.itemId, sub_index: b.subIndex, shape: b.shape, geometry: b.placement, width_ft: b.widthFt })),
      };
      try {
        await api.put(`/api/attempts/${id}/shapes`, { json: { shapes: plan } });
        setSaveState("saved");
      } catch (err) {
        setSaveState("error");
        toast(err.message);
      }
    }, SAVE_DELAY_MS);
  }

  function change(key, patch, persist = true) {
    setBlocks((prev) => {
      const next = prev.map((b) => (b.key === key ? { ...b, ...patch } : b));
      if (persist) savePlan(next);
      else latest.current = next;
      return next;
    });
  }

  const blockOf = (key) => blocks.find((b) => b.key === key);
  const selectedBlock = blockOf(selectedKey) || null;
  const pendingKey = selectedBlock && !selectedBlock.placement ? selectedBlock.key : null;

  const cardProps = {
    room: room ? { ...room, layout_json: { depth_vs_width: room.layout_json?.depth_vs_width || "about square" }, layout_status: "ready" } : null,
    blocks,
    selectedBlock,
    selectedKey,
    planFeet: feet,
    onSelectBlock: setSelectedKey,
    onMoveBlock: (key, placement) => change(key, { placement }, false),
    onCommitBlock: (key, placement) => change(key, { placement }),
    onResizeBlock: (key, orig, x, y, handle = "length") => {
      const b = blockOf(key);
      if (!b) return;
      const snap = b.inSet ? SET_PIECE_SNAP_FT : SINGLE_PIECE_SNAP_FT;
      const { placement, widthFt } = resizePlacement(b.shape, orig, x, y, feet, snap, handle);
      change(key, handle === "length" ? { placement, widthFt } : { placement }, false);
    },
    onCommitResize: () => savePlan(latest.current),
    onDropPendingAt: (key, x, y) => {
      const b = blockOf(key);
      if (b) change(key, { placement: defaultPlacement(b.shape, b.widthFt, feet, x, y) });
    },
    pendingKey,
    addObstructionMode: false,
    onAddObstructionAt: () => {},
    onTapFeature: () => {},
    onMoveFeature: () => {},
    onTapObstruction: () => {},
    onRotate: () => {
      const b = selectedBlock;
      if (b?.placement) change(b.key, { placement: rotatePlacement(b.shape, b.placement, feet) });
    },
    onFlip: () => {
      const b = selectedBlock;
      if (b?.placement) change(b.key, { placement: flipPlacement(b.shape, b.placement, feet) });
    },
    onRequestRemove: () => {
      if (selectedBlock) change(selectedBlock.key, { placement: null });
    },
  };

  // ---- live preview ---------------------------------------------------------
  const preview = useMemo(() => {
    if (!size) return { boxes: [], loungeSide: {} };
    const byKey = Object.fromEntries(blocks.filter((b) => b.placement).map((b) => [b.key, b.placement]));
    return guideBoxes(quad, size.w, size.h, feet, pieces, byKey);
  }, [blocks, quad, feet, pieces, size]);

  // ---- floor corners ----------------------------------------------------------
  const floorSvg = useRef(null);
  const dotDrag = useRef(null);

  function toPhoto(e) {
    const r = floorSvg.current.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const padY = (FLOOR_PAD * size.w) / size.h;
    // the svg spans the photo plus FLOOR_PAD on every side
    return [fx * (1 + 2 * FLOOR_PAD) - FLOOR_PAD, fy * (1 + 2 * padY) - padY];
  }

  async function saveFloor() {
    setSavingFloor(true);
    try {
      const data = await api.put(`/api/rooms/${room.id}/floor`, { json: { points: quad } });
      setAttempt((prev) => ({ ...prev, room: { ...prev.room, ...data.room } }));
      setStage("plan");
    } catch (err) {
      toast(err.message);
    } finally {
      setSavingFloor(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const W = size?.w || 1;
  const H = size?.h || 1;
  const curved = pieces.filter((p) => p.shape === "curved");
  const unplaced = blocks.filter((b) => !b.placement && b.shape !== "curved");
  const floorSaved = Boolean(room.floor_quad);
  const ready = floorSaved && curved.length === 0 && unplaced.length === 0 && pieces.length > 0;
  const scale = W / 900; // stroke sizes in the preview, relative to a ~900 px wide view

  const photoImg = (
    <img
      src={room.photo_url}
      alt=""
      draggable={false}
      onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
    />
  );

  const header = (
    <>
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/placement`}
        crumbs={[
          { label: room.customer_name, to: `/customer/${room.customer_id}` },
          { label: room.room_type, to: `/room/${room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={room.id} query={adjust.query} placementMode="shapes" />
      <h1 style={{ marginBottom: 4 }}>
        Draw on photo <span className="beta-tag">Beta</span>
      </h1>
    </>
  );

  // ---------------------------------------------------------------- A: floor
  if (stage === "floor") {
    const padY = size ? (FLOOR_PAD * W) / H : FLOOR_PAD;
    const vb = `${-FLOOR_PAD * W} ${-padY * H} ${W * (1 + 2 * FLOOR_PAD)} ${H * (1 + 2 * padY)}`;
    const h = floorTransform(quad);
    const at = (u, v) => {
      const [x, y] = applyH(h, u, v);
      return [x * W, y * H];
    };
    const viewScale = size && floorSvg.current ? (W * (1 + 2 * FLOOR_PAD)) / floorSvg.current.getBoundingClientRect().width : 1;
    const grid = [];
    if (h) {
      for (let i = 1; i < GRID_LINES; i++) {
        grid.push([at(i / GRID_LINES, 0), at(i / GRID_LINES, 1)]);
        grid.push([at(0, i / GRID_LINES), at(1, i / GRID_LINES)]);
      }
    }
    const outline = [quad[0], quad[1], quad[3], quad[2]].map(([x, y]) => `${x * W},${y * H}`).join(" ");
    return (
      <div className="screen has-step-footer">
        {header}
        <div className="hint-line" style={{ marginBottom: 12 }}>Drag the 4 dots to the corners of the floor.</div>
        <div className="floor-stage" style={{ padding: `${(padY / (1 + 2 * padY)) * 100}% ${(FLOOR_PAD / (1 + 2 * FLOOR_PAD)) * 100}%` }}>
          <div className="floor-photo">{photoImg}</div>
          {size ? (
            <svg
              ref={floorSvg}
              className="floor-svg"
              viewBox={vb}
              preserveAspectRatio="none"
              onPointerMove={(e) => {
                const d = dotDrag.current;
                if (!d || d.pointerId !== e.pointerId) return;
                const [x, y] = toPhoto(e);
                const clamp = (v) => Math.round(Math.min(FLOOR_POINT_MAX, Math.max(FLOOR_POINT_MIN, v)) * 100000) / 100000;
                setQuad((prev) => prev.map((p, i) => (i === d.index ? [clamp(x), clamp(y)] : p)));
              }}
              onPointerUp={() => {
                dotDrag.current = null;
              }}
              onPointerCancel={() => {
                dotDrag.current = null;
              }}
            >
              {grid.map(([a, b], i) => (
                <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeOpacity={0.45} strokeWidth={1.2 * viewScale} pointerEvents="none" />
              ))}
              <polygon points={outline} fill="rgba(255,255,255,0.08)" stroke="#fff" strokeWidth={1.6 * viewScale} pointerEvents="none" />
              {quad.map(([x, y], index) => (
                <g key={index}>
                  <circle
                    cx={x * W} cy={y * H} r={DOT_R * viewScale}
                    className="floor-dot"
                    strokeWidth={3 * viewScale}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.currentTarget.ownerSVGElement.setPointerCapture(e.pointerId);
                      dotDrag.current = { index, pointerId: e.pointerId };
                    }}
                  />
                  <text x={x * W} y={y * H} fontSize={15 * viewScale} className="floor-dot-num" textAnchor="middle" dominantBaseline="central" pointerEvents="none">
                    {index + 1}
                  </text>
                </g>
              ))}
            </svg>
          ) : null}
        </div>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          1 and 2: where the back wall meets the floor, at its left and right ends. 3 and 4: where the side walls meet the floor near
          the bottom of the photo (they may sit just outside it).
        </div>
        <StepFooter
          backTo={floorSaved ? null : adjust.backTo || `/attempt/${id}/placement`}
          onBack={floorSaved ? () => { setQuad(room.floor_quad); setStage("plan"); } : undefined}
          status="Saved on this room photo for later attempts"
          primaryLabel="Done"
          primaryBusyLabel="Saving…"
          busy={savingFloor}
          onPrimary={saveFloor}
        />
      </div>
    );
  }

  // ---------------------------------------------------------------- B: plan
  const status = curved.length
    ? "Curved sofas: please use Floor plan"
    : unplaced.length
      ? `${unplaced.length} ${unplaced.length === 1 ? "piece" : "pieces"} still to place`
      : saveState === "saving"
        ? "Saving…"
        : saveState === "error"
          ? "Not saved — check the connection"
          : "All pieces placed";

  return (
    <div className="screen has-step-footer">
      {header}
      <div className="hint-line" style={{ marginBottom: 12 }}>
        {pendingKey ? "Tap the plan to drop this piece" : "Tap a piece below, then tap the plan to place it. The photo shows the result live."}
      </div>
      <div className="shapes-layout">
        <div className="shapes-plan">
          {!fullScreen ? <PlacementCard {...cardProps} fullScreen={false} onToggleFullScreen={() => setFullScreen(true)} /> : null}
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            The plan is the floor you marked: {feet.wFt} ft wide × {feet.hFt} ft deep. Top = back wall, bottom = camera side.
          </div>
        </div>

        <div className="shapes-preview">
          <div className="section-label" style={{ marginTop: 0 }}>Live preview</div>
          <div className="draw-photo">
            {photoImg}
            {size ? (
              <svg className="draw-svg preview-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                {preview.boxes.map(({ piece, parts }) => {
                  const hex = piece.colour.hex;
                  const line = darker(hex);
                  return (
                    <g key={piece.key}>
                      <g opacity={SIDE_OPACITY}>
                        {parts.flatMap((part, pi) =>
                          [0, 1, 2, 3].map((i) => {
                            const j = (i + 1) % 4;
                            const pts = [part.bottom[i], part.bottom[j], part.top[j], part.top[i]].map((p) => p.join(",")).join(" ");
                            return <polygon key={`s${pi}-${i}`} points={pts} fill={hex} />;
                          })
                        )}
                      </g>
                      <g opacity={TOP_OPACITY}>
                        {parts.map((part, pi) => (
                          <polygon key={`t${pi}`} points={part.top.map((p) => p.join(",")).join(" ")} fill={hex} />
                        ))}
                      </g>
                      {parts.map((part, pi) => (
                        <g key={`o${pi}`} fill="none" stroke={line} strokeWidth={OUTLINE_PX * scale} strokeLinejoin="round">
                          <polygon points={part.top.map((p) => p.join(",")).join(" ")} />
                          <polygon points={part.bottom.map((p) => p.join(",")).join(" ")} />
                          {[0, 1, 2, 3].map((i) => (
                            <line key={i} x1={part.bottom[i][0]} y1={part.bottom[i][1]} x2={part.top[i][0]} y2={part.top[i][1]} />
                          ))}
                        </g>
                      ))}
                      {parts.map((part, pi) =>
                        part.back == null ? null : (
                          <line
                            key={`b${pi}`}
                            x1={part.top[part.back][0]} y1={part.top[part.back][1]}
                            x2={part.top[(part.back + 1) % 4][0]} y2={part.top[(part.back + 1) % 4][1]}
                            stroke="#000" strokeWidth={BACK_LINE_PX * scale} strokeLinecap="round"
                          />
                        )
                      )}
                    </g>
                  );
                })}
                {preview.boxes.map(({ piece, parts }) => {
                  const tops = parts.flatMap((p) => p.top);
                  const cx = tops.reduce((s, p) => s + p[0], 0) / tops.length;
                  const top = Math.min(...tops.map((p) => p[1]));
                  const lounge = parts.find((p) => p.lounge);
                  const text = `${piece.number} · ${piece.typeLabel}`;
                  return (
                    <g key={`l${piece.key}`}>
                      <GuideTag x={cx} y={top - 26 * scale} text={text} size={20 * scale} />
                      {lounge ? (
                        <GuideTag
                          x={lounge.top.reduce((s, p) => s + p[0], 0) / 4}
                          y={lounge.top.reduce((s, p) => s + p[1], 0) / 4}
                          text="LOUNGE"
                          size={14 * scale}
                        />
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            ) : null}
          </div>
          <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => setStage("floor")}>
            Adjust floor corners
          </button>

          <div className="section-label">Pieces</div>
          <div className="draw-pieces">
            {pieces.map((p) => {
              const b = blockOf(p.key);
              const side = preview.loungeSide[p.number];
              return (
                <button
                  key={p.key}
                  type="button"
                  className={"draw-piece" + (p.key === selectedKey ? " selected" : "")}
                  onClick={() => setSelectedKey(p.key)}
                  disabled={p.shape === "curved"}
                >
                  {p.photoUrl ? <img src={p.photoUrl} alt="" /> : <span className="draw-piece-img" />}
                  <span className="draw-swatch" style={{ background: p.colour.hex }} title={p.colour.name} />
                  <span className="draw-piece-name">
                    {p.number} · {p.typeLabel}
                    {p.description ? <span className="draw-piece-desc">{p.description}</span> : null}
                    {p.shape === "curved" ? <span className="draw-piece-note">Curved sofas: please use Floor plan</span> : null}
                    {side ? <span className="draw-piece-desc">Lounge on the {side} in the picture</span> : null}
                  </span>
                  <span className={"piece-row-state" + (b?.placement ? " placed" : "")}>
                    {p.shape === "curved" ? "" : b?.placement ? "Placed ✓" : "Tap the plan"}
                  </span>
                </button>
              );
            })}
          </div>
          {curved.length ? (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginTop: 12 }}
              onClick={async () => {
                try {
                  await api.put(`/api/attempts/${id}/placement-mode`, { json: { mode: "plan" } });
                  navigate(`/attempt/${id}/place${adjust.query ? `?${adjust.query}` : ""}`);
                } catch (err) {
                  toast(err.message);
                }
              }}
            >
              Use the floor plan instead
            </button>
          ) : null}
        </div>
      </div>

      {fullScreen ? (
        <div className="placement-fullscreen">
          <PlacementCard {...cardProps} fullScreen onToggleFullScreen={() => setFullScreen(false)} />
        </div>
      ) : null}

      <StepFooter
        backTo={adjust.backTo || `/attempt/${id}/placement`}
        status={status}
        primaryLabel="Next"
        primaryDisabled={!ready || saveState === "saving"}
        onPrimary={() => navigate(`/attempt/${id}/finish${adjust.query ? `?${adjust.query}` : ""}`)}
      />
    </div>
  );
}

/** A white rounded label, as on the guide image. */
function GuideTag({ x, y, text, size }) {
  const w = text.length * size * 0.62 + size * 0.9;
  const h = size * 1.55;
  return (
    <g pointerEvents="none">
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={h / 3} fill="#fff" fillOpacity={0.92} stroke="rgba(0,0,0,0.35)" strokeWidth={size * 0.06} />
      <text x={x} y={y} fontSize={size} textAnchor="middle" dominantBaseline="central" fill="#111" fontWeight="700" fontFamily="var(--sans)">
        {text}
      </text>
    </g>
  );
}
