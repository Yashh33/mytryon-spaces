import { Link } from "react-router-dom";

export function TopBar({ backTo, onBack, right, eyebrow, crumbs }) {
  return (
    <>
      <div className="top-actions">
        {backTo ? (
          <Link to={backTo} className="back-btn" aria-label="Back">
            <img src="/icons/back.svg" alt="" width={20} height={20} />
          </Link>
        ) : onBack ? (
          <button type="button" className="back-btn" onClick={onBack} aria-label="Back">
            <img src="/icons/back.svg" alt="" width={20} height={20} />
          </button>
        ) : (
          <span />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>{right}</div>
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
