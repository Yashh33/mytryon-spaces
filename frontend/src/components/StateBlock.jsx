export function Loading({ label = "Loading…" }) {
  return (
    <div className="state-block">
      <span className="spinner-inline" /> {label}
    </div>
  );
}

export function RowSkeleton({ count = 5 }) {
  return (
    <div className="row-list">
      {Array.from({ length: count }).map((_, i) => (
        <div className="row-item" key={i}>
          <div className="skel skel-avatar" />
          <div className="info">
            <div className="skel skel-line w-60" style={{ marginBottom: 8 }} />
            <div className="skel skel-line w-40" style={{ height: 9 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function RoomCardSkeleton({ count = 3 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="room-card" key={i}>
          <div className="skel skel-thumb" />
          <div className="body">
            <div className="info">
              <div className="skel skel-line w-60" style={{ marginBottom: 8 }} />
              <div className="skel skel-line w-40" style={{ height: 9 }} />
            </div>
          </div>
        </div>
      ))}
    </>
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
