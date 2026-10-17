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
  bendCurve,
  centroid,
  curvedOutline,
  flipShape,
  flipShapeVertical,
  floorTurnSign,
  moveLoungeToOtherEnd,
  moveShape,
  newShape,
  piecesOf,
  shapeFits,
  shapeCentre,
  shapeParts,
  snapAngle,
  tiltFactor,
  tiltPoints,
  transformPoints,
  turnOnFloor,
  FLOOR_TURN_DEG_PER_WIDTH,
} from "../shapes.js";

const SAVE_DELAY_MS = 400;
const TAP_SLOP_PX = 5; // a finger may wander this far and still count as a tap
// on-screen sizes (CSS px), turned into photo pixels with `scale`
const RESIZE_SIZE = 32;
const ROTATE_R = 17;
const TILT_W = 26;
const BEND_R = 14;
const FLOOR_TURN_W = 44;
const FLOOR_TURN_H = 26;
const TILT_H = 38;
const HANDLE_GAP = 14; // handles sit this far outside the shape
const ROTATE_STICK = 30;
const NUMBER_R = 11; // the round number chip on each shape
// the bottom toolbar's steps
const TURN_STEP_DEG = 15;
const TILT_STEP = 0.03; // photo-height fractions of a tilt drag
const SIZE_STEP = 1.08;
const UNDO_STEPS = 30;
const ROTATE_HINT_MS = 4000;
const SHOW_BUTTONS_KEY = "drawOnPhoto.showButtons";

const keyOf = (s) => `${s.item_id}:${s.sub_index}`;

function isTouchDevice() {
  return typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);
}

function readShowButtons() {
  try {
    const saved = window.localStorage.getItem(SHOW_BUTTONS_KEY);
    if (saved === "1" || saved === "0") return saved === "1";
  } catch {
    // storage unavailable: use the default
  }
  return !isTouchDevice(); // on by default on desktop, off on touch devices
}

/** A small white rounded tag centred on `at` (photo pixels), kept on the photo. */
function SmallTag({ text, at, font, W, H }) {
  const pad = font / 3;
  const w = text.length * font * 0.6 + 2 * pad;
  const h = font + 2 * pad;
  const x = Math.min(Math.max(at[0] - w / 2, 0), W - w);
  const y = Math.min(Math.max(at[1] - h / 2, 0), H - h);
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="#fff" stroke="#000" strokeWidth={font / 24} />
      <text x={x + w / 2} y={y + h / 2} className="draw-tag" fontSize={font} textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  );
}

