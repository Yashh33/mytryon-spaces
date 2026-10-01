import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export function BottomNav() {
  const { user } = useAuth();
  const location = useLocation();
  const isOwner = user?.role === "owner";

  const tabs = [
    { label: "Home", to: "/" },
    ...(isOwner ? [{ label: "Admin", to: "/admin" }] : []),
    { label: "Account", to: "/account" },
  ];

  return (
    <nav className="bottom-nav">
      {tabs.map((t) => (
        <Link key={t.to} to={t.to} className={"bottom-nav-tab" + (location.pathname === t.to ? " active" : "")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
