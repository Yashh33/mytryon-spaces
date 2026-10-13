import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { useAdjustMode } from "../adjustMode.js";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { PlacementCard } from "../components/PlacementCard.jsx";
import { RoomPhotoReference } from "../components/RoomPhotoReference.jsx";
import {
  ADDABLE_FEATURE_TYPES,
  ARM_SHAPES,
  FAR_NEAR_POSITIONS,
  SIDE_POSITIONS,
  WALL_KEY,
  SET_PIECE_SNAP_FT,
  SINGLE_PIECE_SNAP_FT,
  defaultBlocksFurniture,
  defaultPlacement,
  flipPlacement,
  itemsToBlocks,
  planFeatures,
  resizePlacement,
  roomFeet,
  rotatePlacement,
} from "../placement.js";
import { exportPlanPng } from "../planExport.js";

// "Are the features marked ? really there?" is asked once per plan: the
// answer is remembered for exactly the uncertain features it was given for,
// so a room read again, or a feature added, is asked about again. Only a
// convenience — if the browser won't store it, the question is simply asked
// again next time.
function uncertainFeatureCheck(room) {
  const groups = Object.values(planFeatures(room.layout_json).walls).flat().filter((g) => g.uncertain);
  const signature = JSON.stringify(groups.map((g) => [g.wall, g.type, g.span]));
  return { labels: groups.map((g) => g.label), signature, key: `plan-features-checked:${room.id}` };
}

function featuresAlreadyChecked(check) {
  try {
    return window.localStorage.getItem(check.key) === check.signature;
  } catch {
    return false;
  }
}

function rememberFeaturesChecked(check) {
  try {
    window.localStorage.setItem(check.key, check.signature);
  } catch {
    // not stored: the question comes up again next time
  }
}

function emptyLayout() {
  return {
    camera_position: "near end, centre",
    room_shape: "rectangular",
    shape_notes: "",
    depth_vs_width: "about square",
    far_wall: { confidence: "not_visible", features: [] },
    left_wall: { confidence: "not_visible", features: [] },
    right_wall: { confidence: "not_visible", features: [] },
    near_wall: { confidence: "not_visible", features: [] },
    floor_state: "finished",
    obstructions: [],
    clutter: [],
    uncertain: [],
  };
}

