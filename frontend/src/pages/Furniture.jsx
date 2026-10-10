import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { Chip } from "../components/Chip.jsx";
import { UploadBox } from "../components/UploadBox.jsx";
import { debugLog } from "../utils.js";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { RoomPlanView } from "../components/RoomPlanView.jsx";
import { cornerFigure, curvedFigure, lFigure, straightFigure } from "../placement.js";

const OTHER_TYPES = {
  "Dining table": ["4 seater", "6 seater", "8 seater"],
  Bed: ["Single", "Queen", "King"],
};
const MAX_ITEMS = 4;
const SEAT_OPTIONS = [1, 2, 3, 4, 5];
const DEFAULT_WIDTHS = {
  "1-seater": 3,
  "2-seater": 5,
  "3-seater": 7,
  "4-seater": 8,
  "5-seater": 10,
  "L-shape": 9,
  Corner: 9,
  Curved: 8,
  "4 seater": 4,
  "6 seater": 6,
  "8 seater": 8,
  Single: 2.5,
  Pair: 2.5,
  Queen: 5,
  King: 6.5,
};
// Bed "Single" is 3.5 ft while Chair "Single" is 2.5 ft.
function defaultWidth(category, type) {
  if (category === "Bed" && type === "Single") return 3.5;
  return DEFAULT_WIDTHS[type] ?? 5;
}

// The picture cards. `type` is what the batch endpoint receives; the plain
// Sofa card has none because it sends "<n>-seater" from the chosen seats.
const TYPE_CARDS = [
  { key: "sofa", label: "Sofa", icon: "straight", category: "Sofa", type: null },
  { key: "L-shape", label: "L-shape", icon: "L", category: "Sofa", type: "L-shape" },
  { key: "Corner", label: "Corner sofa", icon: "corner", category: "Sofa", type: "Corner" },
  { key: "Curved", label: "Curved", icon: "curved", category: "Sofa", type: "Curved" },
  { key: "chair", label: "Chair", icon: "chair", category: "Chair", type: "Single" },
];
const GREY = "#6b7280";
const ORANGE = "#EF7B1C";

function pillRect(r, key, fill) {
  const w = Math.max(r.u1 - r.u0, 0);
  const h = Math.max(r.v1 - r.v0, 0);
  return <rect key={key} x={r.u0} y={r.v0} width={w} height={h} rx={Math.min(w, h, 8) / 2} fill={fill} />;
}

/** Small figure of a type, in the same style as the plan: back cushions,
 * hand-rests, one seat outline. The back cushions are orange when selected. */
function TypeIcon({ kind, selected }) {
  const backFill = selected ? ORANGE : GREY;
  let body;
  if (kind === "curved") {
    const fig = curvedFigure(80, 50, 22);
    body = (
      <g transform="translate(10 6)">
        <path d={fig.seat.d} fill="#e5e7eb" stroke={GREY} strokeWidth={fig.seat.r * 2 + 3} strokeLinejoin="round" />
        <path d={fig.seat.d} fill="#e5e7eb" stroke="#e5e7eb" strokeWidth={fig.seat.r * 2} strokeLinejoin="round" />
        <path
          d={fig.back.d} fill="none" stroke={backFill} strokeWidth={fig.back.width} strokeLinecap="round"
          strokeDasharray={`${fig.back.dash} ${fig.back.gap}`} strokeDashoffset={fig.back.offset}
        />
        {fig.handRests.map((r, i) => pillRect(r, `h${i}`, GREY))}
      </g>
    );
  } else {
    const figures = {
      L: [lFigure(80, 50, 26), "translate(10 6)"],
      corner: [cornerFigure(80, 50, 26), "translate(10 6)"],
      chair: [straightFigure(34, 34, 1), "translate(33 15)"],
      straight: [straightFigure(84, 34, 3), "translate(8 15)"],
    };
    const [fig, origin] = figures[kind];
    const seat = `M ${fig.seatPoints.map((p) => p.join(" ")).join(" L ")} Z`;
    body = (
      <g transform={origin}>
        <path d={seat} fill="#e5e7eb" stroke={GREY} strokeWidth="1.5" strokeLinejoin="round" />
        {fig.backPills.map((r, i) => pillRect(r, `b${i}`, backFill))}
        {fig.handRests.map((r, i) => pillRect(r, `h${i}`, GREY))}
      </g>
    );
  }
  return (
    <svg className="type-icon" viewBox="0 0 100 64" aria-hidden="true">
      {body}
    </svg>
  );
}

