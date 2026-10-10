import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { PlacementCard } from "../components/PlacementCard.jsx";
import {
  ADDABLE_FEATURE_TYPES,
  FAR_NEAR_POSITIONS,
  SIDE_POSITIONS,
  WALL_KEY,
  SET_PIECE_SNAP_FT,
  SINGLE_PIECE_SNAP_FT,
  defaultBlocksFurniture,
  defaultPlacement,
  flipPlacement,
  itemsToBlocks,
  resizePlacement,
  roomFeet,
  rotatePlacement,
} from "../placement.js";

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
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [blocks, setBlocks] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [showAddFeature, setShowAddFeature] = useState(false);
  const [addObstructionMode, setAddObstructionMode] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null); // { kind: "piece"|"feature"|"obstruction", label, onConfirm }
  const [fullScreen, setFullScreen] = useState(false);
  // Guards against stale server replies: every local change to a block's
  // placement bumps its counter; a reply is only applied if no newer change
  // happened meanwhile. Blocks with unsaved local changes are also kept as-is
  // when another block's reply resyncs the list.
  const changeSeq = useRef({});
  const dirtyKeys = useRef(new Set());

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

  if (!attempt && !error) return <div className="screen"><TopBar backTo={`/attempt/${id}/furniture`} /><Loading /></div>;
  if (error) return <div className="screen"><TopBar backTo={`/attempt/${id}/furniture`} /><ErrorBlock message={error} onRetry={load} /></div>;

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
  };

  return (
    <div className="screen">
      <TopBar
        backTo={`/attempt/${id}/furniture`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={attempt.room.id} />
      <h1 style={{ marginBottom: 4 }}>Where does each piece go?</h1>
      <div className="hint-line" style={{ marginBottom: 12 }}>
        {pendingKey ? "Tap the plan to drop this piece" : "Tap a piece below, then tap the plan to place it"}
      </div>

      {!fullScreen ? (
        <PlacementCard {...placementCardProps} fullScreen={false} onToggleFullScreen={() => setFullScreen(true)} />
      ) : null}

      {room.layout_status !== "pending" ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button type="button" className="btn btn-ghost btn-small" style={{ flex: 1 }} onClick={() => setShowAddFeature(true)}>
            + Add feature
          </button>
          <button
            type="button"
            className={"btn btn-small" + (addObstructionMode ? " btn-primary" : " btn-ghost")}
            style={{ flex: 1 }}
            onClick={() => setAddObstructionMode((v) => !v)}
          >
            {addObstructionMode ? "Tap the plan…" : "+ Add obstruction"}
          </button>
        </div>
      ) : null}

      <div className="chips" style={{ marginTop: 16 }}>
        {blocks.map((b) => (
          <button
            key={b.key}
            type="button"
            className={"chip" + (b.key === selectedKey ? " selected" : "") + (b.placement ? " chip-placed" : "")}
            onClick={() => handleSelectBlock(b.key)}
          >
            <span className="chip-dot" style={{ background: b.color }} />
            {b.number} &middot; {b.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 24 }}>
        <button type="button" className="btn btn-primary" onClick={() => navigate(`/attempt/${id}/finish`)}>
          Next
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate(`/attempt/${id}/finish?ignore_placement=true`)}>
          Skip placement
        </button>
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
