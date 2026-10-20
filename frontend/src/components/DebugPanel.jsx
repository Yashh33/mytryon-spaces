import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const COPIED_MS = 2000;

/** The result page's Debug panel (shops with show_debug on, and the
 * superadmin): the exact prompt sent to the image model for one render, word
 * for word, with a Copy button, and one line of the run's figures. */
export function DebugPanel({ renderId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api
      .get(`/api/debug/generation/${renderId}`)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [renderId]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(data.prompt);
    } catch {
      // older browsers: copy through a hidden text box
      const box = document.createElement("textarea");
      box.value = data.prompt;
      box.setAttribute("readonly", "");
      box.style.position = "fixed";
      box.style.opacity = "0";
      document.body.appendChild(box);
      box.select();
      document.execCommand("copy");
      document.body.removeChild(box);
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }

  if (error) return <div className="debug-panel muted">{error}</div>;
  if (!data) return <div className="debug-panel muted">Loading…</div>;

  // the Draw-on-photo experiment variant that made it ("walls off · open floor off"), when recorded
  const variant = (data.images || []).find((img) => img.role === "guide")?.variant;
  const figures = [data.model, data.quality, data.size, data.elapsed_s != null ? `${data.elapsed_s.toFixed(1)} s` : null, variant]
    .filter(Boolean)
    .join(" · ");
  // tokens and estimated cost, worked out by the server from the usage saved for this render
  const c = data.cost;
  const n = (v) => Number(v || 0).toLocaleString("en-IN");
  const cached = c && (c.cached_text_input || c.cached_image_input) ? ` (cached ${n(c.cached_text_input)} / ${n(c.cached_image_input)})` : "";
  const costLine = c
    ? `input ${n(c.text_input)} text / ${n(c.image_input)} image${cached} · output ${n(c.output)} · ` +
      `$${c.usd.toFixed(4)} · ₹${c.inr.toFixed(2)}`
    : "cost unknown";

  return (
    <div className="debug-panel">
      <div className="debug-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 0 }}>
        <span>Full prompt sent to the image model</span>
        <button type="button" className="link-btn" onClick={copyPrompt}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="debug-facts muted">{figures}</div>
      <div className="debug-facts muted">{costLine}</div>
      <pre className="debug-pre debug-prompt">{data.prompt}</pre>
    </div>
  );
}
