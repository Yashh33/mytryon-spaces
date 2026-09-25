import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { BottomSheet } from "../components/BottomSheet.jsx";
import { RoomPlanView } from "../components/RoomPlanView.jsx";
import {
  ADDABLE_FEATURE_TYPES,
  FAR_NEAR_POSITIONS,
  SIDE_POSITIONS,
  WALL_KEY,
  defaultBlocksFurniture,
  defaultLFor,
  defaultRectFor,
  flipLPlacement,
  itemsToBlocks,
  nextRotation,
  rotateLPlacement,
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

  const room = attempt?.room;
  const selectedBlock = blocks.find((b) => b.key === selectedKey) || null;
  const pendingKey = selectedBlock && !selectedBlock.placement ? selectedBlock.key : null;

  function updateBlock(key, patch) {
    setBlocks((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  }

  // Both calls resync attempt + blocks from the server's response rather
  // than trusting the optimistic local update alone, so the chip/canvas
  // placed-state can never drift from what's actually persisted.
  async function persistPlacement(block, placement) {
    try {
      const data = await api.post(`/api/attempts/${id}/items/${block.itemId}/placement/${block.subIndex}`, { json: { placement } });
      setAttempt(data.attempt);
      setBlocks(itemsToBlocks(data.attempt.items));
    } catch (err) {
      toast(err.message);
    }
  }

  async function removePlacement(block) {
    try {
      const data = await api.del(`/api/attempts/${id}/items/${block.itemId}/placement/${block.subIndex}`);
      setAttempt(data.attempt);
      setBlocks(itemsToBlocks(data.attempt.items));
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
    let placement;
    if (block.shape === "L") {
      const base = defaultLFor(block.widthFt);
      const dx = x - base.long.x - base.long.w / 2;
      const dy = y - base.long.y - base.long.h / 2;
      placement = {
        ...base,
        long: { ...base.long, x: base.long.x + dx, y: base.long.y + dy },
        short: { ...base.short, x: base.short.x + dx, y: base.short.y + dy },
      };
    } else {
      const base = defaultRectFor(block.widthFt);
      placement = { ...base, x: x - base.w / 2, y: y - base.h / 2 };
    }
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
    const placement =
      block.shape === "L" ? rotateLPlacement(block.placement) : { ...block.placement, rotation: nextRotation(block.placement.rotation) };
    updateBlock(key, { placement });
    persistPlacement(block, placement);
  }

  function handleFlipBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block || !block.placement) return;
    const placement = flipLPlacement(block.placement);
    updateBlock(key, { placement });
    persistPlacement(block, placement);
  }

  function handleRemoveBlock(key) {
    const block = blocks.find((b) => b.key === key);
    if (!block) return;
    updateBlock(key, { placement: null });
    // Keep it selected (now unplaced) rather than deselecting, so it's
    // immediately pending — no second tap needed to re-place it.
    setSelectedKey(key);
    removePlacement(block);
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

  function handleTapFeature(wall, indices) {
    const key = WALL_KEY[wall];
    const toRemove = new Set(Array.isArray(indices) ? indices : [indices]);
    updateLayout((layout) => ({
      ...layout,
      [key]: { ...layout[key], features: (layout[key]?.features || []).filter((_, i) => !toRemove.has(i)) },
    }));
  }

  function handleTapObstruction(index) {
    updateLayout((layout) => ({
      ...layout,
      obstructions: (layout.obstructions || []).filter((_, i) => i !== index),
    }));
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

  return (
    <div className="screen">
      <TopBar backTo={`/attempt/${id}/furniture`} />
      <div className="eyebrow">Step 3 of 4</div>
      <h1 style={{ marginBottom: 4 }}>Where does each piece go?</h1>
      <div className="hint-line" style={{ marginBottom: 12 }}>
        {pendingKey ? "Tap the plan to drop this piece" : "Tap a piece below, then tap the plan to place it"}
      </div>

      <RoomPlanView
        room={room}
        blocks={blocks}
        selectedKey={selectedKey}
        onSelectBlock={handleSelectBlock}
        onMoveBlock={handleMoveBlock}
        onCommitBlock={handleCommitBlock}
        onRotateBlock={handleRotateBlock}
        onFlipBlock={handleFlipBlock}
        onRemoveBlock={handleRemoveBlock}
        onDropPendingAt={handleDropPendingAt}
        pendingKey={pendingKey}
        addObstructionMode={addObstructionMode}
        onAddObstructionAt={handleAddObstructionAt}
        onTapFeature={handleTapFeature}
        onTapObstruction={handleTapObstruction}
      />

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
    </div>
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
