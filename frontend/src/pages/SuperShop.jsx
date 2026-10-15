import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { EditShopSheet } from "./Super.jsx";

export default function SuperShop() {
  const { id } = useParams();
  const [shop, setShop] = useState(null);
  const [error, setError] = useState(null);
  const [showEdit, setShowEdit] = useState(false);
  const [savingFeature, setSavingFeature] = useState(false);

  async function setFeature(name, on) {
    setSavingFeature(true);
    try {
      const data = await api.patch(`/api/super/shops/${id}`, { json: { features: { [name]: on } } });
      setShop(data.shop);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingFeature(false);
    }
  }

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/super/shops/${id}`);
      setShop(data.shop);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!shop && !error) return <div className="screen screen-narrow"><TopBar backTo="/super" /><Loading /></div>;
  if (error) return <div className="screen screen-narrow"><TopBar backTo="/super" /><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen screen-narrow">
      <TopBar backTo="/super" crumbs={[{ label: "Shops", to: "/super" }, { label: shop.name }]} />
      <div className="eyebrow">Superadmin</div>
      <h1 style={{ marginBottom: 4 }}>{shop.name}</h1>
      <div className="mono muted" style={{ marginBottom: 18 }}>
        {shop.balance.toLocaleString()} / {shop.monthly_credits.toLocaleString()} credits &middot; {shop.salesman_count}{" "}
        salesm{shop.salesman_count === 1 ? "an" : "en"}
      </div>

      <button type="button" className="btn btn-ghost" onClick={() => setShowEdit(true)}>
        Edit allowance / adjust credits
      </button>

      <div className="section-label" style={{ marginTop: 22 }}>Features</div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, minHeight: 44 }}>
        <input
          type="checkbox"
          checked={Boolean(shop.features?.fix_this)}
          disabled={savingFeature}
          onChange={(e) => setFeature("fix_this", e.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        Fix this — small edits of a finished picture
      </label>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
        Off: the Fix this button is hidden for this shop&apos;s salesmen.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, minHeight: 44, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={Boolean(shop.features?.shape_placement)}
          disabled={savingFeature}
          onChange={(e) => setFeature("shape_placement", e.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        Draw on photo (Beta) — a second way to place furniture
      </label>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
        Off: salesmen go straight to the floor plan, without the choice.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, minHeight: 44, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={Boolean(shop.features?.show_debug)}
          disabled={savingFeature}
          onChange={(e) => setFeature("show_debug", e.target.checked)}
          style={{ width: 20, height: 20 }}
        />
        Debug button — what was sent to the AI, on the result page
      </label>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>
        On: the shop&apos;s users see a Debug button below Adjust &amp; try again (the images, prompt and gap writer lines of
        their own pictures). The superadmin always has it.
      </div>

      <div className="section-label" style={{ marginTop: 22 }}>Manage</div>
      <div className="row-list">
        <Link to={`/admin?shop_id=${id}`} className="row-item">
          <div className="info">
            <div className="name">Salesmen</div>
          </div>
          <div className="chevron">&#8250;</div>
        </Link>
        <Link to={`/admin/activity?shop_id=${id}`} className="row-item">
          <div className="info">
            <div className="name">Live activity</div>
          </div>
          <div className="chevron">&#8250;</div>
        </Link>
        <Link to={`/admin/usage?shop_id=${id}`} className="row-item">
          <div className="info">
            <div className="name">Usage</div>
          </div>
          <div className="chevron">&#8250;</div>
        </Link>
        <Link to={`/admin/prompt?shop_id=${id}`} className="row-item">
          <div className="info">
            <div className="name">Generation prompt</div>
          </div>
          <div className="chevron">&#8250;</div>
        </Link>
      </div>

      {showEdit ? (
        <EditShopSheet
          shop={shop}
          onClose={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
