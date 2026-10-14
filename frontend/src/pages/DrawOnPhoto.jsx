import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { useAdjustMode } from "../adjustMode.js";
import {
  COLOUR_HEX,
  backrestAllowed,
  centroid,
  flipShape,
  moveCorner,
  moveShape,
  newShape,
  piecesOf,
  shapeParts,
  swapLounge,
} from "../shapes.js";

const SAVE_DELAY_MS = 400;

/** "Draw on photo (Beta)": each piece is drawn as a coloured shape on the
 * room photo. Corners and whole shapes drag; tapping an edge puts the
 * backrest (thick black line) there. Saved on the attempt as it changes. */
export default function DrawOnPhoto() {
  const { id } = useParams();
  const adjust = useAdjustMode(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [shapes, setShapes] = useState([]);
  const [selected, setSelected] = useState(null); // piece key
  const [size, setSize] = useState(null); // the photo's natural { w, h }
  const [scale, setScale] = useState(1); // photo pixels per screen pixel
  const [saveState, setSaveState] = useState("saved"); // "saved" | "saving" | "error"
  const svgRef = useRef(null);
  const drag = useRef(null);
  const saveTimer = useRef(null);
  const latest = useRef([]);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      const saved = data.attempt.shapes?.shapes || [];
      setShapes(saved);
      latest.current = saved;
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    function measure() {
      if (svgRef.current && size) setScale(size.w / Math.max(svgRef.current.getBoundingClientRect().width, 1));
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [size]);

  function save(next) {
    latest.current = next;
    setSaveState("saving");
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await api.put(`/api/attempts/${id}/shapes`, { json: { shapes: { version: 1, shapes: latest.current } } });
        setSaveState("saved");
      } catch (err) {
        setSaveState("error");
        toast(err.message);
      }
    }, SAVE_DELAY_MS);
  }

  function update(next, persist = true) {
    setShapes(next);
    if (persist) save(next);
  }

  const keyOf = (s) => `${s.item_id}:${s.sub_index}`;

  function toPhoto(e) {
    const rect = svgRef.current.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  }

  function startDrag(e, key, mode, extra = {}) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const shape = shapes.find((s) => keyOf(s) === key);
    drag.current = { key, mode, pointerId: e.pointerId, start: toPhoto(e), orig: shape.points, clientX: e.clientX, clientY: e.clientY, moved: false, ...extra };
    setSelected(key);
  }

  function moveDrag(e) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.clientX, e.clientY - d.clientY) < 5) return; // a tap, not a drag yet
    d.moved = true;
    const [x, y] = toPhoto(e);
    setShapes((prev) =>
      prev.map((s) => {
        if (keyOf(s) !== d.key) return s;
        if (d.mode === "corner") return moveCorner(s, d.index, x, y);
        return moveShape(s, d.orig, x - d.start[0], y - d.start[1]);
      })
    );
  }

  function endDrag(e) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    e.stopPropagation();
    drag.current = null;
    if (d.moved) {
      setShapes((prev) => {
        save(prev);
        return prev;
      });
    } else if (d.mode === "edge") {
      setBackrest(d.key, d.part, d.edge);
    }
  }

  function setBackrest(key, part, edge) {
    const next = shapes.map((s) => {
      if (keyOf(s) !== key || !backrestAllowed(s, part, edge)) return s;
      const backrest = [...s.backrest];
      backrest[part] = edge;
      return { ...s, backrest };
    });
    update(next);
  }

  function addShape(piece, index) {
    const shape = newShape(piece, index);
    update([...shapes.filter((s) => keyOf(s) !== piece.key), shape]);
    setSelected(piece.key);
  }

  function removeShape(key) {
    update(shapes.filter((s) => keyOf(s) !== key));
    if (selected === key) setSelected(null);
  }

  function changeShape(key, fn) {
    update(shapes.map((s) => (keyOf(s) === key ? fn(s) : s)));
  }

  async function useFloorPlan() {
    try {
      await api.put(`/api/attempts/${id}/placement-mode`, { json: { mode: "plan" } });
      navigate(`/attempt/${id}/place${adjust.query ? `?${adjust.query}` : ""}`);
    } catch (err) {
      toast(err.message);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const pieces = piecesOf(attempt.items);
  const byKey = Object.fromEntries(shapes.map((s) => [keyOf(s), s]));
  const curved = pieces.filter((p) => !p.kind);
  const missing = pieces.filter((p) => p.kind && !byKey[p.key]);
  const ready = pieces.length > 0 && curved.length === 0 && missing.length === 0;
  const W = size?.w || 1;
  const H = size?.h || 1;
  const px = ([x, y]) => [x * W, y * H];
  const handleR = 11 * scale;
  const status = curved.length
    ? "Curved sofas: please use Floor plan"
    : missing.length
      ? `${missing.length} ${missing.length === 1 ? "piece" : "pieces"} still to draw`
      : saveState === "saving"
        ? "Saving…"
        : saveState === "error"
          ? "Not saved — check the connection"
          : "All pieces drawn";
  const selectedShape = selected ? byKey[selected] : null;

  return (
    <div className="screen has-step-footer">
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/placement`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} placementMode="shapes" />
      <h1 style={{ marginBottom: 4 }}>
        Draw on photo <span className="beta-tag">Beta</span>
      </h1>
      <div className="hint-line" style={{ marginBottom: 12 }}>
        Add each piece, then drag its corners to the floor where it should stand. Tap an edge to put the backrest (black line) there.
      </div>

      <div className="draw-layout">
        <div className="draw-photo">
          <img
            src={attempt.room.photo_url}
            alt=""
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {size ? (
            <svg
              ref={svgRef}
              className="draw-svg"
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="none"
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerDown={() => setSelected(null)}
            >
              {shapes.map((s) => {
                const key = keyOf(s);
                const hex = COLOUR_HEX[s.colour];
                const parts = shapeParts(s.kind, s.points);
                const isSelected = key === selected;
                return (
                  <g key={key} className={"draw-shape" + (isSelected ? " selected" : "")}>
                    {parts.map((corners, part) => (
                      <polygon
                        key={part}
                        points={corners.map((p) => px(p).join(",")).join(" ")}
                        fill={hex}
                        fillOpacity={0.45}
                        stroke={hex}
                        strokeWidth={(isSelected ? 3 : 1.5) * scale}
                        strokeLinejoin="round"
                        onPointerDown={(e) => startDrag(e, key, "move")}
                      />
                    ))}
                    {parts.map((corners, part) => {
                      const edge = s.backrest[part];
                      if (edge == null) return null;
                      const [a, b] = [px(corners[edge]), px(corners[(edge + 1) % 4])];
                      return (
                        <line key={`b${part}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#000" strokeWidth={9 * scale} strokeLinecap="round" pointerEvents="none" />
                      );
                    })}
                    {s.kind === "L"
                      ? (() => {
                          const [cx, cy] = px(centroid(parts[s.lounge]));
                          return (
                            <text x={cx} y={cy} className="draw-label" fontSize={13 * scale} textAnchor="middle" dominantBaseline="central" pointerEvents="none">
                              LOUNGE
                            </text>
                          );
                        })()
                      : null}
                    {isSelected
                      ? parts.flatMap((corners, part) =>
                          [0, 1, 2, 3]
                            .filter((edge) => backrestAllowed(s, part, edge))
                            .map((edge) => {
                              const [a, b] = [px(corners[edge]), px(corners[(edge + 1) % 4])];
                              return (
                                <line
                                  key={`e${part}-${edge}`}
                                  x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                                  className="draw-edge-hit"
                                  strokeWidth={22 * scale}
                                  onPointerDown={(e) => startDrag(e, key, "edge", { part, edge })}
                                />
                              );
                            })
                        )
                      : null}
                    {isSelected
                      ? s.points.map((p, index) => {
                          const [cx, cy] = px(p);
                          return (
                            <circle
                              key={`c${index}`}
                              cx={cx} cy={cy} r={handleR}
                              className="draw-handle"
                              stroke={hex}
                              strokeWidth={3 * scale}
                              onPointerDown={(e) => startDrag(e, key, "corner", { index })}
                            />
                          );
                        })
                      : null}
                  </g>
                );
              })}
            </svg>
          ) : null}
        </div>

        <div className="draw-side">
          {selectedShape ? (
            <div className="draw-selected">
              <div className="draw-selected-title">
                <span className="draw-swatch" style={{ background: COLOUR_HEX[selectedShape.colour] }} />
                {pieces.find((p) => p.key === selected)?.name}
              </div>
              <div className="draw-actions">
                {selectedShape.kind === "L" ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => changeShape(selected, swapLounge)}>
                    The other part is the lounge
                  </button>
                ) : null}
                {selectedShape.kind !== "rect" ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => changeShape(selected, flipShape)}>
                    Flip left ↔ right
                  </button>
                ) : null}
                <button type="button" className="btn btn-small btn-danger-ghost" onClick={() => removeShape(selected)}>
                  Delete shape
                </button>
              </div>
            </div>
          ) : null}

          <div className="section-label">Pieces</div>
          <div className="draw-pieces">
            {pieces.map((p, index) => (
              <div key={p.key} className={"draw-piece" + (p.key === selected ? " selected" : "")}>
                {p.photo_url ? <img src={p.photo_url} alt="" /> : <span className="draw-piece-img" />}
                <span className="draw-swatch" style={{ background: COLOUR_HEX[p.colour] }} title={p.colour} />
                <span className="draw-piece-name">
                  {p.name}
                  {!p.kind ? <span className="draw-piece-note">Curved sofas: please use Floor plan</span> : null}
                </span>
                {!p.kind ? null : byKey[p.key] ? (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => setSelected(p.key)}>
                    Edit
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary btn-small" onClick={() => addShape(p, index)}>
                    Add
                  </button>
                )}
              </div>
            ))}
          </div>
          {curved.length ? (
            <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={useFloorPlan}>
              Use the floor plan instead
            </button>
          ) : null}
        </div>
      </div>

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