function QtyStepper({ count, onChange, canAdd, label }) {
  return (
    <div className="qty-stepper">
      <button type="button" className="qty-btn" aria-label={`Fewer ${label}`} disabled={count <= 1} onClick={() => onChange(count - 1)}>
        &minus;
      </button>
      <span className="qty-count">{count}</span>
      <button type="button" className="qty-btn" aria-label={`More ${label}`} disabled={!canAdd} onClick={() => onChange(count + 1)}>
        +
      </button>
    </div>
  );
}

export default function Furniture() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  // choice: a TYPE_CARDS key, or "Dining table" / "Bed"; null until picked
  const [choice, setChoice] = useState(null);
  const [seats, setSeats] = useState(3);
  const [otherType, setOtherType] = useState("");
  const [count, setCount] = useState(1);
  const [width, setWidth] = useState("");
  const [photo, setPhoto] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showPlan, setShowPlan] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll while the vision layout job is still running, so the "View room
  // plan" sheet updates live even from this earlier step — the call takes
  // ~20s and a salesman often reaches this step well before it's ready.
  useEffect(() => {
    if (!attempt || attempt.room.layout_status !== "pending") return undefined;
    const timer = setInterval(async () => {
      try {
        const data = await api.get(`/api/rooms/${attempt.room.id}`);
        setAttempt((prev) => (prev ? { ...prev, room: { ...prev.room, ...data.room } } : prev));
      } catch {
        // transient — keep polling
      }
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt?.room?.id, attempt?.room?.layout_status]);

  async function handleDelete(itemId) {
    try {
      const data = await api.del(`/api/attempts/${id}/items/${itemId}`);
      setAttempt(data.attempt);
    } catch (err) {
      toast(err.message);
    }
  }

  function pickCard(key) {
    setChoice(key);
    setCount(1);
    setWidth("");
  }

  function pickOther(name) {
    setChoice(name);
    setOtherType(OTHER_TYPES[name][0]);
    setCount(1);
    setWidth("");
  }

  async function handleAdd() {
    if (!photo) return toast("Please add a photo of the piece.");
    if (!choice || total < 1) return toast("Please choose a type first.");
    const w = parseFloat(width);
    const useWidth = total === 1 && w > 0;
    const pieces = Array.from({ length: total }, () => ({
      type: typeName,
      width_ft: useWidth ? w : defaultWidth(category, typeName),
    }));
    setAdding(true);
    const form = new FormData();
    form.append("category", category);
    form.append("pieces", JSON.stringify(pieces));
    form.append("photo", photo);
    try {
      const data = await api.post(`/api/attempts/${id}/items/batch`, { form });
      debugLog("upload OK");
      setAttempt(data.attempt);
      setPhoto(null);
      setWidth("");
      setChoice(null);
      setCount(1);
    } catch (err) {
      debugLog(`upload FAIL ${err.message}`);
      toast(err.message);
    } finally {
      setAdding(false);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const remaining = MAX_ITEMS - attempt.items.length;
  const atMax = remaining <= 0;
  const card = TYPE_CARDS.find((c) => c.key === choice) ?? null;
  const isOther = choice !== null && card === null;
  let category = "";
  let typeName = "";
  let typeLabel = "";
  if (card) {
    category = card.category;
    typeName = card.type ?? `${seats}-seater`;
    typeLabel = card.type ? card.label.toLowerCase() : "sofa";
  } else if (isOther) {
    category = choice;
    typeName = otherType;
    typeLabel = choice.toLowerCase();
  }
  const total = choice ? Math.max(1, Math.min(count, remaining)) : 0;
  const canAddMore = total < remaining;

  return (
    <div className="screen">
      <TopBar
        backTo={`/room/${attempt.room.id}`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 2 of 4</div>
      <StepBar current={2} attemptId={attempt.id} roomId={attempt.room.id} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
        <h1 style={{ marginBottom: 0 }}>Add furniture</h1>
        <button type="button" className="link-btn" onClick={() => setShowPlan(true)}>
          View room plan
        </button>
      </div>

      {attempt.items.map((it) => (
        <div key={it.id} className="item-row">
          <img src={it.photo_url} alt="" />
          <div className="info">
            <div className="title">
              {it.category} &middot; {it.type}
            </div>
            <div className="width">{it.width_ft}ft wide</div>
          </div>
          <button type="button" className="del" onClick={() => handleDelete(it.id)}>
            &times;
          </button>
        </div>
      ))}

      {atMax ? (
        <div className="count-hint">Maximum of {MAX_ITEMS} pieces reached.</div>
      ) : (
        <div className="add-piece-card">
          <div className="field">
            <label>Photo of the piece</label>
            <UploadBox file={photo} onChange={setPhoto} />
            <div className="count-hint" style={{ textAlign: "left" }}>One photo for all the pieces below</div>
          </div>

          <div className="section-label">1 &middot; What is it?</div>
          <div className="type-grid">
            {TYPE_CARDS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`type-card${choice === c.key ? " selected" : ""}`}
                aria-pressed={choice === c.key}
                onClick={() => pickCard(c.key)}
              >
                <TypeIcon kind={c.icon} selected={choice === c.key} />
                <span className="type-card-label">{c.label}</span>
              </button>
            ))}
          </div>
          <div className="type-other">
            <span className="type-other-label">Other:</span>
            {Object.keys(OTHER_TYPES).map((name) => (
              <Chip key={name} selected={choice === name} onClick={() => pickOther(name)}>
                {name}
              </Chip>
            ))}
          </div>

          {!choice ? (
            <div className="count-hint" style={{ textAlign: "left", marginTop: 14 }}>
              Tap a type above. Seats and quantity appear after that.
            </div>
          ) : (
            <>
              {card ? <div className="type-back-note">Orange = the back of the {card.label.toLowerCase()}</div> : null}
              {card && !card.type ? (
                <>
                  <div className="section-label">Seats</div>
                  <div className="seat-buttons">
                    {SEAT_OPTIONS.map((n) => (
                      <button key={n} type="button" className={`seat-btn${seats === n ? " selected" : ""}`} onClick={() => setSeats(n)}>
                        {n}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {isOther ? (
                <>
                  <div className="section-label">Size</div>
                  <div className="chips">
                    {OTHER_TYPES[choice].map((t) => (
                      <Chip key={t} selected={t === otherType} onClick={() => setOtherType(t)}>
                        {t}
                      </Chip>
                    ))}
                  </div>
                </>
              ) : null}

              <div className="section-label">How many?</div>
              <QtyStepper count={total} canAdd={canAddMore} label={typeLabel} onChange={setCount} />
              <div className="count-hint" style={{ textAlign: "left" }}>
                {attempt.items.length + total} of {MAX_ITEMS} pieces used
              </div>
              {total === 1 ? (
                <div className="field" style={{ marginTop: 14 }}>
                  <label>Width (ft) &ndash; optional</label>
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={width}
                    onChange={(e) => setWidth(e.target.value)}
                    placeholder="e.g. 7"
                  />
                </div>
              ) : (
                <div className="count-hint" style={{ textAlign: "left" }}>
                  Sizes are set automatically &ndash; drag the blue dots on the plan to adjust.
                </div>
              )}
              <button type="button" className="btn btn-dark" disabled={adding || !photo || total < 1} onClick={handleAdd}>
                {adding ? "Adding…" : `Add ${total} × ${typeLabel}`}
              </button>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        style={{ marginTop: 20 }}
        disabled={!attempt.items.length}
        onClick={() => navigate(`/attempt/${id}/place`)}
      >
        Next — placement
      </button>

      {showPlan ? (
        <BottomSheet title="Room plan" onClose={() => setShowPlan(false)}>
          <RoomPlanView room={attempt.room} readOnly />
        </BottomSheet>
      ) : null}
    </div>
  );
}
