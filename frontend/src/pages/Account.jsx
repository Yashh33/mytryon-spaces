import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomNav } from "../components/BottomNav.jsx";
import { formatDate } from "../utils.js";

const ROLE_LABELS = { salesman: "Salesman", owner: "Owner", superadmin: "Superadmin" };

export default function Account() {
  const { user, logout } = useAuth();
  const [credits, setCredits] = useState(null);
  const [creditsError, setCreditsError] = useState(false);

  useEffect(() => {
    if (user.role === "superadmin") return;
    api
      .get("/api/shop/credits")
      .then(setCredits)
      .catch(() => setCreditsError(true));
  }, [user.role]);

  const pct = credits ? Math.min(100, Math.max(0, (credits.balance / credits.monthly_credits) * 100)) : 0;

  return (
    <div className="screen screen-medium has-bottom-nav">
      <TopBar backTo="/" />
      <div className="eyebrow">Account</div>
      <div className="account-top">
        <div className="account-profile">
      <h1 style={{ marginBottom: 4 }}>{user.name}</h1>
      <div className="mono muted" style={{ marginBottom: 18 }}>
        {user.mobile ? `${user.mobile} · ` : ""}
        {ROLE_LABELS[user.role] || user.role}
      </div>
        </div>
      {user.role !== "superadmin" ? (
        <div className="account-credits-card">
          {credits ? (
            <>
              <div className="amount">
                {credits.balance.toLocaleString()} of {credits.monthly_credits.toLocaleString()} credits left
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="reset">Resets {formatDate(credits.cycle_ends_on)}</div>
            </>
          ) : creditsError ? (
            <div className="muted">Credits unavailable</div>
          ) : (
            <div className="muted">Loading…</div>
          )}
        </div>
      ) : null}
      </div>

      <div className="row-list" style={{ marginTop: 18 }}>
        {user.role === "owner" ? (
          <Link to="/admin" className="row-item">
            <div className="info">
              <div className="name">Admin</div>
            </div>
            <div className="chevron">&#8250;</div>
          </Link>
        ) : null}
        {user.role === "superadmin" ? (
          <Link to="/super" className="row-item">
            <div className="info">
              <div className="name">Shops</div>
            </div>
            <div className="chevron">&#8250;</div>
          </Link>
        ) : null}
      </div>

      <div className="hint-line" style={{ marginTop: 14 }}>To change your password, ask your shop owner.</div>

      <button type="button" className="btn btn-ghost" style={{ marginTop: 20 }} onClick={logout}>
        Sign out
      </button>

      <BottomNav />
    </div>
  );
}
