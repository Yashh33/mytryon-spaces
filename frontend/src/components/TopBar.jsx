import { Link } from "react-router-dom";
import { useAuth } from "../auth.jsx";

export function TopBar({ backTo, onBack, right, eyebrow, crumbs, home = true }) {
  const { user } = useAuth();
  const homeTarget = user?.role === "superadmin" ? "/super" : "/";

  return (
    <>
      <div className="top-actions">
        {backTo ? (
          <Link to={backTo} className="back-btn" aria-label="Back">
            &#8592;
          </Link>
        ) : onBack ? (
          <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
            &#8592;
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {home ? (
            <Link to={homeTarget} className="home-btn" aria-label="Home">
              &#8962;
            </Link>
          ) : null}
          {right}
        </div>
      </div>
      {eyebrow ? <div className="eyebrow" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
      {crumbs && crumbs.length ? (
        <div className="crumb-row">
          {crumbs.map((c, i) => (
            <span key={i}>
              {i > 0 ? <span className="crumb-sep"> &rsaquo; </span> : null}
              {c.to && i < crumbs.length - 1 ? (
                <Link to={c.to} className="crumb-link">
                  {c.label}
                </Link>
              ) : (
                <span className={i === crumbs.length - 1 ? "crumb-current" : ""}>{c.label}</span>
              )}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
