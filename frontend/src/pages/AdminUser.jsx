import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { formatDate, withQuery } from "../utils.js";

export default function AdminUser() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showReset, setShowReset] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [toggling, setToggling] = useState(false);
  const toast = useToast();

  const backTo = withQuery("/admin", { shop_id: shopId });

  async function load() {
    setError(null);
    try {
      const res = await api.get(withQuery(`/api/admin/user/${id}`, { shop_id: shopId }));
      setData(res);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, shopId]);

  async function handleToggleActive() {
    setToggling(true);
    try {
      await api.post(withQuery(`/api/admin/users/${id}/toggle-active`, { shop_id: shopId }));
      await load();
    } catch (err) {
      toast(err.message);
    } finally {
      setToggling(false);
    }
  }

  if (!data && !error) return <div className="screen"><TopBar backTo={backTo} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo={backTo} /><ErrorBlock message={error} onRetry={load} /></div>;

  const { user, customer_count, customers } = data;

  return (
    <div className="screen">
      <TopBar backTo={backTo} />
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
        <button type="button" className="btn btn-ghost" onClick={() => setShowEdit(true)}>
          Edit details
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => setShowReset(true)}>
          Reset password
        </button>
        <button type="button" className="btn btn-danger" disabled={toggling} onClick={handleToggleActive}>
          {user.active ? "Deactivate" : "Activate"}
        </button>
        <button type="button" className="btn btn-danger" onClick={() => setShowDelete(true)}>
          Delete salesman
        </button>
      </div>

      {showEdit ? (
        <EditDetailsSheet
          user={user}
          shopId={shopId}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            load();
          }}
        />
      ) : null}

      {showReset ? <ResetPasswordSheet userId={id} shopId={shopId} onClose={() => setShowReset(false)} /> : null}

      {showDelete ? (
        <DeleteSalesmanSheet
          user={user}
          shopId={shopId}
          onClose={() => setShowDelete(false)}
          onDeleted={() => navigate(backTo, { replace: true })}
        />
      ) : null}
    </div>
  );
}

function EditDetailsSheet({ user, shopId, onClose, onSaved }) {
  const [name, setName] = useState(user.name);
  const [mobile, setMobile] = useState(user.mobile || "");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleSave() {
    if (!name.trim() || !mobile.trim()) {
      toast("Please fill in every field.");
      return;
    }
    setSubmitting(true);
    try {
      await api.patch(`/api/admin/users/${user.id}`, {
        json: { name: name.trim(), mobile: mobile.trim(), shop_id: shopId ? Number(shopId) : null },
      });
      toast("Details updated.");
      onSaved();
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="Edit details" onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Mobile number</label>
        <input type="tel" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleSave}>
        {submitting ? "Saving…" : "Save details"}
      </button>
    </BottomSheet>
  );
}

function ResetPasswordSheet({ userId, shopId, onClose }) {
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
      await api.post(`/api/admin/users/${userId}/reset-password`, {
        json: { password, shop_id: shopId ? Number(shopId) : null },
      });
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

function DeleteSalesmanSheet({ user, shopId, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const canDelete = typed.trim() === user.name;

  async function handleDelete() {
    if (!canDelete) return;
    setSubmitting(true);
    try {
      await api.del(withQuery(`/api/admin/users/${user.id}`, { shop_id: shopId }));
      onDeleted();
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="Delete salesman" onClose={onClose}>
      <p style={{ fontSize: 13.5, color: "var(--ink2)", marginBottom: 14 }}>
        This removes {user.name}&rsquo;s account. Their customers, rooms, attempts and renders stay — they&rsquo;ll be
        reassigned to you.
      </p>
      <div className="field">
        <label>Type &ldquo;{user.name}&rdquo; to confirm</label>
        <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <button type="button" className="btn btn-danger" disabled={!canDelete || submitting} onClick={handleDelete}>
        {submitting ? "Deleting…" : "Delete salesman"}
      </button>
    </BottomSheet>
  );
}
