import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatDate, withQuery } from "../utils.js";

export default function AdminPrompt() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [writerEnabled, setWriterEnabled] = useState(true);
  const [writerPrompt, setWriterPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const toast = useToast();

  const isSuperadmin = user.role === "superadmin";
  const needsShopRedirect = isSuperadmin && !shopId;
  const backTo = withQuery("/admin", { shop_id: shopId });
  const shopIdNum = shopId ? Number(shopId) : null;

  function apply(res) {
    setData(res);
    setPrompt(res.prompt);
    setWriterEnabled(res.placement_writer_enabled);
    setWriterPrompt(res.placement_writer_prompt);
  }

  async function load() {
    if (needsShopRedirect) return;
    setError(null);
    try {
      apply(await api.get(withQuery("/api/admin/prompt", { shop_id: shopId })));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopId]);

  if (needsShopRedirect) {
    return <Navigate to="/super" replace />;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const json = { prompt, placement_writer_enabled: writerEnabled, placement_writer_prompt: writerPrompt, shop_id: shopIdNum };
      apply(await api.post("/api/admin/prompt", { json }));
      toast("Saved.");
    } catch (err) {
      toast(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setResetting(true);
    try {
      const res = await api.post(withQuery("/api/admin/prompt/reset", { shop_id: shopId }));
      setData(res);
      setPrompt(res.prompt);
      toast("Reset to the built-in default.");
    } catch (err) {
      toast(err.message);
    } finally {
      setResetting(false);
    }
  }

  const crumbs = [{ label: "Admin", to: backTo }, { label: "Generation prompt" }];

  if (!data && !error) return <div className="screen screen-narrow"><TopBar backTo={backTo} crumbs={crumbs} /><Loading /></div>;
  if (error) return <div className="screen screen-narrow"><TopBar backTo={backTo} crumbs={crumbs} /><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen screen-narrow">
      <TopBar backTo={backTo} crumbs={crumbs} />
      <div className="eyebrow">Admin</div>
      <h1 style={{ marginBottom: 4 }}>Generation prompt</h1>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
        {data.updated_at ? "Last saved " + formatDate(data.updated_at) : "Using the built-in default"}
      </div>

      <textarea className="prompt-textarea" spellCheck="false" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <div className="section-label" style={{ marginTop: 26 }}>Placement writer</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Before each picture, a vision model ({data.vision_model}) looks at the room photo and the floor plan and rewrites the
        placement section. If it is off, fails or is slow, the plain placement facts are used instead.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, marginBottom: 12, minHeight: 44 }}>
        <input type="checkbox" checked={writerEnabled} onChange={(e) => setWriterEnabled(e.target.checked)} style={{ width: 20, height: 20 }} />
        Use the placement writer
      </label>
      <textarea className="prompt-textarea" spellCheck="false" value={writerPrompt} onChange={(e) => setWriterPrompt(e.target.value)} />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{FACTS}}"}</span>.{" "}
        <button type="button" className="link-btn" onClick={() => setWriterPrompt(data.default_placement_writer_prompt)}>
          Put back the built-in writer prompt
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={resetting} onClick={handleReset}>
          {resetting ? "Resetting…" : "Reset generation prompt to default"}
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Placeholders you can use</div>
      <div className="placeholder-list">
        {data.placeholders.map((p) => (
          <div key={p.token} className="placeholder-item">
            <div className="placeholder-token mono">{p.token}</div>
            <div className="placeholder-desc">{p.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
