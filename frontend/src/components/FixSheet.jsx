import { useState } from "react";
import { BottomSheet } from "./BottomSheet.jsx";
import { Chip } from "./Chip.jsx";

// Keys match FIX_PIECE_ACTIONS / FIX_ROOM_ACTIONS on the server, which turns
// them into the edit prompt.
const PIECE_FIXES = [
  { key: "push_back", label: "Push back to the wall" },
  { key: "corner", label: "Move into the corner" },
  { key: "left", label: "Move left" },
  { key: "right", label: "Move right" },
  { key: "smaller", label: "Make smaller" },
  { key: "bigger", label: "Make bigger" },
];
const OPPOSITE = { left: "right", right: "left", smaller: "bigger", bigger: "smaller" };
const ROOM_FIXES = [
  { key: "coffee_table", label: "Remove coffee table" },
  { key: "plant", label: "Remove plant" },
  { key: "rug", label: "Remove rug" },
];
const TEXT_MAX = 300;

/** One row per piece a block can be placed for: a "3+2" set is two pieces. */
function piecesOf(items) {
  return items.flatMap((item) => {
    const subs = item.sub_pieces && item.sub_pieces.length ? item.sub_pieces : [{ sub_index: 0, label: item.type }];
    return subs.map((sub) => ({
      key: `${item.id}:${sub.sub_index}`,
      item_id: item.id,
      sub_index: sub.sub_index,
      name: `${item.category} · ${subs.length > 1 ? sub.label : item.type}`,
      photo_url: item.photo_url,
    }));
  });
}

/** "Fix this": quick fixes per piece, room fixes and an optional note, sent
 * as one small edit of the picture being shown. `onSubmit` gets
 * { pieces: [{ item_id, sub_index, action }], room: [key], text }. */
export function FixSheet({ items, deep, busy, onClose, onSubmit }) {
  const pieces = piecesOf(items);
  const [picked, setPicked] = useState({}); // "itemId:subIndex" -> Set of fix keys
  const [room, setRoom] = useState(new Set());
  const [text, setText] = useState("");

  function togglePiece(pieceKey, fixKey) {
    setPicked((prev) => {
      const next = new Set(prev[pieceKey] || []);
      if (next.has(fixKey)) next.delete(fixKey);
      else {
        next.add(fixKey);
        if (OPPOSITE[fixKey]) next.delete(OPPOSITE[fixKey]); // left and right can't both be asked
      }
      return { ...prev, [pieceKey]: next };
    });
  }

  function toggleRoom(fixKey) {
    setRoom((prev) => {
      const next = new Set(prev);
      if (next.has(fixKey)) next.delete(fixKey);
      else next.add(fixKey);
      return next;
    });
  }

  const pieceChoices = pieces.flatMap((p) =>
    [...(picked[p.key] || [])].map((action) => ({ item_id: p.item_id, sub_index: p.sub_index, action }))
  );
  const note = text.trim();
  const nothing = pieceChoices.length === 0 && room.size === 0 && !note;

  return (
    <BottomSheet title="Fix this" onClose={busy ? () => {} : onClose}>
      <div className="fix-sheet">
        {deep ? <div className="fix-hint">For bigger changes, use Adjust &amp; try again.</div> : null}

        {pieces.map((p) => (
          <div key={p.key} className="fix-piece">
            <div className="fix-piece-head">
              {p.photo_url ? <img src={p.photo_url} alt="" /> : null}
              <span>{p.name}</span>
            </div>
            <div className="chips">
              {PIECE_FIXES.map((f) => (
                <Chip key={f.key} selected={(picked[p.key] || new Set()).has(f.key)} onClick={() => togglePiece(p.key, f.key)}>
                  {f.label}
                </Chip>
              ))}
            </div>
          </div>
        ))}

        <div className="section-label" style={{ marginTop: 16 }}>Room</div>
        <div className="chips">
          {ROOM_FIXES.map((f) => (
            <Chip key={f.key} selected={room.has(f.key)} onClick={() => toggleRoom(f.key)}>
              {f.label}
            </Chip>
          ))}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Anything else to fix?</div>
        <textarea
          className="fix-text"
          rows={2}
          maxLength={TEXT_MAX}
          placeholder="Optional"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="muted" style={{ fontSize: 12.5, margin: "10px 0 12px" }}>
          Only these changes are made; the rest of the picture stays. Uses the same credits as a new picture.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={nothing || busy}
            onClick={() => onSubmit({ pieces: pieceChoices, room: [...room], text: note || null })}
          >
            {busy ? "Starting…" : "Fix"}
          </button>
          <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </BottomSheet>
  );
}
