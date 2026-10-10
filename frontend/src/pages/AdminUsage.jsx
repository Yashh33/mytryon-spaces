import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatDate, withQuery } from "../utils.js";

export default function AdminUsage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const isSuperadmin = user.role === "superadmin";
  const needsShopRedirect = isSuperadmin && !shopId;
  const backTo = withQuery("/admin", { shop_id: shopId });

  async function load() {
    if (needsShopRedirect) return;
    setError(null);
    try {
      const res = await api.get(withQuery("/api/admin/shop/usage", { shop_id: shopId }));
      setData(res);
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

  const crumbs = [{ label: "Admin", to: withQuery("/admin", { shop_id: shopId }) }, { label: "Usage" }];

  if (!data && !error) return <div className="screen"><TopBar backTo={backTo} crumbs={crumbs} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo={backTo} crumbs={crumbs} /><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo={backTo} crumbs={crumbs} />
      <div className="eyebrow">Admin</div>
      <h1 style={{ marginBottom: 4 }}>Usage this cycle</h1>
      <div className="muted mono" style={{ fontSize: 12, marginBottom: 18 }}>
        {formatDate(data.cycle_start)} &ndash; {formatDate(data.cycle_end)}
      </div>

      <div className="stat-row stat-row-extra">
        <div className="stat-card stat-extra">
          <div className="stat-label">Salesmen</div>
          <div className="stat-value">{data.salesmen.length}</div>
        </div>
        <div className="stat-card stat-extra">
          <div className="stat-label">Generations</div>
          <div className="stat-value">{data.salesmen.reduce((n, x) => n + x.generations, 0)}</div>
        </div>
        <div className="stat-card stat-extra">
          <div className="stat-label">Credits spent</div>
          <div className="stat-value">{data.salesmen.reduce((n, x) => n + x.credits_spent, 0).toLocaleString()}</div>
        </div>
      </div>

      {data.salesmen.length ? (
        <div className="table-scroll">
        <div className="usage-table">
          <div className="usage-row usage-head">
            <div className="usage-name">Salesman</div>
            <div className="usage-num">Generations</div>
            <div className="usage-num">Credits</div>
          </div>
          {data.salesmen.map((s) => (
            <div key={s.user_id} className="usage-row">
              <div className="usage-name">{s.name}</div>
              <div className="usage-num mono">{s.generations}</div>
              <div className="usage-num mono">{s.credits_spent.toLocaleString()}</div>
            </div>
          ))}
        </div>
        </div>
      ) : (
        <div className="empty-state">No salesmen yet.</div>
      )}

      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        The owner&rsquo;s own renders are not included in this table yet.
      </div>

      <div className="section-label" style={{ marginTop: 22 }}>Daily</div>
      {data.daily && data.daily.length ? (
        <div className="table-scroll">
        <div className="usage-table">
          {[...data.daily].reverse().map((d) => (
            <div key={d.date} className="usage-row">
              <div className="usage-name">{formatDate(d.date)}</div>
              <div className="usage-num mono">{d.generations}</div>
              <div className="usage-num mono">{d.credits_spent.toLocaleString()}</div>
            </div>
          ))}
        </div>
        </div>
      ) : (
        <div className="empty-state">No activity yet.</div>
      )}
    </div>
  );
}
