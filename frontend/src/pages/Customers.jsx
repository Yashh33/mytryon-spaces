import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { ErrorBlock, RowSkeleton } from "../components/StateBlock.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { initials } from "../utils.js";

export default function Customers() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [customers, setCustomers] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const menuRef = useRef(null);

  async function load() {
    setError(null);
    try {
      const data = await api.get("/api/customers");
      setCustomers(data.customers);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  const filtered = (customers || []).filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="screen">
      <div className="page-header">
        <div>
          <h1>Hello, {user.first_name}</h1>
          <div className="eyebrow">Reflection Lifestyle</div>
        </div>
        <div style={{ position: "relative" }} ref={menuRef}>
          <button type="button" className="menu-btn" onClick={() => setMenuOpen((v) => !v)}>
            &#8942;
          </button>
          {menuOpen ? (
            <div className="menu-dropdown">
              {user.role === "admin" ? (
                <Link to="/admin" onClick={() => setMenuOpen(false)}>
                  Admin
                </Link>
              ) : null}
              <button type="button" onClick={logout} style={{ color: "#C0392B" }}>
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <button type="button" className="btn btn-primary" onClick={() => setShowAdd(true)}>
        + New customer
      </button>

      <hr className="divider" />

      <input
        className="search-box"
        placeholder="Search customers"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {customers === null && !error ? <RowSkeleton /> : null}
      {error ? <ErrorBlock message={error} onRetry={load} /> : null}
      {customers !== null ? (
        filtered.length ? (
          <div className="row-list">
            {filtered.map((c) => (
              <Link key={c.id} to={`/customer/${c.id}`} className="row-item">
                <div className="avatar">{initials(c.name)}</div>
                <div className="info">
                  <div className="name">{c.name}</div>
                  <div className="sub">
                    {c.room_count} ROOM{c.room_count === 1 ? "" : "S"} &middot; {c.render_count} RENDER
                    {c.render_count === 1 ? "" : "S"}
                  </div>
                </div>
                <div className="chevron">&#8250;</div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state">No customers yet.</div>
        )
      ) : null}

      {showAdd ? (
        <AddCustomerSheet
          onClose={() => setShowAdd(false)}
          onCreated={(customer) => {
            setShowAdd(false);
            navigate(`/customer/${customer.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function AddCustomerSheet({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleCreate() {
    if (!name.trim()) {
      toast("Please enter the customer's name.");
      return;
    }
    setSubmitting(true);
    try {
      const data = await api.post("/api/customers", { json: { name: name.trim() } });
      onCreated(data.customer);
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="New customer" onClose={onClose}>
      <div className="field">
        <label>Customer name</label>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya Shah" />
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleCreate}>
        {submitting ? "Creating…" : "Create customer"}
      </button>
    </BottomSheet>
  );
}
