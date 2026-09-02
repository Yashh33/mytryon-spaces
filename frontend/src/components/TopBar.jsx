import { Link } from "react-router-dom";

export function TopBar({ backTo, onBack, right, eyebrow }) {
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
        {right}
      </div>
      {eyebrow ? <div className="eyebrow" style={{ marginBottom: 4 }}>{eyebrow}</div> : null}
    </>
  );
}
