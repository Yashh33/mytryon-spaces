import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { formatDate } from "../utils.js";

export default function AdminUser() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showReset, setShowReset] = useState(false);
  const [toggling, setToggling] = useState(false);
  const toast = useToast();

  async function load() {
    setError(null);
    try {
      const res = await api.get(`/api/admin/user/${id}`);
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleToggleActive() {
    setToggling(true);
    try {
      await api.post(`/api/admin/users/${id}/toggle-active`);
      await load();
    } catch (err) {
      toast(err.message);
    } finally {
      setToggling(false);
    }
  }

  if (!data && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const { user, customer_count, customers } = data;

  return (
    <div className="screen">
      <TopBar backTo="/admin" />
      <h1>{user.name}</h1>
      <div className="mono muted" style={{ marginTop: 4 }}>
        {user.mobile} &middot; {customer_count} customer{customer_count === 1 ? "" : "s"}
      </div>
      {!user.active ? (
        <div style={{ marginTop: 8 }}>
          <span className="badge-inactive">Inactive</span>
        </div>
      ) : null}

      <hr className="divider" />

      {customers.length ? (
        customers.map((c) => (
          <div key={c.id} className="customer-card">
            <div className="top">
              <div>
                <div className="cname">{c.name}</div>
                <div className="csub">{formatDate(c.created_at)}</div>
              </div>
            </div>
            {c.rooms.map((r) => (
              <div key={r.id} style={{ marginBottom: 8 }}>
                <div className="csub" style={{ marginBottom: 4 }}>
                  {r.room_type}
                </div>
                <div className="render-thumbs">
                  {r.renders.length ? (
                    r.renders.map((url, i) => <img key={i} src={url} alt="" loading="lazy" />)
                  ) : (
                    <span className="muted" style={{ fontSize: 12 }}>
                      No renders yet
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className="empty-state">No customers yet.</div>
      )}

      <hr className="divider" />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button type="button" className="btn btn-ghost" onClick={() => setShowReset(true)}>
          Reset password
        </button>
        <button type="button" className="btn btn-danger" disabled={toggling} onClick={handleToggleActive}>
          {user.active ? "Deactivate" : "Activate"}
        </button>
      </div>

      {showReset ? <ResetPasswordSheet userId={id} onClose={() => setShowReset(false)} /> : null}
    </div>
  );
}

function ResetPasswordSheet({ userId, onClose }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleSave() {
    if (!password || password.length < 4) {
      toast("Please choose a longer password.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post(`/api/admin/users/${userId}/reset-password`, { json: { password } });
      toast("Password updated.");
      onClose();
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="Reset password" onClose={onClose}>
      <div className="field">
        <label>New password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleSave}>
        {submitting ? "Saving…" : "Save new password"}
      </button>
    </BottomSheet>
  );
}
