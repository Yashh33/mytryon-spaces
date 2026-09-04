import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatDate } from "../utils.js";

export default function AdminPrompt() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const toast = useToast();

  async function load() {
    setError(null);
    try {
      const res = await api.get("/api/admin/prompt");
      setData(res);
      setPrompt(res.prompt);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await api.post("/api/admin/prompt", { json: { prompt } });
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
      const res = await api.post("/api/admin/prompt/reset");
      setData(res);
      setPrompt(res.prompt);
      toast("Reset to the built-in default.");
    } catch (err) {
      toast(err.message);
    } finally {
      setResetting(false);
    }
  }

  if (!data && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen">
      <TopBar backTo="/admin" />
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
