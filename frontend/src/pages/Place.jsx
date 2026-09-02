import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";

const STROKE_COLORS = ["#F07522", "#2563EB", "#16A34A", "#9333EA"];

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

export default function Place() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const imgRef = useRef(null);
  const canvasRef = useRef(null);
  const activeStrokeRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const attemptRef = useRef(null);
  const selectedIdRef = useRef(null);

  useEffect(() => {
    attemptRef.current = attempt;
  }, [attempt]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      if (data.attempt.items.length) {
        setSelectedId((prev) => (prev && data.attempt.items.some((it) => it.id === prev) ? prev : data.attempt.items[0].id));
      }
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function drawPath(ctx, points, rect, color, width) {
    if (!points.length) return;
    if (points.length === 1) {
      const p = points[0];
      ctx.beginPath();
      ctx.arc(p.x * rect.width, p.y * rect.height, width / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    points.forEach((p, i) => {
      const px = p.x * rect.width;
      const py = p.y * rect.height;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  function redraw() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    const current = attemptRef.current;
    if (!img || !canvas || !current) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, rect.width, rect.height);
    const strokeWidth = rect.width * 0.015;
    current.items.forEach((it, i) => {
      const color = STROKE_COLORS[i % STROKE_COLORS.length];
      (it.strokes || []).forEach((stroke) => drawPath(ctx, stroke, rect, color, strokeWidth));
    });
    if (activeStrokeRef.current && activeStrokeRef.current.length) {
      const idx = current.items.findIndex((it) => it.id === selectedIdRef.current);
      drawPath(ctx, activeStrokeRef.current, rect, STROKE_COLORS[(idx < 0 ? 0 : idx) % STROKE_COLORS.length], strokeWidth);
    }
  }

  function sizeCanvas() {
    const img = imgRef.current;
    const canvas = canvasRef.current;
    if (!img || !canvas) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setupCanvas() {
    sizeCanvas();
    redraw();
  }

  useEffect(() => {
    if (!attempt) return undefined;
    const img = imgRef.current;
    function onImgLoad() {
      setupCanvas();
    }
    if (img.complete) setupCanvas();
    else img.addEventListener("load", onImgLoad, { once: true });

    window.addEventListener("resize", setupCanvas);
    return () => {
      img.removeEventListener("load", onImgLoad);
      window.removeEventListener("resize", setupCanvas);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  async function addStroke(itemId, points) {
    try {
      const data = await api.post(`/api/attempts/${id}/items/${itemId}/strokes`, { json: { points } });
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
      redraw();
    }
  }

  async function handleUndo() {
    if (selectedId == null) return;
    try {
      const data = await api.post(`/api/attempts/${id}/items/${selectedId}/strokes/undo`);
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
    }
  }

  async function handleClear() {
    if (selectedId == null) return;
    try {
      const data = await api.del(`/api/attempts/${id}/items/${selectedId}/strokes`);
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
    }
  }

  function handlePointerDown(e) {
    if (selectedIdRef.current == null) return;
    activePointerIdRef.current = e.pointerId;
    canvasRef.current.setPointerCapture(e.pointerId);
    const rect = imgRef.current.getBoundingClientRect();
    activeStrokeRef.current = [
      {
        x: clamp01((e.clientX - rect.left) / rect.width),
        y: clamp01((e.clientY - rect.top) / rect.height),
      },
    ];
    redraw();
  }

  function handlePointerMove(e) {
    if (activeStrokeRef.current == null || e.pointerId !== activePointerIdRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = clamp01((e.clientX - rect.left) / rect.width);
    const y = clamp01((e.clientY - rect.top) / rect.height);
    const last = activeStrokeRef.current[activeStrokeRef.current.length - 1];
    const dx = (x - last.x) * rect.width;
    const dy = (y - last.y) * rect.height;
    if (Math.hypot(dx, dy) < 2) return;
    activeStrokeRef.current.push({ x, y });
    redraw();
  }

  function handlePointerUp(e) {
    if (activeStrokeRef.current == null || e.pointerId !== activePointerIdRef.current) return;
    const points = activeStrokeRef.current;
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    addStroke(selectedIdRef.current, points);
  }

  function handlePointerCancel() {
    activeStrokeRef.current = null;
    activePointerIdRef.current = null;
    redraw();
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo={`/attempt/${id}/furniture`} />
      <div className="eyebrow">Step 3 of 4</div>
      <h1 style={{ marginBottom: 14 }}>Where does each piece go?</h1>

      <div className="place-photo-wrap">
        <img ref={imgRef} src={attempt.room.photo_url} alt="Room" draggable="false" />
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" className="btn btn-ghost btn-small" style={{ flex: 1 }} onClick={handleUndo}>
          Undo
        </button>
        <button type="button" className="btn btn-ghost btn-small" style={{ flex: 1 }} onClick={handleClear}>
          Clear
        </button>
      </div>

      <div className="hint-line" style={{ textAlign: "center" }}>
        Select a piece, then draw where it goes
      </div>

      <div className="chips" style={{ marginTop: 14 }}>
        {attempt.items.map((it, i) => (
          <button
            key={it.id}
            type="button"
            className={"chip" + (it.id === selectedId ? " selected" : "")}
            onClick={() => setSelectedId(it.id)}
          >
            <span className="chip-dot" style={{ background: STROKE_COLORS[i % STROKE_COLORS.length] }} />
            {i + 1} &middot; {it.category}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}>
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/attempt/${id}/finish`)}>
          Next
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate(`/attempt/${id}/finish?ignore_placement=true`)}>
          Skip placement
        </button>
      </div>
    </div>
  );
}
