import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { Chip } from "../components/Chip.jsx";
import { UploadBox } from "../components/UploadBox.jsx";

const ITEM_TYPES = {
  Sofa: ["3+2", "3+3", "L-shape", "Curved"],
  "Dining table": ["4 seater", "6 seater", "8 seater"],
  Chair: ["Single", "Pair"],
  Bed: ["Single", "Queen", "King"],
};
const MAX_ITEMS = 4;

export default function Furniture() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [category, setCategory] = useState("Sofa");
  const [type, setType] = useState(ITEM_TYPES.Sofa[0]);
  const [width, setWidth] = useState("");
  const [photo, setPhoto] = useState(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleDelete(itemId) {
    try {
      const data = await api.del(`/api/attempts/${id}/items/${itemId}`);
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
    }
  }

  async function handleAdd() {
    const w = parseFloat(width);
    if (!photo) return toast("Please add a photo of the piece.");
    if (!w || w <= 0) return toast("Please enter a width in feet.");
    setAdding(true);
    const form = new FormData();
    form.append("category", category);
    form.append("type", type);
    form.append("width_ft", String(w));
    form.append("photo", photo);
    try {
      const data = await api.post(`/api/attempts/${id}/items`, { form });
      setAttempt(data.attempt);
      setPhoto(null);
      setWidth("");
    } catch (err) {
      toast(err.message);
    } finally {
      setAdding(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const atMax = attempt.items.length >= MAX_ITEMS;

  return (
    <div className="screen">
      <TopBar backTo={`/room/${attempt.room.id}`} />
      <div className="eyebrow">Step 2 of 4</div>
      <h1 style={{ marginBottom: 18 }}>Add furniture</h1>

      {attempt.items.map((it) => (
        <div key={it.id} className="item-row">
          <img src={it.photo_url} alt="" />
          <div className="info">
            <div className="title">
              {it.category} &middot; {it.type}
            </div>
            <div className="width">{it.width_ft}ft wide</div>
          </div>
          <button type="button" className="del" onClick={() => handleDelete(it.id)}>
            &times;
          </button>
        </div>
      ))}

      {atMax ? (
        <div className="count-hint">Maximum of {MAX_ITEMS} pieces reached.</div>
      ) : (
        <div className="add-piece-card">
          <div className="section-label" style={{ marginTop: 0 }}>Add another piece</div>
          <div className="chips">
            {Object.keys(ITEM_TYPES).map((c) => (
              <Chip
                key={c}
                selected={c === category}
                onClick={() => {
                  setCategory(c);
                  setType(ITEM_TYPES[c][0]);
                }}
              >
                {c}
              </Chip>
            ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Photo of the piece</label>
            <UploadBox file={photo} onChange={setPhoto} />
          </div>
          <div className="section-label">Type</div>
          <div className="chips">
            {ITEM_TYPES[category].map((t) => (
              <Chip key={t} selected={t === type} onClick={() => setType(t)}>
                {t}
              </Chip>
            ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Width (feet)</label>
            <input
              type="number"
              min="0.5"
              step="0.5"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              placeholder="e.g. 7"
            />
          </div>
          <button type="button" className="btn btn-dark" disabled={adding} onClick={handleAdd}>
            {adding ? "Adding…" : "Add piece"}
          </button>
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 20 }}
        disabled={!attempt.items.length}
        onClick={() => navigate(`/attempt/${id}/place`)}
      >
        Next — placement
      </button>
    </div>
  );
}
