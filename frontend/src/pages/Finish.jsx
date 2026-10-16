import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { UploadBox } from "../components/UploadBox.jsx";
import { useAdjustMode } from "../adjustMode.js";
import { Chip } from "../components/Chip.jsx";
import { photoUploadError } from "../utils.js";

const ROOM_TREATMENTS = [
  { value: "keep", label: "Keep room as it is", desc: "Same walls, floor and decor – only the furniture is added" },
  { value: "warm", label: "Aesthetic warm", desc: "Cosy home: warm light, rug, maybe art or a plant" },
  { value: "luxury", label: "Luxury", desc: "Deep tones, marble, brass, rich finishes" },
  { value: "minimal", label: "Minimal", desc: "White walls, light wood, almost empty" },
];
const LIGHTINGS = [
  { value: "warm", label: "Warm", desc: "Soft golden tones, cosy evening feel" },
  { value: "daylight", label: "Daylight", desc: "Bright, natural light from the windows" },
  { value: "studio", label: "Studio", desc: "Even, clean showroom light" },
];
const SWATCHES = [
  { name: "Ivory", hex: "#EDE6D8" },
  { name: "Sand beige", hex: "#CDB79A" },
  { name: "Camel", hex: "#B9782F" },
  { name: "Terracotta", hex: "#B5543A" },
  { name: "Bottle green", hex: "#244034" },
  { name: "Navy blue", hex: "#24324F" },
  { name: "Charcoal grey", hex: "#3C3B3A" },
  { name: "Blush pink", hex: "#D9A7A0" },
];
const MATERIALS = [
  { value: "fabric", label: "Fabric" },
  { value: "velvet", label: "Velvet" },
  { value: "leather", label: "Leather" },
  { value: "faux_leather", label: "Faux leather" },
  { value: "boucle", label: "Bouclé" },
  { value: "linen", label: "Linen" },
];
const NOTE_MAX = 300;

function materialLabel(value) {
  return MATERIALS.find((m) => m.value === value)?.label || null;
}

function finishSummary(item) {
  const parts = [];
  if (item.colour_hex) parts.push(item.colour_name || item.colour_hex);
  if (item.fabric_url) parts.push("Your fabric");
  else if (item.material) parts.push(materialLabel(item.material));
  return parts.length ? parts.join(" · ") : "As photo";
}

function isLight(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
}

