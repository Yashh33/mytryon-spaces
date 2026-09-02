import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { Chip } from "../components/Chip.jsx";

const ROOM_TREATMENTS = [
  { value: "luxury", label: "Luxury finishing" },
  { value: "minimal", label: "Minimal finishing" },
];
const LIGHTINGS = [
  { value: "warm", label: "Warm" },
  { value: "daylight", label: "Daylight" },
  { value: "studio", label: "Studio" },
];

export default function Finish() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const ignorePlacement = searchParams.get("ignore_placement") === "true";
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [roomTreatment, setRoomTreatment] = useState("luxury");
  const [lighting, setLighting] = useState("warm");
  const [starting, setStarting] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setRoomTreatment(data.attempt.room_treatment || "luxury");
      setLighting(data.attempt.lighting || "warm");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleGenerate() {
    setStarting(true);
    try {
      await api.patch(`/api/attempts/${id}`, { json: { room_treatment: roomTreatment, lighting } });
      const suffix = ignorePlacement ? "?ignore_placement=true" : "";
      const data = await api.post(`/api/attempts/${id}/generate${suffix}`);
      navigate(`/attempt/${id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setStarting(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo={`/attempt/${id}/place`} />
      <div className="eyebrow">Step 4 of 4</div>
      <h1 style={{ marginBottom: 20 }}>Finishing touches</h1>

      <div className="field">
        <label>How should the room look?</label>
        <div className="chips">
          {ROOM_TREATMENTS.map((o) => (
            <Chip key={o.value} selected={o.value === roomTreatment} onClick={() => setRoomTreatment(o.value)}>
              {o.label}
            </Chip>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Lighting</label>
        <div className="chips">
          {LIGHTINGS.map((o) => (
            <Chip key={o.value} selected={o.value === lighting} onClick={() => setLighting(o.value)}>
              {o.label}
            </Chip>
          ))}
        </div>
      </div>

      <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={starting} onClick={handleGenerate}>
        {starting ? "Starting…" : "Generate"}
      </button>
    </div>
  );
}
