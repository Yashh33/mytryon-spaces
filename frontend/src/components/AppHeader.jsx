import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth.jsx";
import { MenuDrawer } from "./MenuDrawer.jsx";

export function AppHeader() {
  const { user } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const homeTarget = user?.role === "superadmin" ? "/super" : "/";

  return (
    <>
      <header className="app-header">
        <Link to={homeTarget} className="app-header-logo">
          <img src="/logo.png" alt="Reflection Lifestyle" height={36} />
        </Link>
        <button type="button" className="app-header-menu-btn" aria-label="Menu" onClick={() => setMenuOpen(true)}>
          <img src="/icons/menu.svg" alt="" width={24} height={24} />
        </button>
      </header>
      <MenuDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
    </>
  );
}
