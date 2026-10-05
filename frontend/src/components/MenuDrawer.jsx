import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

const OWNER_ROLES = ["owner", "superadmin"];
const ROLE_LABELS = { salesman: "Salesman", owner: "Owner", superadmin: "Superadmin" };

export function MenuDrawer({ open, onClose }) {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [credits, setCredits] = useState(null);

  useEffect(() => {
    if (!open) return;
    if (user?.role === "superadmin") return;
    api
      .get("/api/shop/credits")
      .then(setCredits)
      .catch(() => setCredits(null));
  }, [open, user?.role]);

  useEffect(() => {
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  if (!user) return null;

  const isSuperadmin = user.role === "superadmin";
  const isOwnerRole = OWNER_ROLES.includes(user.role);
  const homeTarget = isSuperadmin ? "/super" : "/";

  const rows = [
    { key: "home", icon: "home", label: "Home", to: homeTarget },
    ...(!isSuperadmin ? [{ key: "new", icon: "new-visualisation", label: "New visualisation", to: "/?new=1" }] : []),
    { key: "account", icon: "account", label: "Account & credits", to: "/account" },
    ...(isOwnerRole ? [{ key: "admin", icon: "admin", label: "Admin", to: "/admin" }] : []),
    ...(isSuperadmin ? [{ key: "shops", icon: "shops", label: "Shops", to: "/super" }] : []),
  ];

  return (
    <>
      <div className={"menu-drawer-backdrop" + (open ? " open" : "")} onClick={onClose} />
      <div className={"menu-drawer" + (open ? " open" : "")} role="dialog" aria-modal="true" aria-label="Menu">
        <div className="menu-drawer-top">
          <img src="/logo.png" alt="Reflection Lifestyle" className="menu-drawer-logo" />
          <button type="button" className="menu-drawer-close" aria-label="Close menu" onClick={onClose}>
            <img src="/icons/close.svg" alt="" width={20} height={20} />
          </button>
        </div>

        <div className="menu-drawer-user">
          <div className="name">{user.name}</div>
          <div className="role mono muted">{ROLE_LABELS[user.role] || user.role}</div>
        </div>

        {!isSuperadmin && credits ? (
          <div className="menu-drawer-credits">{credits.balance.toLocaleString()} credits left</div>
        ) : null}

        <div className="menu-drawer-rows">
          {rows.map((r) => (
            <Link
              key={r.key}
              to={r.to}
              className={"menu-drawer-row" + (location.pathname === r.to.split("?")[0] ? " active" : "")}
            >
              <span className="menu-drawer-row-tile">
                <img src={`/icons/${r.icon}.svg`} alt="" width={20} height={20} />
              </span>
              {r.label}
            </Link>
          ))}
          <button type="button" className="menu-drawer-row menu-drawer-row-danger" onClick={logout}>
            <span className="menu-drawer-row-tile menu-drawer-row-tile-danger">
              <img src="/icons/sign-out.svg" alt="" width={20} height={20} />
            </span>
            Sign out
          </button>
        </div>
      </div>
    </>
  );
}
