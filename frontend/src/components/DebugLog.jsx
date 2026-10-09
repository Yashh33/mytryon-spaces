import { useEffect, useState } from "react";
import { clearDebug, getDebugLines, isDebug, subscribeDebug } from "../utils.js";

export function DebugLog() {
  const [, setTick] = useState(0);
  const on = isDebug();

  useEffect(() => {
    if (!on) return undefined;
    return subscribeDebug(() => setTick((t) => t + 1));
  }, [on]);

  if (!on) return null;
  const lines = getDebugLines();
  return (
    <div className="debug-log">
      <button type="button" onClick={clearDebug}>Clear</button>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}
