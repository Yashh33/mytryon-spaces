export function Loading({ label = "Loading…" }) {
  return (
    <div className="state-block">
      <span className="spinner-inline" /> {label}
    </div>
  );
}

export function ErrorBlock({ message, onRetry }) {
  return (
    <div className="state-block error">
      <p>{message || "Something went wrong."}</p>
      {onRetry ? (
        <button type="button" className="btn btn-ghost retry-btn" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
