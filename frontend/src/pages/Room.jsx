import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";

export default function Room() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await api.get(`/api/rooms/${id}`);
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleNewAttempt() {
    setCreating(true);
    try {
      const res = await api.post(`/api/rooms/${id}/attempts`, { json: {} });
      navigate(`/attempt/${res.attempt.id}/furniture`);
    } catch (err) {
      toast(err.message);
      setCreating(false);
    }
  }

  if (!data && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const { room, attempts } = data;
  const numberById = new Map([...attempts].sort((a, b) => a.id - b.id).map((a, i) => [a.id, i + 1]));

  return (
    <div className="screen">
      <TopBar backTo={`/customer/${room.customer_id}`} />
      <div className="eyebrow">{room.customer_name}</div>
      <h1 style={{ marginBottom: 16 }}>{room.room_type}</h1>

      <img src={room.photo_url} alt="" style={{ width: "100%", borderRadius: 12, background: "var(--line)" }} />
      <div className="hint-line" style={{ textAlign: "center" }}>
        ROOM PHOTO &middot; REUSED FOR EVERY ATTEMPT
      </div>

      <div className="section-label" style={{ marginTop: 22 }}>Attempts</div>
      <div className="card-grid">
        {attempts.map((a) => (
          <Link
            key={a.id}
            to={a.latest_render ? `/attempt/${a.id}/result` : `/attempt/${a.id}/furniture`}
            className={"card-tile" + (a.is_picked ? " picked" : "")}
          >
            {a.is_picked ? <div className="pick-star">&#9733;</div> : null}
            <img className="thumb" src={a.latest_render ? a.latest_render.image_url : room.photo_url} alt="" loading="lazy" />
            <div className="meta">
              <div className="title">Attempt {numberById.get(a.id)}</div>
              <div className="sub">
                {a.room_treatment.toUpperCase()} &middot; {a.lighting.toUpperCase()}
              </div>
            </div>
          </Link>
        ))}
        <button type="button" className="dashed-card" disabled={creating} onClick={handleNewAttempt}>
          {creating ? "Creating…" : "+ New attempt"}
        </button>
      </div>
    </div>
  );
}
