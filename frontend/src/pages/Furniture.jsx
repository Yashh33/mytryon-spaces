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

const ITEM_TYPES = {
  Sofa: ["1-seater", "2-seater", "3-seater", "4-seater", "5-seater", "L-shape", "Curved"],
  "Dining table": ["4 seater", "6 seater", "8 seater"],
  Chair: ["Single", "Pair"],
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

let nextRowId = 1;
function initialSofaRows() {
  return [
    { id: nextRowId++, kind: "L-shape", count: 0 },
    { id: nextRowId++, kind: "Curved", count: 0 },
    { id: nextRowId++, kind: "seats", seats: 3, count: 1 },
  ];
}

function QtyStepper({ count, onChange, canAdd, label }) {
  return (
    <div className="qty-stepper">
      <button type="button" className="qty-btn" aria-label={`Fewer ${label}`} disabled={count <= 0} onClick={() => onChange(count - 1)}>
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
  const [category, setCategory] = useState("Sofa");
  const [type, setType] = useState(ITEM_TYPES["Dining table"][0]);
  const [sofaRows, setSofaRows] = useState(initialSofaRows);
  const [otherCount, setOtherCount] = useState(1);
  const [seatPickerRow, setSeatPickerRow] = useState(null);
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

  function buildPieces() {
    if (category === "Sofa") {
      return sofaRows.flatMap((r) => {
        const t = r.kind === "seats" ? `${r.seats}-seater` : r.kind;
        return Array.from({ length: r.count }, () => t);
      });
    }
    return Array.from({ length: otherCount }, () => type);
  }

  function updateSofaRow(rowId, patch) {
    setSofaRows((rows) => rows.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
  }

  function addSofaSize() {
    setSofaRows((rows) => {
      const used = new Set(rows.filter((r) => r.kind === "seats").map((r) => r.seats));
      const seats = SEAT_OPTIONS.find((n) => !used.has(n)) ?? 2;
      return [...rows, { id: nextRowId++, kind: "seats", seats, count: 0 }];
    });
  }

  async function handleAdd() {
    const types = buildPieces();
    if (!photo) return toast("Please add a photo of the piece.");
    if (!types.length) return toast("Please choose at least one piece.");
    const w = parseFloat(width);
    const useWidth = types.length === 1 && w > 0;
    const pieces = types.map((t) => ({
      type: t,
      width_ft: useWidth ? w : defaultWidth(category, t),
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
      setSofaRows(initialSofaRows());
      setOtherCount(1);
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
  const total = category === "Sofa" ? sofaRows.reduce((sum, r) => sum + r.count, 0) : otherCount;
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
          <div className="section-label" style={{ marginTop: 0 }}>Add furniture</div>
          <div className="chips">
            {Object.keys(ITEM_TYPES).map((c) => (
              <Chip
                key={c}
                selected={c === category}
                onClick={() => {
                  setCategory(c);
                  if (c !== "Sofa") setType(ITEM_TYPES[c][0]);
                  setOtherCount(1);
                }}
              >
                {c}
              </Chip>
            ))}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label>Photo of the piece</label>
            <UploadBox file={photo} onChange={setPhoto} />
            <div className="count-hint" style={{ textAlign: "left" }}>One photo for all the pieces below</div>
          </div>
          <div className="section-label">What and how many?</div>
          {category === "Sofa" ? (
            <>
              {sofaRows.map((r) => (
                <div key={r.id} className="qty-row">
                  <div className="qty-label">
                    {r.kind === "seats" ? (
                      <>
                        Sofa{" "}
                        <button type="button" className="seat-box" onClick={() => setSeatPickerRow(r.id)}>
                          {r.seats}
                        </button>{" "}
                        seats
                      </>
                    ) : (
                      `${r.kind} sofa`
                    )}
                  </div>
                  <QtyStepper
                    count={r.count}
                    canAdd={canAddMore}
                    label={r.kind === "seats" ? `${r.seats}-seat sofas` : `${r.kind} sofas`}
                    onChange={(n) => updateSofaRow(r.id, { count: n })}
                  />
                </div>
              ))}
              <button type="button" className="link-btn" style={{ marginTop: 6 }} onClick={addSofaSize}>
                + Add another sofa size
              </button>
            </>
          ) : (
            <>
              <div className="chips">
                {ITEM_TYPES[category].map((t) => (
                  <Chip key={t} selected={t === type} onClick={() => setType(t)}>
                    {t}
                  </Chip>
                ))}
              </div>
              <div className="qty-row">
                <div className="qty-label">{category} &middot; {type}</div>
                <QtyStepper count={otherCount} canAdd={canAddMore} label={category.toLowerCase()} onChange={setOtherCount} />
              </div>
            </>
          )}
          <div className="count-hint" style={{ textAlign: "left" }}>
            {attempt.items.length + total} of {MAX_ITEMS} pieces used
          </div>
          {total > 1 ? (
            <div className="count-hint" style={{ textAlign: "left" }}>
              Sizes are set automatically &ndash; drag the blue dots on the plan to adjust.
            </div>
          ) : (
            <div className="field" style={{ marginTop: 14 }}>
              <label>Width (feet) &ndash; optional</label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                placeholder="e.g. 7"
              />
            </div>
          )}
          <button type="button" className="btn btn-dark" disabled={adding || !photo || total < 1} onClick={handleAdd}>
            {adding ? "Adding…" : "Add"}
          </button>
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

      {seatPickerRow !== null ? (
        <BottomSheet title="Number of seats" onClose={() => setSeatPickerRow(null)}>
          <div className="chips">
            {SEAT_OPTIONS.map((n) => (
              <Chip
                key={n}
                selected={sofaRows.find((r) => r.id === seatPickerRow)?.seats === n}
                onClick={() => {
                  updateSofaRow(seatPickerRow, { seats: n });
                  setSeatPickerRow(null);
                }}
              >
                {n}
              </Chip>
            ))}
          </div>
        </BottomSheet>
      ) : null}

      {showPlan ? (
        <BottomSheet title="Room plan" onClose={() => setShowPlan(false)}>
          <RoomPlanView room={attempt.room} readOnly />
        </BottomSheet>
      ) : null}
    </div>
  );
}
