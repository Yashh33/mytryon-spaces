import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { ErrorBlock, RoomCardSkeleton } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatShortDate } from "../utils.js";

export default function Customer() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const toast = useToast();

  async function load() {
    setError(null);
    try {
      const res = await api.get(`/api/customers/${id}`);
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleSendAll() {
    const rooms = data?.rooms || [];
    if (!rooms.length) {
      toast("No rooms yet.");
      return;
    }
    setSharing(true);
    try {
      const targets = rooms
        .filter((r) => r.has_render)
        .map((r) => ({ url: r.thumbnail_url, name: r.room_type }));
      if (!targets.length) {
        toast("No renders yet to send.");
        return;
      }
      const files = await Promise.all(
        targets.map(async (t, i) => {
          const res = await fetch(t.url);
          const blob = await res.blob();
          return new File([blob], `${t.name.replace(/\s+/g, "-")}-${i + 1}.jpg`, { type: blob.type || "image/jpeg" });
        })
      );
      if (navigator.canShare && navigator.canShare({ files })) {
        await navigator.share({ files, title: "Reflection Lifestyle", text: data.customer.name });
      } else {
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const a = document.createElement("a");
          a.href = url;
          a.download = file.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 4000);
        }
        toast("Saved — attach them in WhatsApp manually.");
      }
    } catch (err) {
      if (err?.name !== "AbortError") toast("Couldn't prepare the images. Please try again.");
    } finally {
      setSharing(false);
    }
  }

  if (error) return <div className="screen"><TopBar backTo="/" /><ErrorBlock message={error} onRetry={load} /></div>;

  const customer = data?.customer;
  const rooms = data?.rooms;

  return (
    <div className="screen">
      <TopBar backTo="/" />
      <div className="eyebrow">Customer</div>
      {customer ? (
        <h1 style={{ marginBottom: 18 }}>{customer.name}</h1>
      ) : (
        <div className="skel skel-line w-60" style={{ height: 28, marginBottom: 18 }} />
      )}

      {rooms == null ? (
        <RoomCardSkeleton />
      ) : rooms.length ? (
        rooms.map((r) => (
          <Link key={r.id} to={`/room/${r.id}`} className="room-card">
            <img className="thumb" src={r.thumbnail_url} alt="" loading="lazy" />
            <div className="body">
              <div className="info">
                <div className="title">{r.room_type}</div>
                <div className="sub">
                  {r.attempt_count} ATTEMPT{r.attempt_count === 1 ? "" : "S"} &middot; {formatShortDate(r.created_at)}
                </div>
              </div>
              <div className="chevron">&#8250;</div>
            </div>
          </Link>
        ))
      ) : (
        <div className="empty-state">No rooms yet.</div>
      )}

      <Link to={`/customer/${id}/room/new`} className="dashed-row" style={{ display: "block" }}>
        + Add a room
      </Link>

      <button
        type="button"
        className="btn btn-whatsapp"
        style={{ marginTop: 18 }}
        disabled={sharing || rooms == null}
        onClick={handleSendAll}
      >
        {sharing ? "Preparing…" : "Send all to WhatsApp"}
      </button>
    </div>
  );
}
