import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { Chip } from "../components/Chip.jsx";
import { UploadBox } from "../components/UploadBox.jsx";
import { debugLog, initials } from "../utils.js";

const ROOM_TYPES = ["Living room", "Bedroom", "Dining", "Balcony"];
const MAX_SUGGESTIONS = 6;

export default function NewVisualisation() {
  const navigate = useNavigate();
  const toast = useToast();
  const [customers, setCustomers] = useState([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [roomType, setRoomType] = useState("");
  const [photo, setPhoto] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .get("/api/customers")
      .then((data) => setCustomers(data.customers || []))
      .catch(() => setCustomers([]));
  }, []);

  const typed = query.trim();
  const needle = typed.toLowerCase();
  const suggestions =
    !selected && needle
      ? customers.filter((c) => c.name.toLowerCase().includes(needle)).slice(0, MAX_SUGGESTIONS)
      : [];

  function pick(customer) {
    setSelected(customer);
    setQuery(customer.name);
  }

  function clearCustomer() {
    setSelected(null);
    setQuery("");
  }

  async function handleSubmit() {
    if (!selected && !typed) return toast("Please enter the customer's name.");
    if (!roomType) return toast("Please choose a room type.");
    if (!photo) return toast("Please add a photo of the space.");
    setSubmitting(true);
    try {
      let customerId = selected?.id;
      if (!customerId) {
        const created = await api.post("/api/customers", { json: { name: typed } });
        // Keep the new customer selected so a retry after a failed upload doesn't create a duplicate.
        pick(created.customer);
        customerId = created.customer.id;
      }
      const form = new FormData();
      form.append("room_type", roomType);
      form.append("photo", photo);
      try {
        const data = await api.post(`/api/customers/${customerId}/rooms`, { form });
        debugLog("upload OK");
        navigate(`/room/${data.room.id}`);
      } catch (err) {
        debugLog(`upload FAIL ${err.message}`);
        throw err;
      }
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="screen">
      <TopBar backTo="/" />
      <div className="eyebrow">Step 1 of 4</div>
      <h1 style={{ marginBottom: 20 }}>New visualisation</h1>
      <div className="roomnew-layout nv-layout">
        <div className="field nv-customer">
          <label>Customer</label>
          <input
            type="text"
            value={query}
            readOnly={!!selected}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or add customer"
          />
          {selected ? (
            <button type="button" className="link-btn" onClick={clearCustomer}>
              Change
            </button>
          ) : null}
          {suggestions.length ? (
            <div className="row-list nv-suggest">
              {suggestions.map((c) => (
                <button key={c.id} type="button" className="row-item" onClick={() => pick(c)}>
                  <div className="avatar">{initials(c.name)}</div>
                  <div className="info">
                    <div className="name">{c.name}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {!selected && typed ? <div className="hint-line">New customer: {typed}</div> : null}
        </div>
        <div className="field rn-type">
          <label>Which room?</label>
          <div className="chips">
            {ROOM_TYPES.map((r) => (
              <Chip key={r} selected={r === roomType} onClick={() => setRoomType(r)}>
                {r}
              </Chip>
            ))}
          </div>
        </div>
        <div className="field rn-photo">
          <label>Photo of the space</label>
          <UploadBox file={photo} onChange={setPhoto} />
        </div>
        <div className="hint-line rn-hint">Stand at the opposite wall, phone at chest height, keep the floor visible.</div>
        <button type="button" className="btn btn-primary rn-btn" disabled={submitting} onClick={handleSubmit}>
          {submitting ? "Starting…" : "Start"}
        </button>
      </div>
    </div>
  );
}
