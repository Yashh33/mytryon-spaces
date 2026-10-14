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
  cornerDots,
  flipShape,
  moveCorner,
  moveLCorner,
  moveShape,
  newShape,
  piecesOf,
  shapeCentre,
  shapeParts,
  snapAngle,
  swapLounge,
  tiltFactor,
  tiltPoints,
  transformPoints,
} from "../shapes.js";

const SAVE_DELAY_MS = 400;
const TAP_SLOP_PX = 5; // a finger may wander this far and still count as a tap
// on-screen sizes (CSS px), turned into photo pixels with `scale`
const CORNER_R = 8;
const RESIZE_SIZE = 32;
const ROTATE_R = 17;
const TILT_W = 26;
const TILT_H = 38;
const HANDLE_GAP = 14; // handles sit this far outside the shape
const ROTATE_STICK = 30;

const keyOf = (s) => `${s.item_id}:${s.sub_index}`;

/** "Draw on photo (Beta)": each piece is drawn as a coloured shape on the
 * room photo. Drag inside a shape to move it; the square handle resizes the
 * whole shape from its centre, the round handle turns it (snapping to quarter
 * turns), the up/down handle tilts it (up lays it flatter on the floor, like
 * a rug seen in perspective); two fingers pinch to resize and twist to turn.
 * Corner dots are for fine-tuning (an L shows only its outer corners: the
 * inner ones follow); tapping an edge puts the backrest (black line) there.
 * Shapes never leave the photo. Saved on the attempt as corner points. */
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
  const drag = useRef(null); // one-finger action in progress
  const pointers = useRef(new Map()); // pointerId -> [clientX, clientY]
  const gesture = useRef(null); // two-finger pinch / twist in progress
  const saveTimer = useRef(null);
  const latest = useRef([]);
  const shapesRef = useRef([]);
  shapesRef.current = shapes;

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      // a shape's colour follows its piece's place in the list
      const colours = Object.fromEntries(piecesOf(data.attempt.items).map((p) => [p.key, p.colour]));
      const saved = (data.attempt.shapes?.shapes || []).map((s) => ({ ...s, colour: colours[keyOf(s)] || s.colour }));
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

  function update(next) {
    setShapes(next);
    save(next);
  }

  const aspect = size ? size.w / size.h : 1;

  /** Pointer position as fractions of the photo. */
  function toPhoto(clientX, clientY) {
    const rect = svgRef.current.getBoundingClientRect();
    return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
  }

  /** Angle (degrees, clockwise on screen) and distance (photo-height units)
   * from `centre` to a point, measured in true photo proportions. */
  function polar(centre, p) {
    const dx = (p[0] - centre[0]) * aspect;
    const dy = p[1] - centre[1];
    return { deg: (Math.atan2(dy, dx) * 180) / Math.PI, dist: Math.hypot(dx, dy) };
  }

  function setShapePoints(key, points) {
    setShapes((prev) => prev.map((s) => (keyOf(s) === key ? { ...s, points } : s)));
  }

  function startGesture() {
    const shape = shapesRef.current.find((s) => keyOf(s) === selected);
    const [a, b] = [...pointers.current.values()];
    if (!shape || !a || !b) return;
    drag.current = null;
    const pa = toPhoto(...a);
    const pb = toPhoto(...b);
    const v = polar(pa, pb);
    gesture.current = { key: selected, orig: shape.points, deg: v.deg, dist: Math.max(v.dist, 1e-6) };
  }

  function onPointerDown(e) {
    e.preventDefault();
    svgRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {
      startGesture(); // second finger: pinch / twist the selected shape
      return;
    }
    if (pointers.current.size > 2) return;
    const t = e.target.dataset || {};
    const key = t.key || null;
    const shape = key ? shapesRef.current.find((s) => keyOf(s) === key) : null;
    const at = toPhoto(e.clientX, e.clientY);
    drag.current = {
      role: shape ? t.role : "empty",
      key,
      pointerId: e.pointerId,
      start: at,
      clientX: e.clientX,
      clientY: e.clientY,
      moved: false,
      orig: shape?.points,
      index: t.index != null ? Number(t.index) : null,
      part: t.part != null ? Number(t.part) : null,
      edge: t.edge != null ? Number(t.edge) : null,
    };
    if (shape) {
      setSelected(key);
      if (t.role === "resize" || t.role === "rotate") {
        const centre = shapeCentre(shape.points);
        Object.assign(drag.current, { centre, from: polar(centre, at) });
      }
    }
  }

  function onPointerMove(e) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    const g = gesture.current;
    if (g) {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const v = polar(toPhoto(...a), toPhoto(...b));
      const points = transformPoints(g.orig, v.dist / g.dist, snapAngle(v.deg - g.deg), aspect);
      if (points) setShapePoints(g.key, points);
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.clientX, e.clientY - d.clientY) < TAP_SLOP_PX) return;
    d.moved = true;
    if (d.role === "empty") return;
    const at = toPhoto(e.clientX, e.clientY);
    if (d.role === "corner") {
      const shape = shapesRef.current.find((s) => keyOf(s) === d.key);
      if (shape?.kind === "L") {
        // the L moves as one piece: its inner corners follow the outer dot
        const points = moveLCorner(d.orig, d.index, at[0], at[1], aspect);
        if (points) setShapePoints(d.key, points);
      } else {
        setShapes((prev) => prev.map((s) => (keyOf(s) === d.key ? moveCorner(s, d.index, at[0], at[1]) : s)));
      }
    } else if (d.role === "tilt") {
      // up lays the shape flatter, down stands it back up toward the view from above
      const points = tiltPoints(d.orig, tiltFactor(at[1] - d.start[1]), aspect);
      if (points) setShapePoints(d.key, points); // a tilt that won't fit stops at the last one that did
    } else if (d.role === "resize") {
      const now = polar(d.centre, at);
      const points = transformPoints(d.orig, now.dist / Math.max(d.from.dist, 1e-6), 0, aspect, true);
      if (points) setShapePoints(d.key, points);
    } else if (d.role === "rotate") {
      const now = polar(d.centre, at);
      const points = transformPoints(d.orig, 1, snapAngle(now.deg - d.from.deg), aspect);
      if (points) setShapePoints(d.key, points); // a turn that won't fit stops at the last one that did
    } else {
      // "move" or a drag that began on an edge: the whole shape follows
      setShapes((prev) => prev.map((s) => (keyOf(s) === d.key ? moveShape(s, d.orig, at[0] - d.start[0], at[1] - d.start[1]) : s)));
    }
  }

  function onPointerUp(e) {
    pointers.current.delete(e.pointerId);
    if (gesture.current) {
      if (pointers.current.size < 2) {
        gesture.current = null;
        save(shapesRef.current);
      }
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (e.type === "pointercancel") return;
    if (d.moved && d.role !== "empty") save(shapesRef.current);
    else if (!d.moved && d.role === "empty") setSelected(null); // tap on the photo: deselect
    else if (!d.moved && d.role === "edge") setBackrest(d.key, d.part, d.edge);
  }

  function setBackrest(key, part, edge) {
    update(
      shapesRef.current.map((s) => {
        if (keyOf(s) !== key || !backrestAllowed(s, part, edge)) return s;
        const backrest = [...s.backrest];
        backrest[part] = edge;
        return { ...s, backrest };
      })
    );
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

  /** Resize (bottom-right), rotate (above) and tilt (left side) handles,
   * outside the shape's bounding box but always kept on the photo so they
   * can be reached. */
  function handlesFor(s) {
    const pts = s.points.map(px);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const keep = (v, r, limit) => Math.min(Math.max(v, r), limit - r);
    const rs = RESIZE_SIZE * scale;
    const rr = ROTATE_R * scale;
    const resize = [keep(maxX + HANDLE_GAP * scale + rs / 2, rs / 2, W), keep(maxY + HANDLE_GAP * scale + rs / 2, rs / 2, H)];
    const midX = (minX + maxX) / 2;
    const rotate = [keep(midX, rr, W), keep(minY - (ROTATE_STICK + HANDLE_GAP) * scale - rr, rr, H)];
    const [tw, th] = [TILT_W * scale, TILT_H * scale];
    const tilt = [keep(minX - HANDLE_GAP * scale - tw / 2, tw / 2, W), keep((minY + maxY) / 2, th / 2, H)];
    return { resize, rotate, tilt, stickFrom: [midX, minY], rs, rr, tw, th };
  }

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
        Add each piece, then drag it onto the floor. Square handle: resize. Round handle: turn (or pinch and twist with two
        fingers). Up/down handle: tilt — drag up to lay the shape flatter on the floor. Tap an edge to put the backrest
        (black line) there.
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
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
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
                        data-role="move"
                        data-key={key}
                        points={corners.map((p) => px(p).join(",")).join(" ")}
                        fill={hex}
                        fillOpacity={0.45}
                        stroke={hex}
                        strokeWidth={(isSelected ? 3 : 1.5) * scale}
                        strokeLinejoin="round"
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
                                  data-role="edge"
                                  data-key={key}
                                  data-part={part}
                                  data-edge={edge}
                                  x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                                  className="draw-edge-hit"
                                  strokeWidth={22 * scale}
                                />
                              );
                            })
                        )
                      : null}
                  </g>
                );
              })}

              {/* the selected shape's handles go on top of every shape */}
              {selectedShape
                ? (() => {
                    const key = selected;
                    const hex = COLOUR_HEX[selectedShape.colour];
                    const h = handlesFor(selectedShape);
                    return (
                      <g className="draw-handles">
                        <line
                          x1={h.stickFrom[0]} y1={h.stickFrom[1]} x2={h.rotate[0]} y2={h.rotate[1] + h.rr}
                          stroke="#fff" strokeWidth={3 * scale} strokeDasharray={`${4 * scale} ${3 * scale}`} pointerEvents="none"
                        />
                        <g className="draw-rotate">
                          <circle data-role="rotate" data-key={key} cx={h.rotate[0]} cy={h.rotate[1]} r={h.rr} fill="#fff" stroke={hex} strokeWidth={3 * scale} />
                          <text x={h.rotate[0]} y={h.rotate[1]} fontSize={20 * scale} textAnchor="middle" dominantBaseline="central" fill="#111" pointerEvents="none">
                            ↻
                          </text>
                        </g>
                        <g className="draw-resize">
                          <rect
                            data-role="resize" data-key={key}
                            x={h.resize[0] - h.rs / 2} y={h.resize[1] - h.rs / 2} width={h.rs} height={h.rs} rx={5 * scale}
                            fill="#fff" stroke={hex} strokeWidth={3 * scale}
                          />
                          <text x={h.resize[0]} y={h.resize[1]} fontSize={19 * scale} textAnchor="middle" dominantBaseline="central" fill="#111" pointerEvents="none">
                            ⤡
                          </text>
                        </g>
                        <g className="draw-tilt">
                          <rect
                            data-role="tilt" data-key={key}
                            x={h.tilt[0] - h.tw / 2} y={h.tilt[1] - h.th / 2} width={h.tw} height={h.th} rx={h.tw / 2}
                            fill="#fff" stroke={hex} strokeWidth={3 * scale}
                          />
                          <text x={h.tilt[0]} y={h.tilt[1]} fontSize={19 * scale} textAnchor="middle" dominantBaseline="central" fill="#111" pointerEvents="none">
                            ↕
                          </text>
                        </g>
                        {cornerDots(selectedShape).map((index) => {
                          const [cx, cy] = px(selectedShape.points[index]);
                          return (
                            <circle
                              key={`c${index}`}
                              data-role="corner" data-key={key} data-index={index}
                              cx={cx} cy={cy} r={CORNER_R * scale}
                              className="draw-handle"
                              stroke={hex}
                              strokeWidth={2.5 * scale}
                            />
                          );
                        })}
                      </g>
                    );
                  })()
                : null}
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
