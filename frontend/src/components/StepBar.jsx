import { Link } from "react-router-dom";

const STEPS = [
  { n: 1, label: "Room" },
  { n: 2, label: "Furniture" },
  { n: 3, label: "Placement" },
  { n: 4, label: "Finish" },
];

export function StepBar({ current, attemptId, roomId }) {
  function targetFor(n) {
    if (n === 1) return `/room/${roomId}`;
    if (n === 2) return `/attempt/${attemptId}/furniture`;
    if (n === 3) return `/attempt/${attemptId}/place`;
    return `/attempt/${attemptId}/finish`;
  }

  return (
    <div className="step-bar">
      {STEPS.map((s) => {
        const state = s.n < current ? "done" : s.n === current ? "current" : "upcoming";
        const content = (
          <>
            <span className={"step-dot" + (state === "current" ? " current" : state === "done" ? " done" : "")}>{s.n}</span>
            <span className="step-label">{s.label}</span>
          </>
        );
        return state === "done" ? (
          <Link key={s.n} to={targetFor(s.n)} className="step-seg step-seg-link">
            {content}
          </Link>
        ) : (
          <span key={s.n} className={"step-seg" + (state === "upcoming" ? " step-seg-muted" : "")}>
            {content}
          </span>
        );
      })}
    </div>
  );
}
