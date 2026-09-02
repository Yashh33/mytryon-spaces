import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { Chip } from "../components/Chip.jsx";
import { UploadBox } from "../components/UploadBox.jsx";

const ROOM_TYPES = ["Living room", "Bedroom", "Dining", "Balcony"];

export default function RoomNew() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [roomType, setRoomType] = useState("");
  const [photo, setPhoto] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!roomType) return toast("Please choose a room type.");
    if (!photo) return toast("Please add a photo of the space.");
    setSubmitting(true);
    const form = new FormData();
    form.append("room_type", roomType);
    form.append("photo", photo);
    try {
      const data = await api.post(`/api/customers/${id}/rooms`, { form });
      navigate(`/room/${data.room.id}`);
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <div className="screen">
      <TopBar backTo={`/customer/${id}`} />
      <h1 style={{ marginBottom: 20 }}>Add a room</h1>
      <div className="field">
        <label>Which room?</label>
        <div className="chips">
          {ROOM_TYPES.map((r) => (
            <Chip key={r} selected={r === roomType} onClick={() => setRoomType(r)}>
              {r}
            </Chip>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Photo of the space</label>
        <UploadBox file={photo} onChange={setPhoto} />
        <div className="hint-line">Stand at the opposite wall, phone at chest height, keep the floor visible.</div>
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleSubmit}>
        {submitting ? "Creating…" : "Add room"}
      </button>
    </div>
  );
}
