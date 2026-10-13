import { useEffect, useMemo, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { Chip } from "../components/Chip.jsx";
import { UploadBox } from "../components/UploadBox.jsx";
import { ErrorBlock, Loading } from "../components/StateBlock.jsx";
import { debugLog, withQuery } from "../utils.js";

const LOOKS = [
  { value: "warm", label: "Warm" },
  { value: "luxury", label: "Luxury" },
  { value: "minimal", label: "Minimal" },
  { value: "studio", label: "Studio" },
];
const VIEWS = [
  { value: "front", label: "Front" },
  { value: "angled", label: "Angled" },
];
const POLL_MS = 2500;
const INSTRUCTION_MIN = 3;
const INSTRUCTION_MAX = 300;

export default function NewVisualisation() {
  const { user } = useAuth();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const isSuperadmin = user.role === "superadmin";
  const needsShopRedirect = isSuperadmin && !shopId;

  const [images, setImages] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [look, setLook] = useState("warm");
  const [view, setView] = useState("front");
  // the "Try another look" chip tapped on the current image while its job runs;
  // separate from `look`, which is only the Create choice on the left.
  const [pendingLook, setPendingLook] = useState(null);
  const [currentId, setCurrentId] = useState(null);
  // the running job: { jobId, previewUrl } — previewUrl is what the scanner runs over
  const [job, setJob] = useState(null);
  const [instruction, setInstruction] = useState("");
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const photoUrl = useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  useEffect(() => {
    return () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    };
  }, [photoUrl]);

  const withShop = (path, params = {}) => withQuery(path, { ...params, shop_id: shopId });
  const fileUrl = (id, kind) => withShop(`/api/studio/images/${id}/file`, { kind });

  async function load() {
    if (needsShopRedirect) return;
    try {
      const data = await api.get(withShop("/api/studio/images"));
      setImages(data.images);
      setLoadError(null);
      return data.images;
    } catch (err) {
      setLoadError(err.message);
      return null;
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  useEffect(() => {
    if (!job) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const res = await api.get(withShop(`/api/studio/jobs/${job.jobId}`));
        if (stopped || res.status === "processing") return;
        stopped = true;
        clearInterval(timer);
        await load();
        if (res.status === "done") {
          setCurrentId(res.image_id);
          setInstruction("");
        } else {
          toast(res.message || "That didn't work. Your credits were returned.");
        }
        setPendingLook(null);
        setJob(null);
      } catch (err) {
        if (err.status !== 404 || stopped) return;
        // the server restarted and forgot the job: show whatever the list says now
        stopped = true;
        clearInterval(timer);
        await load();
        setPendingLook(null);
        setJob(null);
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  if (needsShopRedirect) {
    return <Navigate to="/super" replace />;
  }

  const backTo = isSuperadmin ? `/super/shop/${shopId}` : "/";
  const doneImages = (images || []).filter((im) => im.status === "done");
  const current = doneImages.find((im) => im.id === currentId) || null;
  const busy = starting || !!job;

  async function start(request, previewUrl) {
    setStarting(true);
    try {
      const res = await request();
      debugLog(`studio job ${res.job_id} image ${res.id}`);
      setJob({ jobId: res.job_id, previewUrl });
    } catch (err) {
      // includes the server's not-enough-credits message (402)
      toast(err.message);
      setPendingLook(null);
    } finally {
      setStarting(false);
    }
  }

  function handleCreate() {
    if (!photo) return toast("Please add a sofa photo first.");
    const form = new FormData();
    form.append("photo", photo);
    form.append("look", look);
    form.append("view", view);
    if (shopId) form.append("shop_id", shopId);
    start(() => api.post("/api/studio/images", { form }), photoUrl);
  }

  function handleChange() {
    const text = instruction.trim();
    if (text.length < INSTRUCTION_MIN) return toast("Please describe the change.");
    start(
      () => api.post(`/api/studio/images/${current.id}/change`, { json: { instruction: text, shop_id: shopId ? Number(shopId) : null } }),
      fileUrl(current.id, "result")
    );
  }

  function handleSwitchLook(value) {
    if (busy || value === current.look) return;
    setPendingLook(value);
    start(
      () => api.post(`/api/studio/images/${current.id}/look`, { json: { look: value, shop_id: shopId ? Number(shopId) : null } }),
      fileUrl(current.id, "result")
    );
  }

  function handleRetry() {
    start(() => api.post(withShop(`/api/studio/images/${current.id}/retry`)), fileUrl(current.id, "source"));
  }

  async function handleDownload() {
    try {
      const res = await fetch(fileUrl(current.id, "result"), { credentials: "include" });
      if (!res.ok) throw new Error("download failed");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `sofa-${current.id}.jpg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      toast("Couldn't download the image. Please try again.");
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this image? This can't be undone.")) return;
    setDeleting(true);
    try {
      await api.del(withShop(`/api/studio/images/${current.id}`));
      setCurrentId(null);
      await load();
      toast("Deleted.");
    } catch (err) {
      toast(err.message);
    } finally {
      setDeleting(false);
    }
  }

  function renderLookChips() {
    return (
      <div className="field" style={{ marginTop: 16 }}>
        <label>Try another look – keeps the same layout</label>
        <div className="chips">
          {LOOKS.map((l) => (
            <button
              key={l.value}
              type="button"
              className={"chip" + (l.value === current.look ? " selected" : "") + (l.value === pendingLook ? " pending" : "")}
              aria-pressed={l.value === current.look}
              disabled={busy}
              onClick={() => handleSwitchLook(l.value)}
            >
              {l.value === pendingLook ? `Applying ${l.label}…` : l.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function renderResult() {
    if (job) {
      return (
        <>
          <div className="st-frame st-frame-scan">
            {job.previewUrl ? <img src={job.previewUrl} alt="" /> : null}
            <div className="gen-scan" />
            <div className="st-scan-label">Making your sofa image…</div>
          </div>
          {current && pendingLook ? renderLookChips() : null}
        </>
      );
    }
    if (!current) {
      return (
        <div className="st-frame st-empty">
          <div>
            <div className="st-empty-title">Your website image appears here</div>
            <div className="muted">Add a sofa photo and tap Create.</div>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="st-frame">
          <img src={fileUrl(current.id, "result")} alt={`Sofa image ${current.id}`} />
          <div className="st-original">
            <img src={fileUrl(current.id, "source")} alt="Original photo" />
            <span>ORIGINAL</span>
          </div>
        </div>
        {current.instruction ? <div className="hint-line">Change: {current.instruction}</div> : null}

        {renderLookChips()}

        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="st-change">Ask for a change – keeps the sofa exactly the same</label>
          <div className="st-change">
            <input
              id="st-change"
              type="text"
              value={instruction}
              maxLength={INSTRUCTION_MAX}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. make the wall a little warmer"
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || instruction.trim().length < INSTRUCTION_MIN}
              onClick={handleChange}
            >
              Apply
            </button>
          </div>
        </div>

        <div className="st-actions">
          <button type="button" className="btn btn-ghost" onClick={handleDownload}>
            Download
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={handleRetry}>
            Try again
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || deleting} onClick={handleDelete}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="screen">
      <TopBar backTo={backTo} />
      <div className="st-head">
        <h1>New visualisation</h1>
        <span className="badge-owner">Owner &amp; superadmin only</span>
      </div>
      <div className="muted st-sub">Add a sofa photo – get one clean website image. Salesmen never see this page or these images.</div>

      {loadError && !images ? (
        <ErrorBlock message={loadError} onRetry={load} />
      ) : !images ? (
        <Loading />
      ) : (
        <>
          <div className="st-layout">
            <div className="st-left">
              <div className="field">
                <label>1 · Sofa photo</label>
                <UploadBox file={photo} onChange={setPhoto} required label="Add the sofa photo" />
              </div>
              <div className="field">
                <label>2 · The look</label>
                <div className="chips">
                  {LOOKS.map((l) => (
                    <Chip key={l.value} selected={l.value === look} onClick={() => setLook(l.value)}>
                      {l.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="field">
                <label>3 · View</label>
                <div className="chips">
                  {VIEWS.map((v) => (
                    <Chip key={v.value} selected={v.value === view} onClick={() => setView(v.value)}>
                      {v.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <button type="button" className="btn btn-primary st-create" disabled={busy || !photo} onClick={handleCreate}>
                {starting && !job ? "Starting…" : "Create image"}
              </button>
            </div>
            <div className="st-right">{renderResult()}</div>
          </div>

          <div className="section-label" style={{ marginTop: 28 }}>Earlier images</div>
          {doneImages.length ? (
            <div className="st-grid">
              {doneImages.map((im) => (
                <button
                  key={im.id}
                  type="button"
                  className={"st-thumb" + (im.id === currentId ? " active" : "")}
                  disabled={!!job}
                  onClick={() => {
                    setCurrentId(im.id);
                    setInstruction("");
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                >
                  <img src={fileUrl(im.id, "result")} alt={`Sofa image ${im.id}`} loading="lazy" />
                </button>
              ))}
            </div>
          ) : (
            <div className="muted" style={{ fontSize: 13 }}>No images yet.</div>
          )}
        </>
      )}
    </div>
  );
}
