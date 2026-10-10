import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api.js";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatBytes } from "../utils.js";

/** Owner-only: exactly what one render was made from — the images, the
 * final prompt, and what the placement writer was given, wrote and whether
 * its section was used. Reached from /debug/latest. */
export default function DebugGeneration() {
  const { renderId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setError(null);
    try {
      setData(await api.get(`/api/debug/generation/${renderId}`));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderId]);

  const crumbs = [{ label: "Admin", to: "/admin" }, { label: `Render ${renderId}` }];
  if (!data && !error) return <div className="screen"><TopBar backTo="/admin" crumbs={crumbs} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo="/admin" crumbs={crumbs} /><ErrorBlock message={error} onRetry={load} /></div>;

  const writer = data.placement_writer;
  const plan = data.images.find((img) => img.role === "plan");
  const sent = data.images.filter((img) => img.role !== "plan");
  const writerUsage = writer?.usage;

  return (
    <div className="screen">
      <TopBar backTo="/admin" crumbs={crumbs} />
      <div className="eyebrow">Debug</div>
      <h1 style={{ marginBottom: 4 }}>Render {data.render_id}</h1>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
        {data.customer_name} &middot; attempt {data.attempt_id} &middot; {data.model} &middot; {data.quality} &middot; {data.size} &middot;{" "}
        {data.elapsed_s?.toFixed(1)} s
      </div>

      <div className="debug-images">
        <figure>
          <img src={data.output_image_url} alt="" />
          <figcaption>Result</figcaption>
        </figure>
        {sent.map((img, i) => (
          <figure key={img.url + i}>
            <img src={img.url} alt="" />
            <figcaption>
              Image {i + 1} &middot; {img.role} &middot; {img.width}&times;{img.height} &middot; {formatBytes(img.size_bytes)}
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Placement writer</div>
      {!writer ? (
        <div className="muted" style={{ fontSize: 13 }}>Not recorded for this render (made before the writer existed, or placement was skipped).</div>
      ) : (
        <>
          <div className={"debug-verdict " + (writer.used ? "used" : "fallback")}>
            {writer.used ? "USED — the writer's section went into the prompt" : `FALLBACK to the facts — ${writer.reason || "no reason recorded"}`}
          </div>
          <div className="muted" style={{ fontSize: 12.5, margin: "6px 0 14px" }}>
            {writer.model ? `${writer.model} · ` : ""}
            {writer.elapsed_s != null ? `${writer.elapsed_s} s · ` : ""}
            {writerUsage ? `${writerUsage.prompt_tokens} in / ${writerUsage.completion_tokens} out tokens` : "no token usage recorded"}
          </div>

          {plan ? (
            <div className="debug-images">
              <figure>
                <img src={plan.url} alt="" />
                <figcaption>
                  Plan PNG &middot; sent to the writer only, never to the image model &middot; {plan.width}&times;{plan.height}
                </figcaption>
              </figure>
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>No plan PNG.</div>
          )}

          <div className="debug-label">Facts (given to the writer; used as-is on fallback)</div>
          <pre className="debug-pre">{writer.facts}</pre>
          <div className="debug-label">Writer output (raw)</div>
          <pre className="debug-pre">{writer.output || "—"}</pre>
          <div className="debug-label">CONFLICTS</div>
          <pre className="debug-pre">{writer.conflicts || "—"}</pre>
        </>
      )}

      <div className="section-label" style={{ marginTop: 26 }}>Prompt sent to the image model</div>
      <pre className="debug-pre">{data.prompt}</pre>

      <div className="section-label" style={{ marginTop: 26 }}>Image model usage</div>
      <pre className="debug-pre">{JSON.stringify(data.usage, null, 2)}</pre>
    </div>
  );
}