/** "Draw on photo (Beta)": each piece is drawn as a coloured shape on the
 * room photo. Drag inside a shape to move it; the square handle resizes the
 * whole shape from its centre, the round handle spins it on the screen
 * (snapping to quarter turns), the handle below turns it on the floor, the
 * up/down handle tilts it (up lays it flatter on the floor); two fingers
 * pinch to resize and twist to turn it on the floor; a curved sofa has a
 * bend handle. No corner dots: a shape keeps its proportions (it is never
 * stretched from a corner). Tapping an edge puts the backrest (black line)
 * there. A bottom toolbar does the same in steps, Undo goes back, and Full
 * screen shows the photo edge to edge. Shapes never leave the photo. Saved
 * on the attempt as corner points. The draw screen shows only a number on
 * each shape; the guide image and Preview keep the full labels. */
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
  const [guideStyle, setGuideStyle] = useState("boxes"); // with boxes, each box's raised top must stay on the photo too
  const [undoCount, setUndoCount] = useState(0);
  const [showButtons, setShowButtons] = useState(readShowButtons);
  const [fullscreen, setFullscreen] = useState(false);
  const [fit, setFit] = useState(null); // the photo's on-screen { w, h } in full screen
  const [rotateHint, setRotateHint] = useState(false);
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const drag = useRef(null); // one-finger action in progress
  const pointers = useRef(new Map()); // pointerId -> [clientX, clientY]
  const gesture = useRef(null); // two-finger pinch / twist in progress
  const saveTimer = useRef(null);
  const latest = useRef([]);
  const shapesRef = useRef([]);
  const history = useRef([]); // earlier shape lists, newest last
  const nativeFullscreen = useRef(false);
  shapesRef.current = shapes;

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setGuideStyle(data.guide_style || "boxes");
      // a shape's colour follows its piece's place in the list
      const colours = Object.fromEntries(piecesOf(data.attempt.items).map((p) => [p.key, p.colour]));
      const saved = (data.attempt.shapes?.shapes || []).map((s) => ({ ...s, colour: colours[keyOf(s)] || s.colour }));
      setShapes(saved);
      latest.current = saved;
      history.current = [];
      setUndoCount(0);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // photo pixels per screen pixel, whenever the photo's size on screen changes
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !size) return undefined;
    const measure = () => setScale(size.w / Math.max(svg.getBoundingClientRect().width, 1));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [size, fullscreen]);

  // full screen: the photo as big as the space allows, keeping its shape
  useEffect(() => {
    if (!fullscreen || !size || !stageRef.current) return undefined;
    const stage = stageRef.current;
    const fitPhoto = () => {
      const k = Math.min(stage.clientWidth / size.w, stage.clientHeight / size.h);
      setFit({ w: Math.floor(size.w * k), h: Math.floor(size.h * k) });
      if (window.innerWidth > window.innerHeight) setRotateHint(false); // turned sideways
    };
    fitPhoto();
    const observer = new ResizeObserver(fitPhoto);
    observer.observe(stage);
    window.addEventListener("orientationchange", fitPhoto);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", fitPhoto);
    };
  }, [fullscreen, size]);

  // leaving the browser's full screen (Esc, back gesture) leaves ours too
  useEffect(() => {
    function onChange() {
      const active = document.fullscreenElement || document.webkitFullscreenElement;
      if (!active && nativeFullscreen.current) {
        nativeFullscreen.current = false;
        setFullscreen(false);
        setFit(null);
        setRotateHint(false);
      }
    }
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  useEffect(() => {
    if (!rotateHint) return undefined;
    const timer = setTimeout(() => setRotateHint(false), ROTATE_HINT_MS);
    return () => clearTimeout(timer);
  }, [rotateHint]);

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

  /** Remember the shapes as they are, so Undo can come back to them. */
  function remember(list = shapesRef.current) {
    history.current.push(list);
    if (history.current.length > UNDO_STEPS) history.current.shift();
    setUndoCount(history.current.length);
  }

  function undo() {
    const previous = history.current.pop();
    setUndoCount(history.current.length);
    if (!previous) return;
    setShapes(previous);
    save(previous);
    if (selected && !previous.some((s) => keyOf(s) === selected)) setSelected(null);
  }

  /** A change made in one go (add, delete, flip, a toolbar step, a backrest): undoable. */
  function update(next) {
    remember();
    setShapes(next);
    save(next);
  }

  function setShowButtonsRemembered(on) {
    setShowButtons(on);
    try {
      window.localStorage.setItem(SHOW_BUTTONS_KEY, on ? "1" : "0");
    } catch {
      // storage unavailable: the choice lasts for this visit
    }
  }

  async function enterFullscreen() {
    setFullscreen(true);
    if (size && size.w > size.h && window.innerHeight > window.innerWidth) setRotateHint(true);
    const el = wrapRef.current;
    try {
      if (el?.requestFullscreen) {
        await el.requestFullscreen();
        nativeFullscreen.current = true;
      } else if (el?.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
        nativeFullscreen.current = true;
      }
    } catch {
      // not allowed here (e.g. iPhone Safari): the full-viewport overlay is used instead
    }
  }

  function exitFullscreen() {
    setFullscreen(false);
    setRotateHint(false);
    setFit(null);
    if (nativeFullscreen.current) {
      nativeFullscreen.current = false;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) exit.call(document);
    }
  }

  const aspect = size ? size.w / size.h : 1;

  function widthFtOf(key) {
    return attempt ? piecesOf(attempt.items).find((p) => p.key === key)?.width_ft : null;
  }

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

  /** Would `shape` with these `points` stay on the photo (2% margin) — every
   * corner, a curved sofa's whole arcs, and the raised top of its 3D box? */
  function fitsOnPhoto(shape, points) {
    const piece = attempt ? piecesOf(attempt.items).find((p) => p.key === keyOf(shape)) : null;
    return Boolean(points) && shapeFits(shape, points, aspect, piece?.width_ft, guideStyle === "boxes", piece?.seating ?? true);
  }

  /** New points for a shape; any that would leave the photo are ignored, so
   * every move, resize, turn, tilt and bend stops at the last valid position.
   * A shape saved before this check that pokes out already may still move,
   * so it can be brought back onto the photo. */
  function setShapePoints(key, points) {
    const shape = shapesRef.current.find((s) => keyOf(s) === key);
    if (!shape || !points) return;
    if (!fitsOnPhoto(shape, points) && fitsOnPhoto(shape, shape.points)) return;
    setShapes((prev) => prev.map((s) => (keyOf(s) === key ? { ...s, points } : s)));
  }

  function startGesture() {
    const shape = shapesRef.current.find((s) => keyOf(s) === selected);
    const [a, b] = [...pointers.current.values()];
    if (!shape || !a || !b) return;
    drag.current = null;
    const v = polar(toPhoto(...a), toPhoto(...b));
    remember();
    gesture.current = {
      key: selected,
      orig: shape.points,
      kind: shape.kind,
      widthFt: widthFtOf(selected),
      deg: v.deg,
      dist: Math.max(v.dist, 1e-6),
    };
  }

  function onPointerDown(e) {
    e.preventDefault();
    svgRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.current.size === 2) {
      startGesture(); // second finger: pinch to resize, twist to turn on the floor
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
      if (t.role === "floorturn") {
        // dragging right swings the sofa's front toward the right of the picture
        Object.assign(drag.current, { kind: shape.kind, widthFt: widthFtOf(key), turnSign: floorTurnSign(shape) });
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
      // pinch resizes; twist turns the sofa on the floor, the same way the fingers turn
      const scaled = transformPoints(g.orig, v.dist / g.dist, 0, aspect);
      if (!scaled) return;
      const deg = snapAngle(v.deg - g.deg);
      const points = Math.abs(deg) < 0.01 ? scaled : turnOnFloor(scaled, g.kind, deg, aspect, g.widthFt);
      if (points) setShapePoints(g.key, points);
      return;
    }
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.clientX, e.clientY - d.clientY) < TAP_SLOP_PX) return;
    if (!d.moved && d.role !== "empty") remember(); // the shapes as they were before this drag
    d.moved = true;
    if (d.role === "empty") return;
    const at = toPhoto(e.clientX, e.clientY);
    if (d.role === "bend") {
      // a curved sofa: stronger or flatter, the front arc following
      const points = bendCurve(d.orig, at[0], at[1], aspect);
      if (points) setShapePoints(d.key, points);
    } else if (d.role === "floorturn") {
      // right swings the sofa's front toward the right of the picture, left toward the left
      const deg = snapAngle((at[0] - d.start[0]) * FLOOR_TURN_DEG_PER_WIDTH) * d.turnSign;
      const points = turnOnFloor(d.orig, d.kind, deg, aspect, d.widthFt);
      if (points) setShapePoints(d.key, points); // a turn that won't fit stops at the last one that did
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
      const shape = shapesRef.current.find((s) => keyOf(s) === d.key);
      if (shape) setShapePoints(d.key, moveShape(shape, d.orig, at[0] - d.start[0], at[1] - d.start[1]).points);
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
    if (e.type === "pointercancel") {
      if (d.moved && d.role !== "empty") save(shapesRef.current);
      return;
    }
    if (d.moved && d.role !== "empty") save(shapesRef.current);
    else if (!d.moved && d.role === "empty") setSelected(null); // tap on the photo: deselect
    else if (!d.moved && d.role === "edge") setBackrest(d.key, d.part, d.edge);
  }

  function setBackrest(key, part, edge) {
    const target = shapesRef.current.find((s) => keyOf(s) === key);
    if (!target || !backrestAllowed(target, part, edge) || target.backrest[part] === edge) return;
    update(
      shapesRef.current.map((s) => {
        if (keyOf(s) !== key) return s;
        const backrest = [...s.backrest];
        backrest[part] = edge;
        return { ...s, backrest };
      })
    );
  }

  function addShape(piece, index) {
    let shape = newShape(piece, index, aspect);
    // make it smaller until all of it (and its box top) is on the photo
    for (let i = 0; i < 12 && !fitsOnPhoto(shape, shape.points); i++) {
      const smaller = transformPoints(shape.points, 0.9, 0, aspect);
      if (!smaller) break;
      shape = { ...shape, points: smaller };
    }
    update([...shapes.filter((s) => keyOf(s) !== piece.key), shape]);
    setSelected(piece.key);
  }

  function removeShape(key) {
    update(shapes.filter((s) => keyOf(s) !== key));
    if (selected === key) setSelected(null);
  }

  function changeShape(key, fn) {
    const shape = shapes.find((s) => keyOf(s) === key);
    const next = shape ? fn(shape) : null;
    if (!next || !fitsOnPhoto(shape, next.points)) return; // a flip that won't fit doesn't happen
    update(shapes.map((s) => (keyOf(s) === key ? next : s)));
  }

  /** One toolbar step on the selected shape's points; nothing happens (and
   * nothing is remembered for Undo) when the step won't fit on the photo. */
  function step(fn) {
    const shape = shapesRef.current.find((s) => keyOf(s) === selected);
    if (!shape) return;
    const points = fn(shape);
    if (!fitsOnPhoto(shape, points)) return;
    update(shapesRef.current.map((s) => (keyOf(s) === selected ? { ...s, points } : s)));
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const pieces = piecesOf(attempt.items);
  const byKey = Object.fromEntries(shapes.map((s) => [keyOf(s), s]));
  const missing = pieces.filter((p) => !byKey[p.key]);
  const ready = pieces.length > 0 && missing.length === 0;
  const W = size?.w || 1;
  const H = size?.h || 1;
  const px = ([x, y]) => [x * W, y * H];
  const status = missing.length
    ? `${missing.length} ${missing.length === 1 ? "piece" : "pieces"} still to draw`
    : saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Not saved — check the connection"
        : "All pieces drawn";
  const selectedShape = selected ? byKey[selected] : null;
  const selectedPiece = selected ? pieces.find((p) => p.key === selected) : null;
  const numberOf = Object.fromEntries(pieces.map((p, i) => [p.key, i + 1]));

  /** Resize (bottom-right), rotate (above), tilt (left side) and turn on
   * floor (below) handles, outside the shape's bounding box but always kept
   * on the photo so they can be reached. */
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
    const [fw, fh] = [FLOOR_TURN_W * scale, FLOOR_TURN_H * scale];
    const floorTurn = [keep(midX, fw / 2, W), keep(maxY + HANDLE_GAP * scale + fh / 2, fh / 2, H)];
    return { resize, rotate, tilt, floorTurn, stickFrom: [midX, minY], rs, rr, tw, th, fw, fh };
  }

  const turnStep = (dir) =>
    step((s) => turnOnFloor(s.points, s.kind, dir * TURN_STEP_DEG * floorTurnSign(s), aspect, widthFtOf(keyOf(s))));

  const toolbar =
    selectedShape && showButtons ? (
      <div className="draw-toolbar" role="toolbar" aria-label="Selected piece">
        <div className="draw-toolbar-name">
          <span className="draw-swatch" style={{ background: COLOUR_HEX[selectedShape.colour] }} />
          {numberOf[selected]} · {selectedPiece?.label}
        </div>
        <div className="draw-toolbar-group" title="Turn on the floor">
          <span>Turn</span>
          <button type="button" onClick={() => turnStep(-1)} aria-label="Turn on the floor to the left">◀</button>
          <button type="button" onClick={() => turnStep(1)} aria-label="Turn on the floor to the right">▶</button>
        </div>
        <div className="draw-toolbar-group" title="Tilt">
          <span>Tilt</span>
          <button type="button" onClick={() => step((s) => tiltPoints(s.points, tiltFactor(-TILT_STEP), aspect))} aria-label="Lay flatter">▲</button>
          <button type="button" onClick={() => step((s) => tiltPoints(s.points, tiltFactor(TILT_STEP), aspect))} aria-label="Stand up">▼</button>
        </div>
        <div className="draw-toolbar-group" title="Size">
          <span>Size</span>
          <button type="button" onClick={() => step((s) => transformPoints(s.points, 1 / SIZE_STEP, 0, aspect, true))} aria-label="Smaller">−</button>
          <button type="button" onClick={() => step((s) => transformPoints(s.points, SIZE_STEP, 0, aspect, true))} aria-label="Bigger">+</button>
        </div>
        {selectedShape.kind !== "rect" ? (
          <div className="draw-toolbar-group">
            <button type="button" onClick={() => changeShape(selected, flipShape)} aria-label="Flip left and right">Flip ↔</button>
            <button type="button" onClick={() => changeShape(selected, flipShapeVertical)} aria-label="Flip up and down">Flip ↕</button>
          </div>
        ) : null}
        {selectedShape.kind === "L" ? (
          <button
            type="button"
            className="draw-toolbar-wide"
            onClick={() =>
              step((s) => moveLoungeToOtherEnd(s, aspect))
            }
          >
            Move lounge to other end
          </button>
        ) : null}
        <button type="button" className="draw-toolbar-delete" onClick={() => removeShape(selected)}>
          Delete
        </button>
      </div>
    ) : null;

  const tray = (
    <div className="draw-tray-row">
      <div className="draw-tray" role="list">
        {pieces.map((p, index) => (
          <button
            key={p.key}
            type="button"
            role="listitem"
            className={"draw-chip" + (p.key === selected ? " selected" : "") + (byKey[p.key] ? " placed" : "")}
            onClick={() => (byKey[p.key] ? setSelected(p.key) : addShape(p, index))}
            title={byKey[p.key] ? `Select ${p.name}` : `Place ${p.name}`}
          >
            <span className="draw-swatch" style={{ background: COLOUR_HEX[p.colour] }} />
            {index + 1} {p.label}
            {byKey[p.key] ? <span className="draw-chip-tick" aria-label="placed">✓</span> : null}
          </button>
        ))}
      </div>
      <div className="draw-tray-tools">
        {!fullscreen ? (
          <button type="button" className="btn btn-ghost btn-small" disabled={!undoCount} onClick={undo}>
            Undo
          </button>
        ) : null}
        <label className="draw-show-buttons">
          <input type="checkbox" checked={showButtons} onChange={(e) => setShowButtonsRemembered(e.target.checked)} />
          Show buttons
        </label>
        {!fullscreen ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={enterFullscreen}>
            Full screen
          </button>
        ) : null}
      </div>
    </div>
  );

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
      <h1 style={{ marginBottom: 12 }}>
        Draw on photo <span className="beta-tag">Beta</span>
      </h1>

      <div ref={wrapRef} className={"draw-wrap" + (fullscreen ? " fs" : "")}>
        {fullscreen ? (
          <div className="draw-fs-top">
            <button type="button" className="draw-fs-btn" disabled={!undoCount} onClick={undo}>
              Undo
            </button>
            <button type="button" className="draw-fs-btn draw-fs-done" onClick={exitFullscreen}>
              Done
            </button>
          </div>
        ) : null}

        <div ref={stageRef} className="draw-stage">
          <div className="draw-photo" style={fullscreen && fit ? { width: fit.w, height: fit.h } : undefined}>
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
                  if (s.kind === "curved") {
                    const { outline, back } = curvedOutline(s.points);
                    return (
                      <g key={key} className={"draw-shape" + (isSelected ? " selected" : "")}>
                        <polygon
                          data-role="move"
                          data-key={key}
                          points={outline.map((p) => px(p).join(",")).join(" ")}
                          fill={hex}
                          fillOpacity={0.45}
                          stroke={hex}
                          strokeWidth={(isSelected ? 3 : 1.5) * scale}
                          strokeLinejoin="round"
                        />
                        <polyline
                          points={back.map((p) => px(p).join(",")).join(" ")}
                          fill="none" stroke="#000" strokeWidth={9 * scale} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none"
                        />
                      </g>
                    );
                  }
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

                {/* on the draw screen only a number chip and a tiny LOUNGE tag; the guide image keeps the full labels */}
                {shapes.map((s) => {
                  const key = keyOf(s);
                  const drawn = s.kind === "curved" ? curvedOutline(s.points).outline : s.points;
                  const xs = drawn.map((p) => p[0]);
                  const top = Math.min(...drawn.map((p) => p[1]));
                  const r = NUMBER_R * scale;
                  const cx = Math.min(Math.max(((Math.min(...xs) + Math.max(...xs)) / 2) * W, r), W - r);
                  const cy = Math.min(Math.max(top * H - r - 4 * scale, r), H - r);
                  const lounge = s.kind === "L" && s.lounge != null ? centroid(shapeParts(s.kind, s.points)[s.lounge]) : null;
                  return (
                    <g key={`tag-${key}`} pointerEvents="none">
                      {lounge ? <SmallTag text="LOUNGE" at={px(lounge)} font={8 * scale} W={W} H={H} /> : null}
                      <circle cx={cx} cy={cy} r={r} fill={COLOUR_HEX[s.colour]} stroke="#fff" strokeWidth={2 * scale} />
                      <text x={cx} y={cy} className="draw-number" fontSize={12 * scale} textAnchor="middle" dominantBaseline="central">
                        {numberOf[key]}
                      </text>
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
                          <g className="draw-floorturn">
                            <rect
                              data-role="floorturn" data-key={key}
                              x={h.floorTurn[0] - h.fw / 2} y={h.floorTurn[1] - h.fh / 2} width={h.fw} height={h.fh} rx={h.fh / 2}
                              fill="#fff" stroke={hex} strokeWidth={3 * scale}
                            />
                            <text x={h.floorTurn[0]} y={h.floorTurn[1]} fontSize={17 * scale} textAnchor="middle" dominantBaseline="central" fill="#111" pointerEvents="none">
                              ↶↷
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
                          {selectedShape.kind === "curved"
                            ? (() => {
                                const [bx, by] = px(selectedShape.points[4]);
                                return (
                                  <g className="draw-bend">
                                    <circle data-role="bend" data-key={key} cx={bx} cy={by} r={BEND_R * scale} fill="#fff" stroke={hex} strokeWidth={3 * scale} />
                                    <text x={bx} y={by} fontSize={16 * scale} textAnchor="middle" dominantBaseline="central" fill="#111" pointerEvents="none">
                                      ⌒
                                    </text>
                                  </g>
                                );
                              })()
                            : null}
                        </g>
                      );
                    })()
                  : null}
              </svg>
            ) : null}
          </div>
          {fullscreen && rotateHint ? <div className="draw-rotate-hint">Turn your phone sideways for a bigger view</div> : null}
        </div>

        {toolbar}
        {tray}
      </div>

      <StepFooter
        backTo={adjust.backTo || `/attempt/${id}/placement`}
        status={status}
        primaryLabel="Next"
        primaryDisabled={!ready || saveState === "saving"}
        onPrimary={() => navigate(`/attempt/${id}/preview${adjust.query ? `?${adjust.query}` : ""}`)}
      />
    </div>
  );
}
