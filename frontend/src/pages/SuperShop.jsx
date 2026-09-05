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

  if (!shop && !error) return <div className="screen"><TopBar backTo="/super" /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo="/super" /><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo="/super" />
      <div className="eyebrow">Superadmin</div>
      <h1 style={{ marginBottom: 4 }}>{shop.name}</h1>
      <div className="mono muted" style={{ marginBottom: 18 }}>
        {shop.balance.toLocaleString()} / {shop.monthly_credits.toLocaleString()} credits &middot; {shop.salesman_count}{" "}
        salesm{shop.salesman_count === 1 ? "an" : "en"}
      </div>

      <button type="button" className="btn btn-ghost" onClick={() => setShowEdit(true)}>
        Edit allowance / adjust credits
      </button>

      <div className="section-label" style={{ marginTop: 22 }}>Manage</div>
      <div className="row-list">
        <Link to={`/admin?shop_id=${id}`} className="row-item">
          <div className="info">
            <div className="name">Salesmen</div>
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
