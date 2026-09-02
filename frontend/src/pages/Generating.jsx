import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";

const PHASES = ["Reading the room…", "Placing the furniture…", "Setting the light…", "Adding final touches…"];

function mmss(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return String(m).padStart(2, "0") + ":" + String(r).padStart(2, "0");
}

export default function Generating() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const jobId = location.state?.jobId;
  const [startedAt] = useState(() => location.state?.startedAt || Date.now());

  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  const [summary, setSummary] = useState(null);
  const [errorState, setErrorState] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const stoppedRef = useRef(false);

  useEffect(() => {
    api
      .get(`/api/attempts/${id}`)
      .then((data) => setSummary(data.attempt))
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  useEffect(() => {
    if (!jobId) return undefined;
    stoppedRef.current = false;

    async function poll() {
      if (stoppedRef.current) return;
      try {
        const status = await api.get(`/api/jobs/${jobId}`);
        if (status.status === "done") {
          stoppedRef.current = true;
          navigate(`/attempt/${id}/result`, { replace: true });
          return;
        }
        if (status.status === "error") {
          stoppedRef.current = true;
          setErrorState(status.message);
          return;
        }
      } catch (err) {
        if (err.status === 401) return;
      }
      if (!stoppedRef.current) setTimeout(poll, 2500);
    }
    poll();

    return () => {
      stoppedRef.current = true;
    };
  }, [jobId, id, navigate]);

  async function handleRetry() {
    setRetrying(true);
    try {
      const data = await api.post(`/api/attempts/${id}/generate`);
      navigate(`/attempt/${id}/generating`, { replace: true, state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setRetrying(false);
    }
  }

  if (!jobId) {
    return (
      <div className="generating-screen gen-error">
        <div className="status-line">Nothing to check</div>
        <div className="msg">Start a generation from the finishing step first.</div>
        <button type="button" className="btn btn-ghost" onClick={() => navigate(`/attempt/${id}/finish`)}>
          Back to finishing
        </button>
      </div>
    );
  }

  if (errorState) {
    return (
      <div className="generating-screen gen-error">
        <div className="status-line">One moment — that didn't go through</div>
        <div className="msg">{errorState}</div>
        <div style={{ width: "100%", maxWidth: 280, display: "flex", flexDirection: "column", gap: 10 }}>
          <button type="button" className="btn btn-primary" disabled={retrying} onClick={handleRetry}>
            {retrying ? "Starting…" : "Try again"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ color: "#fff", borderColor: "rgba(255,255,255,0.3)" }}
            onClick={() => navigate(`/attempt/${id}/furniture`)}
          >
            Back to pieces
          </button>
        </div>
      </div>
    );
  }

  const phaseIdx = Math.min(PHASES.length - 1, Math.floor(elapsed / 4000));

  return (
    <div className="generating-screen">
      <div className="ring" />
      <div className="timer">{mmss(elapsed)}</div>
      <div className="status-line">{PHASES[phaseIdx]}</div>
      {summary ? (
        <div className="gen-box">
          <div className="cust">{summary.room.customer_name}</div>
          <div className="room">{summary.room.room_type}</div>
          {summary.items.map((it) => (
            <div key={it.id} className="piece">
              <span>
                {it.category} &middot; {it.type}
              </span>
              <span className="w">{it.width_ft}ft</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
