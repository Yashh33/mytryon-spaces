import { useEffect, useId, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { useAdjustMode } from "../adjustMode.js";
import { IMAGE_ACCEPT, normalizeToJpeg, photoUploadError } from "../utils.js";

// the looks offered; an attempt saved with another (an older "warm" or "minimal") shows as Keep
const ROOM_TREATMENTS = [
  { value: "keep", label: "Keep room as it is", desc: "Same walls, floor and decor – only the furniture is added" },
  { value: "luxury", label: "Luxury", desc: "Deep tones, marble, brass, rich finishes" },
];
const LIGHTINGS = [
  { value: "warm", label: "Warm", desc: "Soft golden tones, cosy evening feel" },
  { value: "daylight", label: "Daylight", desc: "Bright, natural light from the windows" },
  { value: "studio", label: "Studio", desc: "Even, clean showroom light" },
];
const NOTE_MAX = 1000;

const shownLook = (value) => (ROOM_TREATMENTS.some((o) => o.value === value) ? value : "keep");

/** "Fabric (optional)": one fabric photo for the whole room. "Capture fabric"
 * opens the camera, "Upload fabric" the gallery / file picker; both prepare
 * the photo the same way as every other photo upload (normalizeToJpeg). With
 * a photo: its thumbnail, "Change" and "Remove". */
function FabricSection({ fabricUrl, pieceCount, busy, onAdd, onRemove }) {
  const cameraId = useId();
  const galleryId = useId();
  const [changing, setChanging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState(null);

  async function handleFile(e) {
    const picked = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!picked || preparing) return;
    setError(null);
    setPreparing(true);
    try {
      const file = await normalizeToJpeg(picked);
      setChanging(false);
      await onAdd(file);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreparing(false);
    }
  }

  const working = busy || preparing;
  const showButtons = !fabricUrl || changing;
  return (
    <div className="field">
      <label>Fabric (optional)</label>
      {fabricUrl ? (
        <div className="fabric-current">
          <a href={fabricUrl} target="_blank" rel="noreferrer" className="fabric-thumb">
            <img src={fabricUrl} alt="Fabric" />
          </a>
          <div className="fabric-actions">
            <button type="button" className="btn btn-ghost btn-small" disabled={working} onClick={() => setChanging((v) => !v)}>
              Change
            </button>
            <button type="button" className="btn btn-ghost btn-small" disabled={working} onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      ) : null}
      {showButtons ? (
        <div className="fabric-buttons">
          <label htmlFor={cameraId} className={"btn btn-ghost btn-small" + (working ? " disabled" : "")} aria-disabled={working}>
            Capture fabric
          </label>
          <input id={cameraId} type="file" accept={IMAGE_ACCEPT} capture="environment" className="visually-hidden" disabled={working} onChange={handleFile} />
          <label htmlFor={galleryId} className={"btn btn-ghost btn-small" + (working ? " disabled" : "")} aria-disabled={working}>
            Upload fabric
          </label>
          <input id={galleryId} type="file" accept={IMAGE_ACCEPT} className="visually-hidden" disabled={working} onChange={handleFile} />
        </div>
      ) : null}
      <div className="hint-line">
        {working ? "Saving the fabric…" : pieceCount === 1 ? "Applied to your sofa" : "Applied to all sofas in this room"}
      </div>
      {error ? <div className="hint-line" style={{ color: "#c0392b" }}>{error}</div> : null}
    </div>
  );
}

export default function Finish() {
  const { id } = useParams();
  const adjust = useAdjustMode(id); // set when opened from "Adjust & try again"
  const [searchParams] = useSearchParams();
  const ignorePlacement = searchParams.get("ignore_placement") === "true";
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [roomTreatment, setRoomTreatment] = useState("keep");
  const [lighting, setLighting] = useState("warm");
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);
  const [savingFabric, setSavingFabric] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setRoomTreatment(shownLook(data.attempt.room_treatment));
      setLighting(data.attempt.lighting || "warm");
      setNote(data.attempt.note || "");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function addFabric(file) {
    setSavingFabric(true);
    const form = new FormData();
    form.append("photo", file, file.name || "fabric.jpg");
    try {
      const data = await api.post(`/api/attempts/${id}/fabric`, { form });
      setAttempt(data.attempt);
    } catch (err) {
      toast(photoUploadError(err));
    } finally {
      setSavingFabric(false);
    }
  }

  async function removeFabric() {
    setSavingFabric(true);
    try {
      const data = await api.del(`/api/attempts/${id}/fabric`);
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
    } finally {
      setSavingFabric(false);
    }
  }

  async function handleGenerate() {
    setStarting(true);
    try {
      await api.patch(`/api/attempts/${id}`, { json: { room_treatment: roomTreatment, lighting, note } });
      const suffix = ignorePlacement ? "?ignore_placement=true" : "";
      if (adjust.active) {
        // opened from "Adjust & try again": the new attempt is created only now, and generated from scratch
        const data = await api.post(`/api/attempts/${id}/generate-new${suffix}`);
        navigate(`/attempt/${data.attempt_id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
        return;
      }
      const data = await api.post(`/api/attempts/${id}/generate${suffix}`);
      navigate(`/attempt/${id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setStarting(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  // a "3+2" set is two pieces
  const pieceCount = attempt.items.reduce((n, it) => n + (it.sub_pieces?.length || 1), 0);

  return (
    <div className="screen has-step-footer">
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/${attempt.placement_mode === "shapes" ? "draw" : "place"}`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 4 of 4</div>
      <StepBar current={4} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} placementMode={attempt.placement_mode} />
      <h1 style={{ marginBottom: 6 }}>Customise and finish</h1>
      <p className="finish-subtitle muted">
        Add a fabric photo to re-cover the sofas, or leave it out to keep each sofa as in its photo. The design – shape,
        seats, arms and legs – always stays the same.
      </p>

      <div className="finish-layout">
        <div className="finish-options">
          <FabricSection
            fabricUrl={attempt.fabric_url}
            pieceCount={pieceCount}
            busy={savingFabric}
            onAdd={addFabric}
            onRemove={removeFabric}
          />

          <div className="field">
            <label>How should the room look?</label>
            <div className="option-grid looks" role="radiogroup" aria-label="How should the room look?">
              {ROOM_TREATMENTS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === roomTreatment}
                  className={"option-card" + (o.value === roomTreatment ? " selected" : "")}
                  onClick={() => setRoomTreatment(o.value)}
                >
                  <span className="option-radio" aria-hidden="true" />
                  <span>
                    <span className="option-title">{o.label}</span>
                    <span className="option-desc">{o.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Lighting</label>
            <div className="option-grid lights" role="radiogroup" aria-label="Lighting">
              {LIGHTINGS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === lighting}
                  className={"option-card" + (o.value === lighting ? " selected" : "")}
                  onClick={() => setLighting(o.value)}
                >
                  <span className="option-radio" aria-hidden="true" />
                  <span>
                    <span className="option-title">{o.label}</span>
                    <span className="option-desc">{o.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="finish-note">Anything specific?</label>
            <textarea
              id="finish-note"
              className="finish-note"
              rows={3}
              maxLength={NOTE_MAX}
              placeholder="Optional – e.g. keep the existing curtains"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="hint-line">{note.length}/{NOTE_MAX}</div>
          </div>
        </div>

        <div className="summary-box finish-summary">
          <div>
            <span className="mono muted">Room</span>
            <span className="mono">
              {attempt.room.customer_name} &middot; {attempt.room.room_type}
            </span>
          </div>
          <div>
            <span className="mono muted">Look</span>
            <span className="mono">{ROOM_TREATMENTS.find((o) => o.value === roomTreatment)?.label}</span>
          </div>
          <div>
            <span className="mono muted">Lighting</span>
            <span className="mono">{LIGHTINGS.find((o) => o.value === lighting)?.label}</span>
          </div>
          <div>
            <span className="mono muted">Fabric</span>
            <span className="mono">{attempt.fabric_url ? "Your fabric" : "As photo"}</span>
          </div>
          {attempt.items.map((it) => (
            <div key={it.id}>
              <span>
                {it.category} &middot; {it.type}
              </span>
            </div>
          ))}
        </div>
      </div>

      <StepFooter
        backTo={adjust.backTo || `/attempt/${id}/${attempt.placement_mode === "shapes" ? "draw" : "place"}`}
        status={attempt.fabric_url ? "Fabric added" : "No fabric – sofas as in their photos"}
        primaryLabel={savingFabric ? "Saving…" : "Generate"}
        primaryBusyLabel="Starting…"
        busy={starting}
        primaryDisabled={savingFabric}
        onPrimary={handleGenerate}
      />
    </div>
  );
}
