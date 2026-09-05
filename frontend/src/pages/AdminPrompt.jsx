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
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const toast = useToast();

  const isSuperadmin = user.role === "superadmin";
  const needsShopRedirect = isSuperadmin && !shopId;
  const backTo = withQuery("/admin", { shop_id: shopId });
  const shopIdNum = shopId ? Number(shopId) : null;

  async function load() {
    if (needsShopRedirect) return;
    setError(null);
    try {
      const res = await api.get(withQuery("/api/admin/prompt", { shop_id: shopId }));
      setData(res);
      setPrompt(res.prompt);
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
      const res = await api.post("/api/admin/prompt", { json: { prompt, shop_id: shopIdNum } });
      setData(res);
      setPrompt(res.prompt);
      toast("Prompt saved.");
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

  if (!data && !error) return <div className="screen"><TopBar backTo={backTo} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo={backTo} /><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo={backTo} />
      <div className="eyebrow">Admin</div>
      <h1 style={{ marginBottom: 4 }}>Generation prompt</h1>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 16 }}>
        {data.updated_at ? "Last saved " + formatDate(data.updated_at) : "Using the built-in default"}
      </div>

      <textarea className="prompt-textarea" spellCheck="false" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-ghost" disabled={resetting} onClick={handleReset}>
          {resetting ? "Resetting…" : "Reset to default"}
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
