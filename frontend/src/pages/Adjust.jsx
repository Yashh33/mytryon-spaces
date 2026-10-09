import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { IMAGE_ACCEPT, debugLog, normalizeToJpeg } from "../utils.js";

export default function Adjust() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [sourceNumber, setSourceNumber] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const clonedRef = useRef(false);
  const fileInputRef = useRef(null);

  async function init() {
    setError(null);
    try {
      const sourceData = await api.get(`/api/attempts/${id}`);
      const source = sourceData.attempt;
      const roomData = await api.get(`/api/rooms/${source.room.id}`);
      const sorted = [...roomData.attempts].sort((a, b) => a.id - b.id);
      setSourceNumber(sorted.findIndex((a) => a.id === source.id) + 1);

      if (!clonedRef.current) {
        clonedRef.current = true;
        const cloned = await api.post(`/api/rooms/${source.room.id}/attempts`, {
          json: { clone_from_attempt_id: source.id },
        });
        setDraft(cloned.attempt);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleRoomPhotoChange(e) {
    const picked = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!picked || !draft) return;
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
      const data = await api.post(`/api/rooms/${draft.room.id}/photo`, { form });
      debugLog("upload OK");
      setDraft((d) => ({ ...d, room: { ...d.room, photo_url: data.room.photo_url } }));
      toast("Room photo updated.");
    } catch (err) {
      debugLog(`upload FAIL ${err.message}`);
      toast(err.message);
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function handleGenerateAgain() {
    if (!draft) return;
    setGenerating(true);
    try {
      const data = await api.post(`/api/attempts/${draft.id}/generate`);
      navigate(`/attempt/${draft.id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setGenerating(false);
    }
  }

  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={init} /></div>;
  if (!draft || sourceNumber == null) return <div className="screen"><Loading label="Preparing a new attempt…" /></div>;

  return (
    <div className="screen">
      <TopBar
        backTo={`/attempt/${id}/result`}
        crumbs={[
          { label: draft.room.customer_name, to: `/customer/${draft.room.customer_id}` },
          { label: draft.room.room_type, to: `/room/${draft.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Adjust</div>
      <h1 style={{ marginBottom: 16 }}>Adjust &amp; try again</h1>

      <div className="adjust-note">Everything is carried over from Attempt {sourceNumber}. Change only what you need.</div>

      <button type="button" className="adjust-row" onClick={() => navigate(`/attempt/${draft.id}/furniture`)}>
        <span>
          Furniture
          <div className="sub">
            {draft.items.length} piece{draft.items.length === 1 ? "" : "s"}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" onClick={() => navigate(`/attempt/${draft.id}/place`)}>
        <span>
          Placement
          <div className="sub">{draft.items.some((it) => it.placement && it.placement.length) ? "placed" : "not placed"}</div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" onClick={() => navigate(`/attempt/${draft.id}/finish`)}>
        <span>
          Finishing
          <div className="sub">
            {draft.room_treatment.toUpperCase()} &middot; {draft.lighting.toUpperCase()}
          </div>
        </span>
        <span className="chevron">&#8250;</span>
      </button>
      <button type="button" className="adjust-row" disabled={uploadingPhoto} onClick={() => {
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