export default function Place() {
  const { id } = useParams();
  const adjust = useAdjustMode(id); // set when opened from "Adjust & try again"
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [showAddFeature, setShowAddFeature] = useState(false);
  const [addObstructionMode, setAddObstructionMode] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null); // { kind: "piece"|"feature"|"obstruction", label, onConfirm }
  const [featureCheck, setFeatureCheck] = useState(null); // the "features marked ?" question, while it is open
  const [fullScreen, setFullScreen] = useState(false);
  const [phoneView, setPhoneView] = useState("plan"); // phone only: "plan" | "photo"
  // Guards against stale server replies: every local change to a block's
  // placement bumps its counter; a reply is only applied if no newer change
  // happened meanwhile. Blocks with unsaved local changes are also kept as-is
  // when another block's reply resyncs the list.
  const changeSeq = useRef({});
  const dirtyKeys = useRef(new Set());
  const planSvg = useRef(null); // the plan's <svg>, for exporting it as an image on Next
  const [leaving, setLeaving] = useState(false);

  async function load() {
    setError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
      setBlocks(itemsToBlocks(data.attempt.items));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Poll while the vision layout job is still running in the background.
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

  // Full screen is a view mode, not a route — pushing a history entry when
  // it opens means the phone's own back gesture/button closes it (handled
  // here) instead of leaving the placement screen.
  useEffect(() => {
    if (!fullScreen) return undefined;
    window.history.pushState({ placementFullScreen: true }, "");
    const onPopState = () => setFullScreen(false);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [fullScreen]);

  function closeFullScreen() {
    setFullScreen(false);
    // Drop the history entry we pushed on open, so back doesn't later
    // re-open full screen or require an extra back press to leave /place.
    if (window.history.state?.placementFullScreen) window.history.back();
  }

  const room = attempt?.room;
  const feet = roomFeet(room?.layout_json?.depth_vs_width);
  const selectedBlock = blocks.find((b) => b.key === selectedKey) || null;
  const pendingKey = selectedBlock && !selectedBlock.placement ? selectedBlock.key : null;

  function updateBlock(key, patch) {
    if ("placement" in patch || "widthFt" in patch) {
      changeSeq.current[key] = (changeSeq.current[key] || 0) + 1;
      dirtyKeys.current.add(key);
    }
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  // Both calls resync attempt + blocks from the server's response rather
  // than trusting the optimistic local update alone, so the chip/canvas
  // placed-state can never drift from what's actually persisted.
  // Applies a save/remove reply unless a newer change to that block has been
  // made since the request went out (that change's own reply will follow).
  function applyReply(block, seq, data) {
    if ((changeSeq.current[block.key] || 0) !== seq) return;
    dirtyKeys.current.delete(block.key);
    setAttempt(data.attempt);
    setBlocks((prev) =>
      itemsToBlocks(data.attempt.items).map((fresh) => (dirtyKeys.current.has(fresh.key) ? prev.find((b) => b.key === fresh.key) || fresh : fresh))
    );
  }

  async function persistPlacement(block, placement, widthFt) {
    const json = widthFt == null ? { placement } : { placement, width_ft: widthFt };
    const seq = changeSeq.current[block.key] || 0;
    try {
      const data = await api.post(`/api/attempts/${id}/items/${block.itemId}/placement/${block.subIndex}`, { json });
      applyReply(block, seq, data);
    } catch (err) {
      toast(err.message);
    }
  }

  async function removePlacement(block) {
    const seq = changeSeq.current[block.key] || 0;
    try {
      const data = await api.del(`/api/attempts/${id}/items/${block.itemId}/placement/${block.subIndex}`);
      applyReply(block, seq, data);
    } catch (err) {
      toast(err.message);
    }
  }

  function handleSelectBlock(key) {
    setSelectedKey(key);
  }

  function handleDropPendingAt(key, x, y) {
    const block = blocks.find((b) => b.key === key);
    if (!block) return;
    const placement = defaultPlacement(block.shape, block.widthFt, feet, x, y);
    updateBlock(key, { placement });
    persistPlacement(block, placement);
  }

  function handleMoveBlock(key, placement) {
    updateBlock(key, { placement });
  }

  function handleCommitBlock(key, placement) {
    const block = blocks.find((b) => b.key === key);
    if (block) persistPlacement(block, placement);
  }

  function handleRotateBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block || !block.placement) return;
    const placement = rotatePlacement(block.shape, block.placement, feet);
    updateBlock(key, { placement });
    persistPlacement(block, placement);
  }

  function handleFlipBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block || !block.placement) return;
    const placement = flipPlacement(block.shape, block.placement, feet);
    updateBlock(key, { placement });
    persistPlacement(block, placement);
  }

  function handleResizeBlock(key, origPlacement, x, y, handle = "length") {
    const block = blocks.find((b) => b.key === key);
    if (!block) return;
    const snap = block.inSet ? SET_PIECE_SNAP_FT : SINGLE_PIECE_SNAP_FT;
    const { placement, widthFt } = resizePlacement(block.shape, origPlacement, x, y, feet, snap, handle);
    if (handle === "length") {
      updateBlock(key, { placement, widthFt, resizedHandle: "length" });
    } else {
      updateBlock(key, { placement, resizedHandle: handle });
    }
  }

  function handleCommitResize(key) {
    const block = blocks.find((b) => b.key === key);
    if (block && block.placement) persistPlacement(block, block.placement, block.resizedHandle === "length" ? block.widthFt : null);
  }

  function doRemoveBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block) return;
    updateBlock(key, { placement: null });
    // Keep it selected (now unplaced) rather than deselecting, so it's
    // immediately pending — no second tap needed to re-place it.
    setSelectedKey(key);
    removePlacement(block);
  }

  function requestRemoveBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block) return;
    setRemoveTarget({
      label: block.label,
      note: "It will not appear in the picture.",
      onConfirm: () => {
        doRemoveBlock(key);
        setRemoveTarget(null);
      },
    });
  }

  async function updateLayout(mutate) {
    const current = room.layout_json || emptyLayout();
    const updated = mutate(current);
    try {
      const data = await api.patch(`/api/rooms/${room.id}/layout`, { json: { layout_json: updated } });
      setAttempt((prev) => ({ ...prev, room: { ...prev.room, ...data.room } }));
    } catch (err) {
      toast(err.message);
    }
  }

  function handleAddObstructionAt(x, y) {
    setAddObstructionMode(false);
    updateLayout((layout) => ({
      ...layout,
      obstructions: [...(layout.obstructions || []), { type: "pillar", location: "added on the plan", notes: "", x, y }],
    }));
  }

  function doRemoveFeature(wall, indices) {
    const key = WALL_KEY[wall];
    const toRemove = new Set(Array.isArray(indices) ? indices : [indices]);
    updateLayout((layout) => ({
      ...layout,
      [key]: { ...layout[key], features: (layout[key]?.features || []).filter((_, i) => !toRemove.has(i)) },
    }));
  }

  function handleTapFeature(wall, indices) {
    const wallData = room.layout_json?.[WALL_KEY[wall]];
    const first = Array.isArray(indices) ? indices[0] : indices;
    const type = wallData?.features?.[first]?.type || "feature";
    setRemoveTarget({
      label: type,
      note: "It will not appear in the picture.",
      onConfirm: () => {
        doRemoveFeature(wall, indices);
        setRemoveTarget(null);
      },
    });
  }

  function doRemoveObstruction(index) {
    updateLayout((layout) => ({
      ...layout,
      obstructions: (layout.obstructions || []).filter((_, i) => i !== index),
    }));
  }

  function handleTapObstruction(index) {
    const type = room.layout_json?.obstructions?.[index]?.type || "obstruction";
    setRemoveTarget({
      label: type,
      note: "It will not appear in the picture.",
      onConfirm: () => {
        doRemoveObstruction(index);
        setRemoveTarget(null);
      },
    });
  }

  function handleAddFeature({ wall, type, position }) {
    const key = WALL_KEY[wall];
    updateLayout((layout) => ({
      ...layout,
      [key]: {
        confidence: layout[key]?.confidence || "clear",
        features: [
          ...(layout[key]?.features || []),
          { type, position, size: "medium", notes: "", blocks_furniture: defaultBlocksFurniture(type) },
        ],
      },
    }));
    setShowAddFeature(false);
  }

  // Next: send the plan, as drawn, to the server so the placement writer can
  // start while the salesman picks his finishing options. Entirely optional —
  // any failure here is ignored and generation falls back to the plain facts.
  /** Next, as tapped: first asks about features the room reader was unsure
   * of (once per plan), since a wrong one ends up painted into the picture. */
  function handleNextTap() {
    const check = uncertainFeatureCheck(attempt.room);
    if (check.labels.length && !featuresAlreadyChecked(check)) {
      setFeatureCheck(check);
      return;
    }
    handleNext();
  }

  async function handleNext() {
    setLeaving(true);
    try {
      if (planSvg.current && blocks.some((b) => b.placement)) {
        // let any placement still being saved land first, so the server
        // writes about the same layout the image shows
        for (let waited = 0; dirtyKeys.current.size && waited < 3000; waited += 100) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const form = new FormData();
        form.append("plan", await exportPlanPng(planSvg.current), "plan.png");
        await Promise.race([
          api.post(`/api/attempts/${id}/plan`, { form }),
          new Promise((resolve) => setTimeout(resolve, 6000)),
        ]);
      }
    } catch {
      // the writer is a bonus; never block the flow on it
    }
    navigate(`/attempt/${id}/finish${adjust.query ? `?${adjust.query}` : ""}`);
  }

  if (!attempt && !error) return <div className="screen"><TopBar backTo={adjust.backTo || `/attempt/${id}/furniture`} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo={adjust.backTo || `/attempt/${id}/furniture`} /><ErrorBlock message={error} onRetry={load} /></div>;

  const placementCardProps = {
    room,
    blocks,
    selectedBlock,
    selectedKey,
    onSelectBlock: handleSelectBlock,
    onMoveBlock: handleMoveBlock,
    onCommitBlock: handleCommitBlock,
    onResizeBlock: handleResizeBlock,
    onCommitResize: handleCommitResize,
    onDropPendingAt: handleDropPendingAt,
    pendingKey,
    addObstructionMode,
    onAddObstructionAt: handleAddObstructionAt,
    onTapFeature: handleTapFeature,
    onTapObstruction: handleTapObstruction,
    onRotate: () => selectedKey && handleRotateBlock(selectedKey),
    onFlip: () => selectedKey && handleFlipBlock(selectedKey),
    onRequestRemove: () => selectedKey && requestRemoveBlock(selectedKey),
    onSvg: (node) => {
      planSvg.current = node;
    },
  };

  // The list shows each piece with its product photo, so it's easy to tell
  // which block on the plan is which.
  const itemById = new Map(attempt.items.map((it) => [it.id, it]));
  const listBlocks = blocks.map((b) => {
    const item = itemById.get(b.itemId) || {};
    return { ...b, photo_url: item.photo_url, category: item.category ?? b.category, type: item.type ?? b.type, width_ft: item.width_ft };
  });
  const selectedListBlock = listBlocks.find((b) => b.key === selectedKey) || null;
  const placedCount = blocks.filter((b) => b.placement).length;

  return (
    <div className="screen has-step-footer">
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/furniture`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} />
      <h1 style={{ marginBottom: 4 }}>Where does each piece go?</h1>
      <div className="hint-line" style={{ marginBottom: 12 }}>
        {pendingKey ? "Tap the plan to drop this piece" : "Tap a piece in the list, then tap the plan to place it"}
      </div>

      <div className="place-layout" data-view={phoneView}>
        <div className="place-switch toggle-row">
          <button type="button" className={"toggle-btn" + (phoneView === "plan" ? " active" : "")} onClick={() => setPhoneView("plan")}>
            Plan
          </button>
          <button type="button" className={"toggle-btn" + (phoneView === "photo" ? " active" : "")} onClick={() => setPhoneView("photo")}>
            Room photo
          </button>
        </div>

        <div className="place-photo">
          <RoomPhotoReference room={room} />
          <button type="button" className="btn btn-ghost btn-small place-back" onClick={() => setPhoneView("plan")}>
            Back to plan
          </button>
        </div>

        <div className="place-plan">
          {!fullScreen ? (
            <PlacementCard {...placementCardProps} hideControls fullScreen={false} onToggleFullScreen={() => setFullScreen(true)} />
          ) : null}
          {!fullScreen && room.photo_url ? (
            <button type="button" className="place-thumb" onClick={() => setPhoneView("photo")} aria-label="Show the room photo">
              <img src={room.photo_url} alt="" />
            </button>
          ) : null}
        </div>

        <div className="place-side">
          <SelectedPieceCard
            block={selectedListBlock}
            onRotate={placementCardProps.onRotate}
            onFlip={placementCardProps.onFlip}
            onRequestRemove={placementCardProps.onRequestRemove}
          />

          <div className="section-label">Pieces</div>
          <div className="piece-list">
            {listBlocks.map((b) => (
              <button
                key={b.key}
                type="button"
                className={"piece-row" + (b.key === selectedKey ? " selected" : "")}
                aria-pressed={b.key === selectedKey}
                onClick={() => handleSelectBlock(b.key)}
              >
                <PieceThumb block={b} />
                <span className="piece-row-text">
                  <span className="piece-row-name">{pieceName(b)}</span>
                  <span className="piece-row-size">{formatFeet(b.widthFt ?? b.width_ft)} ft</span>
                </span>
                {b.placement ? (
                  <span className="piece-row-state placed">Placed ✓</span>
                ) : (
                  <span className="piece-row-state">Tap the plan</span>
                )}
              </button>
            ))}
          </div>

          {room.layout_status !== "pending" ? (
            <div className="place-add-row">
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setShowAddFeature(true)}>
                + Add feature
              </button>
              <button
                type="button"
                className={"btn btn-small" + (addObstructionMode ? " btn-primary" : " btn-ghost")}
                onClick={() => setAddObstructionMode((v) => !v)}
              >
                {addObstructionMode ? "Tap the plan…" : "+ Add obstruction"}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {showAddFeature ? <AddFeatureSheet onClose={() => setShowAddFeature(false)} onAdd={handleAddFeature} /> : null}

      {fullScreen ? (
        <div className="placement-fullscreen">
          <PlacementCard {...placementCardProps} fullScreen onToggleFullScreen={closeFullScreen} />
        </div>
      ) : null}

      {/* Fixed-position sheet — rendered once regardless of full-screen,
         since it already overlays everything via its own backdrop. */}
      {removeTarget ? <RemoveConfirmSheet target={removeTarget} onClose={() => setRemoveTarget(null)} /> : null}
      {featureCheck ? (
        <BottomSheet title="Check the plan" onClose={() => setFeatureCheck(null)}>
          <p style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 6 }}>Please check the features marked ? — are they really there?</p>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 18 }}>
            {featureCheck.labels.join(", ")}. Tap one on the wall to remove it if it&apos;s wrong.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => {
                rememberFeaturesChecked(featureCheck);
                setFeatureCheck(null);
                handleNext();
              }}
            >
              They&apos;re right
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={() => setFeatureCheck(null)}>
              Let me check
            </button>
          </div>
        </BottomSheet>
      ) : null}

      <StepFooter
        backTo={adjust.backTo || `/attempt/${id}/furniture`}
        status={`${placedCount} of ${blocks.length} ${blocks.length === 1 ? "piece" : "pieces"} placed`}
        primaryLabel="Next"
        primaryBusyLabel="Saving plan…"
        busy={leaving}
        onPrimary={handleNextTap}
        secondaryLabel="Skip placement"
        onSecondary={() => navigate(`/attempt/${id}/finish?ignore_placement=true${adjust.query ? `&${adjust.query}` : ""}`)}
      />
    </div>
  );
}

function formatFeet(ft) {
  if (ft == null) return "–";
  return Number.isInteger(ft) ? String(ft) : Number(ft).toFixed(1);
}

/** "Sofa · 3-seater"; a piece of a split set names its own part ("Sofa · 2-seater"). */
function pieceName(block) {
  return `${block.category} · ${block.inSet ? block.subLabel : block.type}`;
}

/** Product photo with the block's colour ring and its number badge, so a row
 * matches its block on the plan at a glance. */
function PieceThumb({ block }) {
  return (
    <span className="piece-thumb-wrap">
      {block.photo_url ? (
        <img className="piece-thumb-img" src={block.photo_url} alt="" style={{ boxShadow: `0 0 0 2px #fff, 0 0 0 4px ${block.color}` }} />
      ) : (
        <span className="piece-thumb-img" style={{ background: block.color, boxShadow: `0 0 0 2px #fff, 0 0 0 4px ${block.color}` }} />
      )}
      <span className="piece-badge" style={{ background: block.color }}>
        {block.number}
      </span>
    </span>
  );
}

