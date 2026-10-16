import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "./Toast.jsx";
import { SafeImg } from "./SafeImg.jsx";

const GUIDE_STYLE_LABEL = { flat: "flat shapes", boxes: "3D boxes" };

/** The result page's Debug panel (shops with show_debug on, and the
 * superadmin): what was sent to the image model for one render — every
 * image in order, the full prompt, the gap writer's lines and the run's
 * figures. The same data as the superadmin Debug page. */
export function DebugPanel({ renderId }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

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

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(data.prompt);
      toast("Prompt copied.");
    } catch {
      toast("Couldn't copy — select the text and copy it instead.");
    }
  }

  if (error) return <div className="debug-panel muted">{error}</div>;
  if (!data) return <div className="debug-panel muted">Loading…</div>;

  const sent = data.images.filter((img) => img.role !== "plan"); // the plan PNG goes to the placement writer only
  const guide = sent.find((img) => img.role === "guide");
  const gap = data.gap_writer;

  return (
    <div className="debug-panel">
      <div className="debug-facts">
        {guide ? <span>Guide: {GUIDE_STYLE_LABEL[guide.guide_style || "flat"] || guide.guide_style}</span> : null}
        <span>Model: {data.model}</span>
        <span>Size: {data.size}</span>
        <span>Quality: {data.quality}</span>
        <span>Time: {data.elapsed_s != null ? `${data.elapsed_s.toFixed(1)} s` : "—"}</span>
      </div>

      {guide?.shape_facts?.length ? (
        <>
          <div className="debug-label">L / corner sofas, as worked out from the shapes</div>
          <pre className="debug-pre">
            {guide.shape_facts
              .map(
                (f) =>
                  `${f.tag}: back against the ${f.wall} wall; joins at ${f.end}, runs ${f.direction}${f.along || ""}` +
                  (f.second_wall ? `; the shorter part's back against the ${f.second_wall} wall` : "")
              )
              .join("\n")}
          </pre>
        </>
      ) : null}

      <div className="debug-label">Images sent, in order</div>
      <div className="debug-images">
        {sent.map((img, i) => (
          <figure key={img.url + i}>
            <a href={img.url} target="_blank" rel="noreferrer">
              <SafeImg src={img.url} />
            </a>
            <figcaption>
              Image {i + 1} &middot; {img.role}
              {img.role === "guide" ? ` (${GUIDE_STYLE_LABEL[img.guide_style || "flat"] || img.guide_style})` : ""}
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="debug-label" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Prompt</span>
        <button type="button" className="link-btn" onClick={copyPrompt}>
          Copy
        </button>
      </div>
      <pre className="debug-pre debug-prompt">{data.prompt}</pre>

      {gap ? (
        <>
          <div className="debug-label">Gap writer</div>
          <pre className="debug-pre">
            {gap.lines?.length ? gap.lines.join("\n") : `Left out — ${gap.reason || "no lines"}`}
          </pre>
        </>
      ) : null}
    </div>
  );
}
