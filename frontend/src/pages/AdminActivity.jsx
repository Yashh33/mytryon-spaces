import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { withQuery } from "../utils.js";

const REFRESH_MS = 10000;
const KIND_LABEL = { generation: "Picture", fix: "Fix this", studio: "Product photo" };
const STATUS_LABEL = { running: "Running", done: "Done", error: "Failed", interrupted: "Interrupted" };

function time(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function dayTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time(iso)}`;
}

function duration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function JobLine({ job, showShop, when = time }) {
  const what = [KIND_LABEL[job.kind] || job.kind, job.attempt_id ? `attempt ${job.attempt_id}` : null, job.source_render_id ? `fix of render ${job.source_render_id}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="activity-row">
      <div className="activity-main">
        <div className="activity-what">
          {what}
          {job.render_url ? (
            <a href={job.render_url} target="_blank" rel="noreferrer" className="activity-link">
              render {job.render_id}
            </a>
          ) : null}
        </div>
        <div className="activity-who">
          {[showShop ? job.shop : null, job.user || "—", `started ${when(job.started_at)}`].filter(Boolean).join(" · ")}
        </div>
        {job.reason && job.status !== "done" ? <div className="activity-reason">{job.reason}</div> : null}
      </div>
      <div className={`activity-status s-${job.status}`}>
        {STATUS_LABEL[job.status] || job.status}
        <span>{duration(job.seconds)}</span>
      </div>
    </div>
  );
}

/** Live activity: what is generating right now, the last 24 hours and
 * recent failures. Refreshes itself every 10 seconds. */
export default function AdminActivity() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const stopped = useRef(false);
  const isSuperadmin = user.role === "superadmin";

  async function load() {
    try {
      const res = await api.get(withQuery("/api/admin/activity", { shop_id: shopId }));
      if (stopped.current) return;
      setData(res);
      setError(null);
      setUpdatedAt(new Date());
    } catch (err) {
      if (!stopped.current) setError(err.message);
    }
  }

  useEffect(() => {
    stopped.current = false;
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  const backTo = isSuperadmin && !shopId ? "/super" : withQuery("/admin", { shop_id: shopId });
  const crumbs = [{ label: "Admin", to: backTo }, { label: "Live activity" }];
  if (!data && !error) return <div className="screen screen-narrow"><TopBar backTo={backTo} crumbs={crumbs} /><Loading /></div>;
  if (!data) return <div className="screen screen-narrow"><TopBar backTo={backTo} crumbs={crumbs} /><ErrorBlock message={error} onRetry={load} /></div>;

  const showShop = data.shop == null; // the superadmin's all-shops view
  return (
    <div className="screen screen-narrow">
      <TopBar backTo={backTo} crumbs={crumbs} />
      <div className="eyebrow">Admin</div>
      <h1 style={{ marginBottom: 4 }}>Live activity</h1>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
        {data.shop || "All shops"} · updates every 10 seconds
        {updatedAt ? ` · last ${updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}
        {error ? " · couldn't refresh, retrying" : ""}
        {isSuperadmin && shopId ? (
          <>
            {" · "}
            <Link to="/admin/activity" className="link-btn">All shops</Link>
          </>
        ) : null}
      </div>

      <div className="section-label">Running now ({data.running.length})</div>
      {data.running.length ? (
        <div className="activity-list">
          {data.running.map((job) => <JobLine key={job.id} job={job} showShop={showShop} />)}
        </div>
      ) : (
        <div className="muted activity-empty">Nothing is generating right now — a good moment to deploy.</div>
      )}

      <div className="section-label" style={{ marginTop: 24 }}>Last 24 hours ({data.recent.length})</div>
      {data.recent.length ? (
        <div className="activity-list">
          {data.recent.map((job) => <JobLine key={job.id} job={job} showShop={showShop} />)}
        </div>
      ) : (
        <div className="muted activity-empty">No pictures in the last 24 hours.</div>
      )}

      <div className="section-label" style={{ marginTop: 24 }}>Failures, last 7 days ({data.failures.length})</div>
      {data.failures.length ? (
        <div className="activity-list">
          {data.failures.map((job) => <JobLine key={job.id} job={job} showShop={showShop} when={dayTime} />)}
        </div>
      ) : (
        <div className="muted activity-empty">No failures.</div>
      )}
      <div className="muted" style={{ fontSize: 12, marginTop: 18 }}>
        Jobs are listed from the update that added this page; earlier pictures are not shown here.
      </div>
    </div>
  );
}