/** Rotate / Flip / Remove for the selected piece, above the list. */
function SelectedPieceCard({ block, onRotate, onFlip, onRequestRemove }) {
  if (!block) {
    return (
      <div className="sel-piece-card">
        <div className="sel-piece-empty">Tap a piece to move, rotate or remove it.</div>
      </div>
    );
  }
  const placed = Boolean(block.placement);
  return (
    <div className="sel-piece-card">
      <div className="section-label sel-piece-label">Selected piece</div>
      <div className="sel-piece-head">
        <PieceThumb block={block} />
        <div className="piece-row-text">
          <span className="piece-row-name">{pieceName(block)}</span>
          <span className="piece-row-size">
            {formatFeet(block.widthFt ?? block.width_ft)} ft{placed ? "" : " · tap the plan to place it"}
          </span>
        </div>
      </div>
      <div className="fp-control-bar-buttons sel-piece-buttons">
        <button type="button" className="fp-control-btn" disabled={!placed} onClick={onRotate}>
          <img src="/icons/rotate.svg" alt="" width={20} height={20} />
          Rotate
        </button>
        <button type="button" className="fp-control-btn" disabled={!placed || !ARM_SHAPES.has(block.shape)} onClick={onFlip}>
          <img src="/icons/flip.svg" alt="" width={20} height={20} />
          Flip
        </button>
        <button type="button" className="fp-control-btn fp-control-btn-danger" disabled={!placed} onClick={onRequestRemove}>
          <img src="/icons/remove.svg" alt="" width={20} height={20} />
          Remove
        </button>
      </div>
    </div>
  );
}

