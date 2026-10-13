import { Link } from "react-router-dom";

/** The sticky action bar at the bottom of every step page: Back, a short
 * status line, an optional text action and the primary button. The page's
 * `.screen` needs the `has-step-footer` class so the bar sits at the bottom
 * of the viewport and never covers the last of the content. */
export function StepFooter({
  backTo,
  onBack,
  status,
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryBusyLabel,
  busy = false,
  secondaryLabel,
  onSecondary,
}) {
  const backContent = (
    <>
      <img src="/icons/back.svg" alt="" width={18} height={18} />
      <span className="step-footer-back-text">Back</span>
    </>
  );

  return (
    <>
      <div className="step-footer-space" aria-hidden="true" />
      <div className="step-footer">
        {backTo ? (
          <Link to={backTo} className="step-footer-back" aria-label="Back">
            {backContent}
          </Link>
        ) : onBack ? (
          <button type="button" className="step-footer-back" onClick={onBack} aria-label="Back">
            {backContent}
          </button>
        ) : null}
        {status || secondaryLabel ? (
          <div className={"step-footer-meta" + (secondaryLabel ? "" : " status-only")}>
            {status ? (
              <span className="step-footer-status" aria-live="polite">
                {status}
              </span>
            ) : null}
            {secondaryLabel ? (
              <button type="button" className="step-footer-secondary" onClick={onSecondary}>
                {secondaryLabel}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="step-footer-fill" />
        )}
        <button
          type="button"
          className="btn btn-primary step-footer-primary"
          disabled={primaryDisabled || busy}
          onClick={onPrimary}
        >
          {busy && primaryBusyLabel ? primaryBusyLabel : primaryLabel}
        </button>
      </div>
    </>
  );
}
