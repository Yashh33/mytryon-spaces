import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { formatDate, withQuery } from "../utils.js";

const STUDIO_LOOKS = [
  { key: "studio_look_warm", label: "Warm" },
  { key: "studio_look_luxury", label: "Luxury" },
  { key: "studio_look_minimal", label: "Minimal" },
  { key: "studio_look_studio", label: "Studio" },
];
const STUDIO_VIEWS = [
  { key: "studio_view_front", label: "Front" },
  { key: "studio_view_angled", label: "Angled" },
];

export default function AdminPrompt() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const shopId = searchParams.get("shop_id");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [feetInPrompt, setFeetInPrompt] = useState(false);
  const [padRoomPhoto, setPadRoomPhoto] = useState(true);
  const [writerEnabled, setWriterEnabled] = useState(true);
  const [writerPrompt, setWriterPrompt] = useState("");
  const [shapesPrompt, setShapesPrompt] = useState("");
  const [gapWriterPrompt, setGapWriterPrompt] = useState("");
  const [guideStyle, setGuideStyle] = useState("boxes");
  const [studioPrompt, setStudioPrompt] = useState("");
  const [studioEditPrompt, setStudioEditPrompt] = useState("");
  const [studioLookPrompt, setStudioLookPrompt] = useState("");
  const [studioLooks, setStudioLooks] = useState({});
  const [studioViews, setStudioViews] = useState({});
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
    setFeetInPrompt(Boolean(res.feet_in_prompt));
    setPadRoomPhoto(res.pad_room_photo !== false);
    setWriterEnabled(res.placement_writer_enabled);
    setWriterPrompt(res.placement_writer_prompt);
    setShapesPrompt(res.shapes_prompt);
    setGapWriterPrompt(res.gap_writer_prompt);
    setGuideStyle(res.guide_style || "boxes");
    setStudioPrompt(res.studio_prompt);
    setStudioEditPrompt(res.studio_edit_prompt);
    setStudioLookPrompt(res.studio_look_prompt);
    setStudioLooks(Object.fromEntries(STUDIO_LOOKS.map((l) => [l.key, res[l.key]])));
    setStudioViews(Object.fromEntries(STUDIO_VIEWS.map((v) => [v.key, res[v.key]])));
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
      const json = {
        prompt,
        feet_in_prompt: feetInPrompt,
        pad_room_photo: padRoomPhoto,
        placement_writer_enabled: writerEnabled,
        placement_writer_prompt: writerPrompt,
        shapes_prompt: shapesPrompt,
        gap_writer_prompt: gapWriterPrompt,
        guide_style: guideStyle,
        studio_prompt: studioPrompt,
        studio_edit_prompt: studioEditPrompt,
        studio_look_prompt: studioLookPrompt,
        ...studioLooks,
        ...studioViews,
        shop_id: shopIdNum,
      };
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

      <div className="section-label" style={{ marginTop: 26 }}>Sizes in the prompt</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        The floor plan is not to scale. When this is off, no feet are sent to the models: each piece's size is described as a
        share of its wall or of the room, exactly as it was drawn on the plan. Salesmen still pick a width when adding a piece;
        it only sets the block's starting size.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, marginBottom: 12, minHeight: 44 }}>
        <input type="checkbox" checked={feetInPrompt} onChange={(e) => setFeetInPrompt(e.target.checked)} style={{ width: 20, height: 20 }} />
        Send lengths in feet to the models
      </label>

      <div className="section-label" style={{ marginTop: 26 }}>Room photo shape</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        The image model only makes 3:2, 2:3 and square pictures. When this is on, a room photo of another shape (16:9, 4:3…) is
        sent with plain grey borders so the model does not re-frame it, and the picture is cropped back to the photo&apos;s own
        framing. When it is off, the photo is sent as it is.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, marginBottom: 12, minHeight: 44 }}>
        <input type="checkbox" checked={padRoomPhoto} onChange={(e) => setPadRoomPhoto(e.target.checked)} style={{ width: 20, height: 20 }} />
        Pad the room photo to the picture&apos;s shape
      </label>

      <div className="section-label" style={{ marginTop: 26 }}>Placement writer</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Before each picture, a vision model ({data.vision_model}) looks at the room photo and the floor plan and writes the
        placement section from the plan picture alone. If it is off, fails or is slow, the plain placement facts are used instead.
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 700, fontSize: 14, marginBottom: 12, minHeight: 44 }}>
        <input type="checkbox" checked={writerEnabled} onChange={(e) => setWriterEnabled(e.target.checked)} style={{ width: 20, height: 20 }} />
        Use the placement writer
      </label>
      <textarea className="prompt-textarea" spellCheck="false" value={writerPrompt} onChange={(e) => setWriterPrompt(e.target.value)} />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{PIECES}}"}</span>.{" "}
        <button type="button" className="link-btn" onClick={() => setWriterPrompt(data.default_placement_writer_prompt)}>
          Put back the built-in writer prompt
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Draw on photo (Beta) – generation prompt</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Used instead of the generation prompt above when the salesman drew the furniture on the photo. Image 1 is then the
        room photo with the coloured shapes on it; the floor plan and the placement writer are not used.
      </div>
      <textarea className="prompt-textarea" spellCheck="false" value={shapesPrompt} onChange={(e) => setShapesPrompt(e.target.value)} />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{SHAPES}}"}</span> (one paragraph per drawn shape).{" "}
        <span className="mono">{"{{OPEN_FLOOR}}"}</span> is where the gap writer&apos;s section goes (left out if it fails).{" "}
        <button type="button" className="link-btn" onClick={() => setShapesPrompt(data.default_shapes_prompt)}>
          Put back the built-in draw-on-photo prompt
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Draw on photo guide</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        How the drawn pieces appear on the guide image sent to the image model (and the gap writer). 3D boxes raises each
        drawn shape into a see-through box about seat height; the salesman still draws flat shapes. New renders only.
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          ["flat", "Flat shapes"],
          ["boxes", "3D boxes"],
        ].map(([value, label]) => (
          <label key={value} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 14, minHeight: 44 }}>
            <input type="radio" name="guide-style" value={value} checked={guideStyle === value} onChange={() => setGuideStyle(value)} style={{ width: 20, height: 20 }} />
            {label}
          </label>
        ))}
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Draw on photo (Beta) – gap writer</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Before each draw-on-photo render, the guide image (the photo with the shapes and labels, exactly as the image model
        gets it) goes to the vision model with this prompt. Its lines, one per shape, go into the prompt above as &quot;OPEN
        FLOOR AROUND EACH SOFA&quot;. It waits up to 60 seconds and never blocks the render; the result is reused while the
        shapes are unchanged.
      </div>
      <textarea className="prompt-textarea" spellCheck="false" value={gapWriterPrompt} onChange={(e) => setGapWriterPrompt(e.target.value)} />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        <button type="button" className="link-btn" onClick={() => setGapWriterPrompt(data.default_gap_writer_prompt)}>
          Put back the built-in gap writer prompt
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Product photo – create</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Used on New visualisation when an owner turns a showroom sofa photo into a clean website image.
      </div>
      <textarea className="prompt-textarea" spellCheck="false" value={studioPrompt} onChange={(e) => setStudioPrompt(e.target.value)} />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{LOOK}}"}</span> where the chosen look goes, and{" "}
        <span className="mono">{"{{VIEW}}"}</span> where the camera view goes (if left out, the view goes after the look).{" "}
        <button type="button" className="link-btn" onClick={() => setStudioPrompt(data.default_studio_prompt)}>
          Put back the built-in create prompt
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 26 }}>Product photo – change</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Used when the owner asks for a change to a finished product image.
      </div>
      <textarea
        className="prompt-textarea"
        spellCheck="false"
        value={studioEditPrompt}
        onChange={(e) => setStudioEditPrompt(e.target.value)}
      />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{INSTRUCTION}}"}</span>.{" "}
        <button type="button" className="link-btn" onClick={() => setStudioEditPrompt(data.default_studio_edit_prompt)}>
          Put back the built-in change prompt
        </button>
      </div>

      {STUDIO_LOOKS.map((l) => (
        <div key={l.key}>
          <div className="section-label" style={{ marginTop: 26 }}>Product photo – look: {l.label}</div>
          <textarea
            className="prompt-textarea"
            spellCheck="false"
            value={studioLooks[l.key] ?? ""}
            onChange={(e) => setStudioLooks((prev) => ({ ...prev, [l.key]: e.target.value }))}
          />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            <button
              type="button"
              className="link-btn"
              onClick={() => setStudioLooks((prev) => ({ ...prev, [l.key]: data[`default_${l.key}`] }))}
            >
              Put back the built-in {l.label.toLowerCase()} look
            </button>
          </div>
        </div>
      ))}

      {STUDIO_VIEWS.map((v) => (
        <div key={v.key}>
          <div className="section-label" style={{ marginTop: 26 }}>Product photo – view: {v.label}</div>
          <textarea
            className="prompt-textarea"
            spellCheck="false"
            value={studioViews[v.key] ?? ""}
            onChange={(e) => setStudioViews((prev) => ({ ...prev, [v.key]: e.target.value }))}
          />
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            <button
              type="button"
              className="link-btn"
              onClick={() => setStudioViews((prev) => ({ ...prev, [v.key]: data[`default_${v.key}`] }))}
            >
              Put back the built-in {v.label.toLowerCase()} view
            </button>
          </div>
        </div>
      ))}

      <div className="section-label" style={{ marginTop: 26 }}>Product photo – switch look</div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        Used when the owner taps another look on a finished product image. The layout stays the same.
      </div>
      <textarea
        className="prompt-textarea"
        spellCheck="false"
        value={studioLookPrompt}
        onChange={(e) => setStudioLookPrompt(e.target.value)}
      />
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        Must contain <span className="mono">{"{{LOOK}}"}</span>.{" "}
        <button type="button" className="link-btn" onClick={() => setStudioLookPrompt(data.default_studio_look_prompt)}>
          Put back the built-in switch look prompt
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