function RemoveConfirmSheet({ target, onClose }) {
  return (
    <BottomSheet title={`Remove ${target.label}?`} onClose={onClose}>
      <p className="muted" style={{ fontSize: 13.5, marginBottom: 18 }}>
        {target.note}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <button
          type="button"
          className="btn btn-small"
          style={{ background: "#B42318", color: "#fff" }}
          onClick={target.onConfirm}
        >
          Remove
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          Keep
        </button>
      </div>
    </BottomSheet>
  );
}

function AddFeatureSheet({ onClose, onAdd }) {
  const [wall, setWall] = useState("far");
  const [type, setType] = useState("window");
  const isSide = wall === "left" || wall === "right";
  const positions = isSide ? SIDE_POSITIONS : FAR_NEAR_POSITIONS;
  const [position, setPosition] = useState(positions[1]);

  function handleWallChange(next) {
    setWall(next);
    const nextPositions = next === "left" || next === "right" ? SIDE_POSITIONS : FAR_NEAR_POSITIONS;
    setPosition(nextPositions[1]);
  }

  return (
    <BottomSheet title="Add feature" onClose={onClose}>
      <div className="field">
        <label>Wall</label>
        <select value={wall} onChange={(e) => handleWallChange(e.target.value)}>
          <option value="far">Far wall</option>
          <option value="left">Left wall</option>
          <option value="right">Right wall</option>
          <option value="near">Near wall</option>
        </select>
      </div>
      <div className="field">
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {ADDABLE_FEATURE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Position</label>
        <select value={position} onChange={(e) => setPosition(e.target.value)}>
          {positions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <button type="button" className="btn btn-primary" onClick={() => onAdd({ wall, type, position })}>
        Add feature
      </button>
    </BottomSheet>
  );
}