function PieceCard({ item, saving, onSave }) {
  const [showUpload, setShowUpload] = useState(false);
  const [customHex, setCustomHex] = useState(null);
  const pickTimer = useRef(null);

  useEffect(() => () => clearTimeout(pickTimer.current), []);

  const hasColour = Boolean(item.colour_hex);
  const isSwatch = SWATCHES.some((s) => s.hex.toUpperCase() === (item.colour_hex || "").toUpperCase());
  const customSelected = hasColour && !isSwatch;
  const pickerHex = customHex || (customSelected ? item.colour_hex : "#8A857E");
  const anythingSet = hasColour || Boolean(item.material) || Boolean(item.fabric_url);

  function pickCustom(hex) {
    setCustomHex(hex);
    clearTimeout(pickTimer.current);
    // the native picker fires on every drag step — save once it settles
    pickTimer.current = setTimeout(() => onSave(item, { colour_name: hex, colour_hex: hex }), 400);
  }

  function addFabric(file) {
    setShowUpload(false);
    onSave(item, { material: null }, { photo: file });
  }

  return (
    <div className="piece-card">
      <div className="piece-head">
        <img className="piece-thumb" src={item.photo_url} alt="" />
        <div className="piece-title">
          <div className="name">
            {item.category} &middot; {item.type}
          </div>
          <div className="sub mono muted">
            {saving ? "Saving…" : ""}
          </div>
        </div>
        {anythingSet ? (
          <button
            type="button"
            className="link-btn"
            disabled={saving}
            onClick={() => onSave(item, { colour_name: null, colour_hex: null, material: null }, { clearFabric: true })}
          >
            Back to photo
          </button>
        ) : null}
      </div>

      <div className="piece-row-label">
        <span className="section-label">Colour</span>
        <span className="piece-choice">{hasColour ? item.colour_name || item.colour_hex : "As photo"}</span>
      </div>
      <div className="swatches">
        <button
          type="button"
          className={"swatch swatch-photo" + (!hasColour ? " selected" : "")}
          aria-label="As photo"
          aria-pressed={!hasColour}
          onClick={() => onSave(item, { colour_name: null, colour_hex: null })}
        >
          {!hasColour ? <span className="swatch-check">&#10003;</span> : null}
        </button>
        {SWATCHES.map((s) => {
          const selected = hasColour && s.hex.toUpperCase() === item.colour_hex.toUpperCase();
          return (
            <button
              key={s.hex}
              type="button"
              className={"swatch" + (selected ? " selected" : "")}
              style={{ background: s.hex }}
              aria-label={s.name}
              aria-pressed={selected}
              title={s.name}
              onClick={() => onSave(item, { colour_name: s.name, colour_hex: s.hex })}
            >
              {selected ? (
                <span className="swatch-check" style={{ color: isLight(s.hex) ? "var(--ink)" : "#fff" }}>
                  &#10003;
                </span>
              ) : null}
            </button>
          );
        })}
        <label
          className={"swatch swatch-custom" + (customSelected ? " selected" : "")}
          style={customSelected ? { background: item.colour_hex } : undefined}
          aria-label={customSelected ? item.colour_name || item.colour_hex : "Choose any colour"}
          title="Choose any colour"
        >
          {customSelected ? (
            <span className="swatch-check" style={{ color: isLight(item.colour_hex) ? "var(--ink)" : "#fff" }}>
              &#10003;
            </span>
          ) : (
            <span aria-hidden="true">+</span>
          )}
          <input
            type="color"
            className="visually-hidden"
            value={pickerHex.toLowerCase()}
            onChange={(e) => pickCustom(e.target.value.toUpperCase())}
          />
        </label>
      </div>

      <div className="piece-row-label">
        <span className="section-label">Material</span>
        <span className="piece-choice">
          {item.fabric_url ? "Your fabric" : item.material ? materialLabel(item.material) : "As photo"}
        </span>
      </div>
      <div className="chips">
        <Chip
          selected={!item.material && !item.fabric_url}
          onClick={() => onSave(item, { material: null }, { clearFabric: true })}
        >
          As photo
        </Chip>
        {MATERIALS.map((m) => (
          <Chip
            key={m.value}
            selected={!item.fabric_url && item.material === m.value}
            onClick={() => onSave(item, { material: m.value }, { clearFabric: true })}
          >
            {m.label}
          </Chip>
        ))}
        {!item.fabric_url ? (
          <button
            type="button"
            className={"chip chip-upload" + (showUpload ? " pending" : "")}
            onClick={() => setShowUpload((v) => !v)}
          >
            + Upload your fabric
          </button>
        ) : null}
      </div>

      {item.fabric_url ? (
        <div className="fabric-row">
          <div className="fabric-box">
            <UploadBox file={null} existingUrl={item.fabric_url} onChange={addFabric} />
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            disabled={saving}
            onClick={() => onSave(item, {}, { clearFabric: true })}
          >
            Remove
          </button>
        </div>
      ) : showUpload ? (
        <div className="fabric-row">
          <div className="fabric-box">
            <UploadBox file={null} existingUrl={null} onChange={addFabric} label="Add the fabric photo" hint="Tap to take or choose one" />
          </div>
          <div className="hint-line">A close, well-lit photo of the fabric works best.</div>
        </div>
      ) : null}
    </div>
  );
}

export default function Finish() {
  const { id } = useParams();
  const adjust = useAdjustMode(id); // set when opened from "Adjust & try again"
  const [searchParams] = useSearchParams();
  const ignorePlacement = searchParams.get("ignore_placement") === "true";
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [roomTreatment, setRoomTreatment] = useState("luxury");
  const [lighting, setLighting] = useState("warm");
  const [note, setNote] = useState("");
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState({}); // item id -> pending save count
  const saveSeq = useRef({}); // item id -> latest request number, so stale replies are ignored

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setRoomTreatment(data.attempt.room_treatment || "luxury");
      setLighting(data.attempt.lighting || "warm");
      setNote(data.attempt.note || "");
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function replaceItem(updated) {
    setAttempt((a) => ({ ...a, items: a.items.map((it) => (it.id === updated.id ? updated : it)) }));
  }

  async function saveFinish(item, changes, { photo = null, clearFabric = false } = {}) {
    const next = {
      colour_name: item.colour_name,
      colour_hex: item.colour_hex,
      material: item.material,
      ...changes,
    };
    const form = new FormData();
    form.append("colour_name", next.colour_name || "");
    form.append("colour_hex", next.colour_hex || "");
    form.append("material", next.material || "");
    form.append("clear_fabric", clearFabric ? "true" : "false");
    if (photo) form.append("photo", photo, photo.name || "fabric.jpg");

    // show the choice straight away; the server reply confirms it
    replaceItem({ ...item, ...next, fabric_url: clearFabric ? null : item.fabric_url });
    const seq = (saveSeq.current[item.id] || 0) + 1;
    saveSeq.current[item.id] = seq;
    setSaving((s) => ({ ...s, [item.id]: (s[item.id] || 0) + 1 }));
    try {
      const data = await api.post(`/api/attempts/${id}/items/${item.id}/finish`, { form });
      if (saveSeq.current[item.id] === seq) replaceItem(data.item);
    } catch (err) {
      toast(photoUploadError(err));
      if (saveSeq.current[item.id] === seq) replaceItem(item);
    } finally {
      setSaving((s) => ({ ...s, [item.id]: (s[item.id] || 1) - 1 }));
    }
  }

  const anySaving = Object.values(saving).some((n) => n > 0);

  async function handleGenerate() {
    setStarting(true);
    try {
      await api.patch(`/api/attempts/${id}`, { json: { room_treatment: roomTreatment, lighting, note } });
      const suffix = ignorePlacement ? "?ignore_placement=true" : "";
      const data = await api.post(`/api/attempts/${id}/generate${suffix}`);
      navigate(`/attempt/${id}/generating`, { state: { jobId: data.job_id, startedAt: Date.now() } });
    } catch (err) {
      toast(err.message);
      setStarting(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const customisedCount = attempt.items.filter((it) => it.colour_hex || it.material || it.fabric_url).length;

  return (
    <div className="screen has-step-footer">
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/${attempt.placement_mode === "shapes" ? "draw" : "place"}`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 4 of 4</div>
      <StepBar current={4} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} placementMode={attempt.placement_mode} />
      <h1 style={{ marginBottom: 6 }}>Customise and finish</h1>
      <p className="finish-subtitle muted">
        Change colour or material for each piece. The design – shape, seats, arms and legs – always stays the same.
      </p>

      <div className="finish-layout">
        <div className="finish-options">
          <div className="piece-cards">
            {attempt.items.map((it) => (
              <PieceCard key={it.id} item={it} saving={(saving[it.id] || 0) > 0} onSave={saveFinish} />
            ))}
          </div>

          <div className="field">
            <label>How should the room look?</label>
            <div className="option-grid looks" role="radiogroup" aria-label="How should the room look?">
              {ROOM_TREATMENTS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === roomTreatment}
                  className={"option-card" + (o.value === roomTreatment ? " selected" : "")}
                  onClick={() => setRoomTreatment(o.value)}
                >
                  <span className="option-radio" aria-hidden="true" />
                  <span>
                    <span className="option-title">{o.label}</span>
                    <span className="option-desc">{o.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Lighting</label>
            <div className="option-grid lights" role="radiogroup" aria-label="Lighting">
              {LIGHTINGS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={o.value === lighting}
                  className={"option-card" + (o.value === lighting ? " selected" : "")}
                  onClick={() => setLighting(o.value)}
                >
                  <span className="option-radio" aria-hidden="true" />
                  <span>
                    <span className="option-title">{o.label}</span>
                    <span className="option-desc">{o.desc}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="finish-note">Anything specific?</label>
            <textarea
              id="finish-note"
              className="finish-note"
              rows={3}
              maxLength={NOTE_MAX}
              placeholder="Optional – e.g. keep the existing curtains"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className="hint-line">{note.length}/{NOTE_MAX}</div>
          </div>
        </div>

        <div className="summary-box finish-summary">
          <div>
            <span className="mono muted">Room</span>
            <span className="mono">
              {attempt.room.customer_name} &middot; {attempt.room.room_type}
            </span>
          </div>
          <div>
            <span className="mono muted">Look</span>
            <span className="mono">{ROOM_TREATMENTS.find((o) => o.value === roomTreatment)?.label}</span>
          </div>
          <div>
            <span className="mono muted">Lighting</span>
            <span className="mono">{LIGHTINGS.find((o) => o.value === lighting)?.label}</span>
          </div>
          {attempt.items.map((it) => (
            <div key={it.id}>
              <span>
                {it.category} &middot; {it.type}
              </span>
              <span className="mono">{finishSummary(it)}</span>
            </div>
          ))}
        </div>
      </div>

      <StepFooter
        backTo={adjust.backTo || `/attempt/${id}/${attempt.placement_mode === "shapes" ? "draw" : "place"}`}
        status={`${customisedCount} of ${attempt.items.length} ${attempt.items.length === 1 ? "piece" : "pieces"} customised`}
        primaryLabel={anySaving ? "Saving…" : "Generate"}
        primaryBusyLabel="Starting…"
        busy={starting}
        primaryDisabled={anySaving}
        onPrimary={handleGenerate}
      />
    </div>
  );
}
