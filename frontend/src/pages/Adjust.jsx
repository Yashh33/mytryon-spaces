import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { IMAGE_ACCEPT, debugLog, normalizeToJpeg, roomLookLabel } from "../utils.js";

/** "Adjust & try again" for a finished attempt (the source). Opening this
 * screen creates nothing: it shows the source's values. The copy to work on
 * (the draft) is made on the first real action, and its id is kept in the
 * URL as ?draft=, so coming back from a sub-screen or refreshing reuses that
 * same draft instead of making another. */
export default function Adjust() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const draftParam = searchParams.get("draft");
  const navigate = useNavigate();
  const toast = useToast();
  const [source, setSource] = useState(null);
  const [sourceNumber, setSourceNumber] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const cloning = useRef(null); // the in-flight clone request, so two quick taps make one draft
  const fileInputRef = useRef(null);

  async function init() {
    setError(null);
    try {
      const src = (await api.get(`/api/attempts/${id}`)).attempt;
      const roomData = await api.get(`/api/rooms/${src.room.id}`);
      // numbered the way the room page numbers them: finished attempts only
      const finished = roomData.attempts.filter((a) => a.latest_render).sort((a, b) => a.id - b.id);
      const index = finished.findIndex((a) => a.id === src.id);
      setSourceNumber(index >= 0 ? index + 1 : null);
      setSource(src);

      if (draftParam) {
        try {
          const existing = (await api.get(`/api/attempts/${draftParam}`)).attempt;
          // only a not-yet-generated attempt of this same room is still a draft
          if (existing.room.id === src.room.id && existing.renders.length === 0) setDraft(existing);
        } catch {
          // gone or not ours: carry on without it, a new one is made when needed
        }
      }
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** The draft to act on, created (once) if this is the first real action. */
  async function ensureDraft() {
    if (draft) return draft;
    if (!cloning.current) {
      cloning.current = api
        .post(`/api/rooms/${source.room.id}/attempts`, { json: { clone_from_attempt_id: source.id } })
        .then((res) => {
          setDraft(res.attempt);
          navigate(`/attempt/${id}/adjust?draft=${res.attempt.id}`, { replace: true });
          return res.attempt;
        })
        .finally(() => {
          cloning.current = null;
        });
    }
    return cloning.current;
  }

  async function openStep(step) {
    setBusy(true);
    try {
      const d = await ensureDraft();
      // ?adjust tells the step to come back here, with the draft in the URL
      navigate(`/attempt/${d.id}/${step}?adjust=${id}`);
    } catch (err) {
      toast(err.message);
      setBusy(false);
    }
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
      const d = await ensureDraft();
      const form = new FormData();
      form.append("photo", jpeg);
      const data = await api.post(`/api/rooms/${d.room.id}/photo`, { form });
      debugLog("upload OK");
      setDraft((prev) => (prev ? { ...prev, room: { ...prev.room, photo_url: data.room.photo_url } } : prev));
      toast("Room photo updated.");
    } catch (err) {
      debugLog(`upload FAIL ${err.message}`);
      toast(err.message);
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleGenerateAgain() {
    setGenerating(true);
    try {
      const d = await ensureDraft();
      const data = await api.post(`/api/attempts/${d.id}/generate`);
      navigate(`/attempt/${d.id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setGenerating(false);
    }
  }

  if (error) return <div className="screen screen-narrow"><ErrorBlock message={error} onRetry={init} /></div>;
  if (!source) return <div className="screen screen-narrow"><Loading /></div>;

  const shown = draft || source; // the source's own values until a draft exists
  const locked = busy || generating;

  return (
    <div className="screen screen-narrow">
      <TopBar
        backTo={`/attempt/${id}/result`}
        crumbs={[
          { label: shown.room.customer_name, to: `/customer/${shown.room.customer_id}` },
          { label: shown.room.room_type, to: `/room/${shown.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Adjust</div>
      <h1 style={{ marginBottom: 16 }}>Adjust &amp; try again</h1>

      <div className="adjust-note">
        Everything is carried over from {sourceNumber ? `Attempt ${sourceNumber}` : "this attempt"}. Change only what you need.
      </div>

      <button type="button" className="adjust-row" disabled={locked} onClick={() => openStep("furniture")}>
        <span>
          Furniture
          <div className="sub">
            {shown.items.length} piece{shown.items.length === 1 ? "" : "s"}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" disabled={locked} onClick={() => openStep("place")}>
        <span>
          Placement
          <div className="sub">{shown.items.some((it) => it.placement && it.placement.length) ? "placed" : "not placed"}</div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" disabled={locked} onClick={() => openStep("finish")}>
        <span>
          Finishing
          <div className="sub">
            {roomLookLabel(shown.room_treatment)} &middot; {shown.lighting.toUpperCase()}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button
        type="button"
        className="adjust-row"
        disabled={locked || uploadingPhoto}
        onClick={() => {
          // open the picker straight away (phones need the tap itself); the
          // draft is only made once a photo has actually been chosen
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

      <button type="button" className="btn btn-primary" style={{ marginTop: 20 }} disabled={locked} onClick={handleGenerateAgain}>
        {generating ? "Starting…" : "Generate again"}
      </button>
    </div>
  );
}
