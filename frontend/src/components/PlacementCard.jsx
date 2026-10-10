import { ARM_SHAPES } from "../placement.js";
import { RoomPlanView } from "./RoomPlanView.jsx";

/** The floor-plan card used on the placement screen: the plan itself, the
 * "Full screen" toggle, and — when a piece is selected — the control bar
 * directly underneath it. Rendered twice with the identical props (once
 * inline, once inside the full-screen overlay) so both stay in sync off the
 * same state in Place.jsx; this component owns no state of its own. */
export function PlacementCard({
  room,
  blocks,
  selectedBlock,
  selectedKey,
  onSelectBlock,
  onMoveBlock,
  onCommitBlock,
  onResizeBlock,
  onCommitResize,
  onDropPendingAt,
  pendingKey,
  addObstructionMode,
  onAddObstructionAt,
  onTapFeature,
  onTapObstruction,
  onRotate,
  onFlip,
  onRequestRemove,
  fullScreen,
  onToggleFullScreen,
  hideControls = false,
  onSvg = null,
}) {
  return (
    <div className="placement-card">
      <div className="placement-card-top">
        <button type="button" className="fp-fullscreen-btn" onClick={onToggleFullScreen}>
          <img src={fullScreen ? "/icons/exit-fullscreen.svg" : "/icons/fullscreen.svg"} alt="" width={20} height={20} />
          {fullScreen ? "Exit full screen" : "Full screen"}
        </button>
      </div>

      <RoomPlanView
        room={room}
        blocks={blocks}
        selectedKey={selectedKey}
        onSelectBlock={onSelectBlock}
        onMoveBlock={onMoveBlock}
        onCommitBlock={onCommitBlock}
        onResizeBlock={onResizeBlock}
        onCommitResize={onCommitResize}
        onRotateBlock={onRotate}
        onDropPendingAt={onDropPendingAt}
        pendingKey={pendingKey}
        addObstructionMode={addObstructionMode}
        onAddObstructionAt={onAddObstructionAt}
        onTapFeature={onTapFeature}
        onTapObstruction={onTapObstruction}
        onSvg={onSvg}
      />

      {hideControls ? null : (
        <PieceControls selectedBlock={selectedBlock} onRotate={onRotate} onFlip={onFlip} onRequestRemove={onRequestRemove} />
      )}
    </div>
  );
}

/** Rotate / Flip / Remove for the selected, placed piece. Shown under the plan
 * in full screen, and in the pieces panel on the normal placement layout. */
export function PieceControls({ selectedBlock, onRotate, onFlip, onRequestRemove }) {
  if (!selectedBlock || !selectedBlock.placement) return null;
  return (
    <div className="fp-control-bar">
      <div className="fp-control-bar-title">
        <span className="chip-dot" style={{ background: selectedBlock.color }} />
        {selectedBlock.label}
        <span className="fp-control-bar-size">{formatFeet(selectedBlock.widthFt)} ft</span>
      </div>
      <div className="fp-control-bar-buttons">
        <button type="button" className="fp-control-btn" onClick={onRotate}>
          <img src="/icons/rotate.svg" alt="" width={20} height={20} />
          Rotate
        </button>
        {ARM_SHAPES.has(selectedBlock.shape) ? (
          <button type="button" className="fp-control-btn" onClick={onFlip}>
            <img src="/icons/flip.svg" alt="" width={20} height={20} />
            Flip
          </button>
        ) : null}
        <button type="button" className="fp-control-btn fp-control-btn-danger" onClick={onRequestRemove}>
          <img src="/icons/remove.svg" alt="" width={20} height={20} />
          Remove
        </button>
      </div>
    </div>
  );
}

function formatFeet(ft) {
  return Number.isInteger(ft) ? String(ft) : ft.toFixed(1);
}
