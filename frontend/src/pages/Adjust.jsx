import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { IMAGE_ACCEPT, debugLog, normalizeToJpeg, photoUploadError, roomLookLabel } from "../utils.js";

/** "Adjust & try again" for a finished attempt. Nothing is created here: the
 * Furniture, Placement and Finishing steps open on this same attempt and save
 * their changes to it. Only "Generate again" makes a new attempt — a copy of
 * what is set here — and generates it from scratch (POST .../generate-new).
 * Backing out without generating leaves nothing new behind. */
export default function Adjust() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [number, setNumber] = useState(null);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const fileInputRef = useRef(null);

  async function init() {
    setError(null);
    try {
      const current = (await api.get(`/api/attempts/${id}`)).attempt;
      const roomData = await api.get(`/api/rooms/${current.room.id}`);
      // numbered the way the room page numbers them: finished attempts only
      const finished = roomData.attempts.filter((a) => a.latest_render).sort((a, b) => a.id - b.id);
      const index = finished.findIndex((a) => a.id === current.id);
      setNumber(index >= 0 ? index + 1 : null);
      setAttempt(current);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function openStep(step) {
    // ?adjust tells the step to come back here
    navigate(`/attempt/${id}/${step}?adjust=${id}`);
  }

  async function handleRoomPhotoChange(e) {
    const picked = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!picked) return;
    setUploadingPhoto(true);
    setPreparingPhoto(true);
    let jpeg;
    try {
      jpeg = await normalizeToJpeg(picked);
    } catch (err) {
      toast(err.message);
      setPreparingPhoto(false);
      setUploadingPhoto(false);
      return;
    }
    setPreparingPhoto(false);
    try {
      const form = new FormData();
      form.append("photo", jpeg);
      const data = await api.post(`/api/rooms/${attempt.room.id}/photo`, { form });
      debugLog("upload OK");
      setAttempt((prev) => (prev ? { ...prev, room: { ...prev.room, photo_url: data.room.photo_url } } : prev));
      toast("Room photo updated.");
    } catch (err) {
      debugLog(`upload FAIL ${err.message}`);
      toast(photoUploadError(err));
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleGenerateAgain() {
    setGenerating(true);
    try {
      // the new attempt is created only now, and generated from scratch
      const data = await api.post(`/api/attempts/${id}/generate-new`);
      navigate(`/attempt/${data.attempt_id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setGenerating(false);
    }
  }

  if (error) return <div className="screen screen-narrow"><ErrorBlock message={error} onRetry={init} /></div>;
  if (!attempt) return <div className="screen screen-narrow"><Loading /></div>;

  return (
    <div className="screen screen-narrow">
      <TopBar
        backTo={`/attempt/${id}/result`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Adjust</div>
      <h1 style={{ marginBottom: 16 }}>Adjust &amp; try again</h1>

      <div className="adjust-note">
        Change only what you need on {number ? `Attempt ${number}` : "this attempt"}. &ldquo;Generate again&rdquo; makes a
        new attempt from these settings.
      </div>

      <button type="button" className="adjust-row" disabled={generating} onClick={() => openStep("furniture")}>
        <span>
          Furniture
          <div className="sub">
            {attempt.items.length} piece{attempt.items.length === 1 ? "" : "s"}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button
        type="button"
        className="adjust-row"
        disabled={generating}
        onClick={() => openStep(attempt.placement_mode === "shapes" ? "draw" : "place")}
      >
        <span>
          Placement
          <div className="sub">
            {attempt.placement_mode === "shapes"
              ? attempt.shapes?.shapes?.length
                ? "drawn on photo"
                : "not drawn yet"
              : attempt.items.some((it) => it.placement && it.placement.length)
                ? "placed"
                : "not placed"}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" disabled={generating} onClick={() => openStep("finish")}>
        <span>
          Finishing
          <div className="sub">
            {roomLookLabel(attempt.room_treatment)} &middot; {attempt.lighting.toUpperCase()}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button
        type="button"
        className="adjust-row"
        disabled={generating || uploadingPhoto}
        onClick={() => {
          // open the picker straight away (phones need the tap itself)
          debugLog("input clicked");
          fileInputRef.current.click();
        }}
      >
        <span>
          Room photo
          <div className="sub">{preparingPhoto ? "preparing photo…" : uploadingPhoto ? "uploading…" : "tap to replace"}</div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <input ref={fileInputRef} type="file" accept={IMAGE_ACCEPT} className="visually-hidden" onChange={handleRoomPhotoChange} />

      <button type="button" className="btn btn-primary" style={{ marginTop: 20 }} disabled={generating} onClick={handleGenerateAgain}>
        {generating ? "Starting…" : "Generate again"}
      </button>
    </div>
  );
}
