import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";

export default function Result() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [number, setNumber] = useState(null);
  const [showingAfter, setShowingAfter] = useState(true);
  const [zoom, setZoom] = useState(false);
  const [picking, setPicking] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setShowingAfter(true);
      const roomData = await api.get(`/api/rooms/${data.attempt.room.id}`);
      const sorted = [...roomData.attempts].sort((a, b) => a.id - b.id);
      const idx = sorted.findIndex((a) => a.id === data.attempt.id);
      setNumber(idx + 1);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handlePick() {
    if (!attempt.latest_render) return;
    setPicking(true);
    try {
      await api.post(`/api/renders/${attempt.latest_render.id}/pick`);
      setAttempt((a) => ({ ...a, is_picked: true }));
      toast("Marked as picked.");
    } catch (err) {
      toast(err.message);
    } finally {
      setPicking(false);
    }
  }

  async function renderToFile(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return new File([blob], "reflection-render.jpg", { type: blob.type || "image/jpeg" });
  }

  async function handleShare() {
    const renderUrl = attempt.latest_render?.image_url;
    if (!renderUrl) return;
    try {
      const file = await renderToFile(renderUrl);
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Reflection Lifestyle",
          text: `${attempt.room.customer_name} — ${attempt.room.room_type}`,
        });
        return;
      }
      await handleSave();
      toast("Saved — attach it in WhatsApp manually.");
    } catch (err) {
      if (err?.name !== "AbortError") toast("Couldn't share the image. Please try again.");
    }
  }

  async function handleSave() {
    const renderUrl = attempt.latest_render?.image_url;
    if (!renderUrl) return;
    try {
      const file = await renderToFile(renderUrl);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reflection-render.jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      toast("Couldn't save the image. Please try again.");
    }
  }

  if ((!attempt || number == null) && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const renderUrl = attempt.latest_render?.image_url;
  const imgUrl = showingAfter && renderUrl ? renderUrl : attempt.room.photo_url;

  return (
    <div className="screen">
      <TopBar backTo={`/room/${attempt.room.id}`} />
      <div className="result-header">
        <div>
          <div className="eyebrow">
            {attempt.room.customer_name} &middot; {attempt.room.room_type}
          </div>
          <h1>
            Attempt {number}
            {attempt.is_picked ? " ★" : ""}
          </h1>
        </div>
      </div>

      <div className="result-image-wrap" onClick={() => renderUrl && setZoom(true)}>
        <img src={imgUrl} alt="" />
      </div>

      {renderUrl ? (
        <div className="toggle-row">
          <button type="button" className={"toggle-btn" + (!showingAfter ? " active" : "")} onClick={() => setShowingAfter(false)}>
            Before
          </button>
          <button type="button" className={"toggle-btn" + (showingAfter ? " active" : "")} onClick={() => setShowingAfter(true)}>
            After
          </button>
        </div>
      ) : (
        <p className="muted" style={{ marginTop: 14 }}>
          No render yet.
        </p>
      )}

      <div className="summary-box">
        <div>
          <span className="mono muted">Look</span>
          <span className="mono">{attempt.room_treatment}</span>
        </div>
        <div>
          <span className="mono muted">Lighting</span>
          <span className="mono">{attempt.lighting}</span>
        </div>
        {attempt.items.map((it) => (
          <div key={it.id}>
            <span>
              {it.category} &middot; {it.type}
            </span>
            <span className="mono">{it.width_ft}ft</span>
          </div>
        ))}
      </div>

      <div className="result-actions">
        <button type="button" className="btn btn-whatsapp" disabled={!renderUrl} onClick={handleShare}>
          Send on WhatsApp
        </button>
        <div className="row2">
          <button type="button" className="btn btn-ghost" disabled={!renderUrl} onClick={handleSave}>
            Save to phone
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => navigate(`/attempt/${id}/adjust`)}>
            Adjust &amp; try again
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-star"
          disabled={!renderUrl || attempt.is_picked || picking}
          onClick={handlePick}
        >
          {attempt.is_picked ? "★ Picked" : picking ? "Marking…" : "★ Mark as picked"}
        </button>
      </div>

      {zoom ? (
        <div className="zoom-overlay" onClick={() => setZoom(false)}>
          <img src={imgUrl} alt="" />
        </div>
      ) : null}
    </div>
  );
}
