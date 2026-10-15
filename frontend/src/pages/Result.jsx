import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { FixSheet } from "../components/FixSheet.jsx";
import { roomLookLabel } from "../utils.js";
import { SafeImg } from "../components/SafeImg.jsx";
import { DebugPanel } from "../components/DebugPanel.jsx";
import { useAuth } from "../auth.jsx";

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
  const [shownId, setShownId] = useState(null); // which of the attempt's pictures is on screen; null = the latest
  const [showFix, setShowFix] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [fixThis, setFixThis] = useState(false); // the shop's "fix_this" switch
  const [showDebugSwitch, setShowDebugSwitch] = useState(false); // the shop's "show_debug" switch
  const [debugOpen, setDebugOpen] = useState(false);
  const { user } = useAuth();

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setFixThis(Boolean(data.features?.fix_this));
      setShowDebugSwitch(Boolean(data.features?.show_debug));
      setShowingAfter(true);
      setShownId(null);
      const roomData = await api.get(`/api/rooms/${data.attempt.room.id}`);
      // numbered like the room page: only attempts that produced a picture count
      const sorted = roomData.attempts.filter((a) => a.latest_render).sort((a, b) => a.id - b.id);
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

  /** The picture on screen: the latest unless another version was tapped. */
  function shownRender() {
    const renders = attempt?.renders || [];
    return renders.find((r) => r.id === shownId) || renders[renders.length - 1] || null;
  }

  async function handleFix(choices) {
    const render = shownRender();
    if (!render) return;
    setFixing(true);
    try {
      const data = await api.post(`/api/renders/${render.id}/fix`, { json: choices });
      navigate(`/attempt/${id}/generating`, {
        state: { jobId: data.job_id, startedAt: Date.now(), fix: { renderId: render.id, choices } },
      });
    } catch (err) {
      toast(err.message);
      setFixing(false);
    }
  }

  async function handlePick() {
    const render = shownRender();
    if (!render) return;
    setPicking(true);
    try {
      await api.post(`/api/renders/${render.id}/pick`);
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
    const renderUrl = shownRender()?.image_url;
    if (!renderUrl) return;
    try {
      const file = await renderToFile(renderUrl);
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Reflection Lifestyle - AI",
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
    const renderUrl = shownRender()?.image_url;
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

  const shown = shownRender();
  const renderUrl = shown?.image_url;
  const imgUrl = showingAfter && renderUrl ? renderUrl : attempt.room.photo_url;
  const versions = attempt.renders || [];
  // a fix of a fix of a fix: small edits have stopped paying off
  const deepFix = (shown?.fix_depth || 0) >= (attempt.fix_hint_depth || 3);

  return (
    <div className="screen">
      <TopBar
        backTo={`/customer/${attempt.room.customer_id}`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: `Attempt ${number}` },
        ]}
      />
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

      <div className="result-layout">
      <div className="result-main">
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

      {versions.length > 1 ? (
        <div className="result-versions">
          {versions.map((v, i) => (
            <button
              key={v.id}
              type="button"
              className={"result-version" + (shown && v.id === shown.id ? " active" : "")}
              onClick={() => {
                setShownId(v.id);
                setShowingAfter(true);
              }}
            >
              <SafeImg src={v.image_url} />
              <span>{v.parent_render_id ? "Fix" : `Picture ${i + 1}`}</span>
            </button>
          ))}
        </div>
      ) : null}

      </div>

      <div className="result-side">
      <div className="summary-box">
        <div>
          <span className="mono muted">Look</span>
          <span className="mono">{roomLookLabel(attempt.room_treatment)}</span>
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
        <button type="button" className="btn btn-ghost" disabled={!renderUrl} onClick={handleSave}>
          Save to phone
        </button>
        <div className="row2">
          {fixThis ? (
            <button type="button" className="btn btn-ghost" disabled={!renderUrl} onClick={() => setShowFix(true)}>
              Fix this
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => navigate(`/attempt/${id}/adjust`)}>
            Adjust &amp; try again
          </button>
        </div>
        {fixThis && deepFix ? <div className="fix-hint">For bigger changes, use Adjust &amp; try again.</div> : null}
        {(showDebugSwitch || user?.role === "superadmin") && shown ? (
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDebugOpen((v) => !v)}>
              {debugOpen ? "Hide debug" : "Debug"}
            </button>
            {debugOpen ? <DebugPanel renderId={shown.id} /> : null}
          </>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-star"
          disabled={!renderUrl || attempt.is_picked || picking}
          onClick={handlePick}
        >
          {attempt.is_picked ? "★ Picked" : picking ? "Marking…" : "★ Mark as picked"}
        </button>
      </div>

      </div>
      </div>

      {showFix ? (
        <FixSheet items={attempt.items} deep={deepFix} busy={fixing} onClose={() => setShowFix(false)} onSubmit={handleFix} />
      ) : null}

      {zoom ? (
        <div className="zoom-overlay" onClick={() => setZoom(false)}>
          <img src={imgUrl} alt="" />
        </div>
      ) : null}
    </div>
  );
}
