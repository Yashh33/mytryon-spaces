import { useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { initials, withQuery } from "../utils.js";

export default function Admin() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const isSuperadmin = user.role === "superadmin";
  const needsShopRedirect = isSuperadmin && !shopId;

  const backTo = isSuperadmin ? `/super/shop/${shopId}` : "/";
  const withShop = (path) => withQuery(path, { shop_id: shopId });

  async function load() {
    if (needsShopRedirect) return;
    setError(null);
    try {
      const data = await api.get(withQuery("/api/admin/users", { shop_id: shopId }));
      setUsers(data.users);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  if (needsShopRedirect) {
    return <Navigate to="/super" replace />;
  }

  const filtered = (users || []).filter((u) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || u.mobile.includes(q);
  });

  return (
    <div className="screen">
      <TopBar
        backTo={backTo}
        right={
          <div style={{ display: "flex", gap: 14 }}>
            <Link to={withShop("/admin/usage")} className="link-btn">
              Usage &#8250;
            </Link>
            <Link to={withShop("/admin/prompt")} className="link-btn">
              Edit prompt &#8250;
            </Link>
          </div>
        }
      />
      <div className="eyebrow">Admin</div>
      <div className="admin-header">
        <h1>Salesmen</h1>
        <div className="admin-count">{users ? users.length : ""}</div>
      </div>
      <input className="search-box" placeholder="Search by name or number" value={query} onChange={(e) => setQuery(e.target.value)} />

      {users === null && !error ? <Loading /> : null}
      {error ? <ErrorBlock message={error} onRetry={load} /> : null}
      {users !== null ? (
        filtered.length ? (
          <div className="row-list">
            {filtered.map((u) => (
              <Link key={u.id} to={withShop(`/admin/user/${u.id}`)} className={"row-item" + (u.active ? "" : " inactive")}>
                <div className="avatar">{initials(u.name)}</div>
                <div className="info">
                  <div className="name">
                    {u.name} {u.active ? "" : <span className="badge-inactive">Inactive</span>}
                  </div>
                  <div className="sub">{u.mobile}</div>
                </div>
                <div className="chevron">&#8250;</div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state">No salesmen found.</div>
        )
      ) : null}

      <button type="button" className="btn btn-dark" style={{ marginTop: 16 }} onClick={() => setShowAdd(true)}>
        + Add salesman
      </button>

      {showAdd ? (
        <AddSalesmanSheet
          shopId={shopId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function AddSalesmanSheet({ shopId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleCreate() {
    if (!name.trim() || !mobile.trim() || !password) {
      toast("Please fill in every field.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/admin/users", {
        json: { name: name.trim(), mobile: mobile.trim(), password, shop_id: shopId ? Number(shopId) : null },
      });
      onCreated();
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="Add salesman" onClose={onClose}>
      <div className="field">
        <label>Name</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Mobile number</label>
        <input type="tel" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value)} />
      </div>
      <div className="field">
        <label>Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleCreate}>
        {submitting ? "Creating…" : "Create account"}
      </button>
    </BottomSheet>
  );
}
