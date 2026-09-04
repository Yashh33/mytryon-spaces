import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { initials } from "../utils.js";

export default function Super() {
  const [shops, setShops] = useState(null);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingShop, setEditingShop] = useState(null);
  const toast = useToast();

  async function load() {
    setError(null);
    try {
      const data = await api.get("/api/super/shops");
      setShops(data.shops);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleToggleActive(shop) {
    try {
      await api.patch(`/api/super/shops/${shop.id}`, { json: { active: !shop.active } });
      load();
    } catch (err) {
      toast(err.message);
    }
  }

  return (
    <div className="screen">
      <TopBar backTo="/" />
      <div className="eyebrow">Superadmin</div>
      <div className="admin-header">
        <h1>Shops</h1>
        <div className="admin-count">{shops ? shops.length : ""}</div>
      </div>

      {shops === null && !error ? <Loading /> : null}
      {error ? <ErrorBlock message={error} onRetry={load} /> : null}
      {shops !== null ? (
        shops.length ? (
          <div className="row-list">
            {shops.map((s) => (
              <div key={s.id} className={"row-item" + (s.active ? "" : " inactive")}>
                <div className="avatar">{initials(s.name)}</div>
                <div className="info" style={{ cursor: "pointer" }} onClick={() => setEditingShop(s)}>
                  <div className="name">{s.name}</div>
                  <div className="sub">
                    {s.balance.toLocaleString()} / {s.monthly_credits.toLocaleString()} credits &middot; {s.salesman_count}{" "}
                    salesm{s.salesman_count === 1 ? "an" : "en"}
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle-pill" + (s.active ? " on" : "")}
                  onClick={() => handleToggleActive(s)}
                >
                  {s.active ? "Active" : "Inactive"}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">No shops yet.</div>
        )
      ) : null}

      <button type="button" className="btn btn-dark" style={{ marginTop: 16 }} onClick={() => setShowAdd(true)}>
        + New shop
      </button>

      {showAdd ? (
        <AddShopSheet
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            load();
          }}
        />
      ) : null}

      {editingShop ? (
        <EditShopSheet
          shop={editingShop}
          onClose={() => setEditingShop(null)}
          onSaved={() => {
            setEditingShop(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function AddShopSheet({ onClose, onCreated }) {
  const [name, setName] = useState("");
  const [monthlyCredits, setMonthlyCredits] = useState("15000");
  const [cycleStartDay, setCycleStartDay] = useState("1");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function handleCreate() {
    if (!name.trim()) {
      toast("Please enter a shop name.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/super/shops", {
        json: {
          name: name.trim(),
          monthly_credits: Number(monthlyCredits) || 0,
          cycle_start_day: Number(cycleStartDay) || 1,
        },
      });
      onCreated();
    } catch (err) {
      toast(err.message);
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet title="New shop" onClose={onClose}>
      <div className="field">
        <label>Shop name</label>
        <input type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sunrise Interiors" />
      </div>
      <div className="field">
        <label>Monthly credits</label>
        <input type="number" min="0" value={monthlyCredits} onChange={(e) => setMonthlyCredits(e.target.value)} />
      </div>
      <div className="field">
        <label>Cycle start day</label>
        <input
          type="number"
          min="1"
          max="28"
          value={cycleStartDay}
          onChange={(e) => setCycleStartDay(e.target.value)}
        />
      </div>
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={handleCreate}>
        {submitting ? "Creating…" : "Create shop"}
      </button>
    </BottomSheet>
  );
}

function EditShopSheet({ shop, onClose, onSaved }) {
  const [monthlyCredits, setMonthlyCredits] = useState(String(shop.monthly_credits));
  const [savingAllowance, setSavingAllowance] = useState(false);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [applyingAdjustment, setApplyingAdjustment] = useState(false);
  const toast = useToast();

  async function handleSaveAllowance() {
    setSavingAllowance(true);
    try {
      await api.patch(`/api/super/shops/${shop.id}`, { json: { monthly_credits: Number(monthlyCredits) || 0 } });
      toast("Monthly allowance updated.");
      onSaved();
    } catch (err) {
      toast(err.message);
      setSavingAllowance(false);
    }
  }

  async function handleApplyAdjustment() {
    const value = Number(delta);
    if (!value) {
      toast("Enter a non-zero adjustment.");
      return;
    }
    setApplyingAdjustment(true);
    try {
      await api.post(`/api/super/shops/${shop.id}/credits`, { json: { delta: value, note: note.trim() } });
      toast("Credit adjustment applied.");
      onSaved();
    } catch (err) {
      toast(err.message);
      setApplyingAdjustment(false);
    }
  }

  return (
    <BottomSheet title={shop.name} onClose={onClose}>
      <div className="field">
        <label>Monthly credits</label>
        <input type="number" min="0" value={monthlyCredits} onChange={(e) => setMonthlyCredits(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" disabled={savingAllowance} onClick={handleSaveAllowance}>
        {savingAllowance ? "Saving…" : "Save allowance"}
      </button>

      <div className="section-label" style={{ marginTop: 20 }}>Manual adjustment</div>
      <div className="field">
        <label>Credits (negative to deduct)</label>
        <input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="e.g. -100 or 500" />
      </div>
      <div className="field">
        <label>Note</label>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason for this adjustment" />
      </div>
      <button type="button" className="btn btn-ghost" disabled={applyingAdjustment} onClick={handleApplyAdjustment}>
        {applyingAdjustment ? "Applying…" : "Apply adjustment"}
      </button>
    </BottomSheet>
  );
}
