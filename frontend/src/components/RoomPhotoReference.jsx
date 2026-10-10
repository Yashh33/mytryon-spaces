import { POSITION_THIRD_INDEX, WALL_KEY, mergeAdjacentFeatures } from "../placement.js";

const WALL_ORDER = ["far", "left", "right", "near"];

function letterFor(n) {
  const first = String.fromCharCode(65 + (n % 26));
  return n < 26 ? first : String.fromCharCode(65 + Math.floor(n / 26) - 1) + first;
}

function groupName(group) {
  if ((group.type === "unknown" || group.type === "other") && group.notes) return group.notes;
  return group.type || "feature";
}

function capitalise(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Assigns A, B, C… to every feature the plan draws (merged groups per wall,
 * far → left → right → near, then placed obstructions). Both the photo's list
 * and the plan read this, so a letter always means the same thing. Returns
 * { walls: { far: ["A", …], … }, obstructions: { [index]: "E" }, items: [{ letter, text }] }. */
export function featureLetters(layout) {
  const walls = {};
  const obstructions = {};
  const items = [];
  let n = 0;

  WALL_ORDER.forEach((wall) => {
    const features = layout?.[WALL_KEY[wall]]?.features || [];
    walls[wall] = mergeAdjacentFeatures(features).map((group) => {
      const letter = letterFor(n++);
      const positions = group.indices
        .map((i) => features[i].position)
        .sort((a, b) => POSITION_THIRD_INDEX[a] - POSITION_THIRD_INDEX[b]);
      const where = positions.length > 1 && positions[0] !== positions[positions.length - 1]
        ? `${positions[0]} to ${positions[positions.length - 1]}`
        : positions[0];
      items.push({ letter, text: `${capitalise(groupName(group))} – ${wall} wall, ${where}` });
      return letter;
    });
  });

  (layout?.obstructions || []).forEach((o, index) => {
    if (o.x == null || o.y == null) return; // only the ones the plan actually draws
    const letter = letterFor(n++);
    obstructions[index] = letter;
    items.push({ letter, text: `${capitalise(o.type || "obstruction")} – ${o.location || "on the plan"}` });
  });

  return { walls, obstructions, items };
}

/** The original room photo with the four walls named on top of it, plus the
 * lettered list of the room's doors/windows/stairs/pillars. */
export function RoomPhotoReference({ room }) {
  const { items } = featureLetters(room.layout_json);

  return (
    <div className="rpr">
      <div className="rpr-photo">
        {room.photo_url ? <img src={room.photo_url} alt="The room photo" /> : <div className="rpr-nophoto">No photo</div>}
        <span className="rpr-bar rpr-bar-left" />
        <span className="rpr-bar rpr-bar-right" />
        <span className="rpr-chip rpr-far">FAR WALL</span>
        <span className="rpr-chip rpr-left">LEFT WALL</span>
        <span className="rpr-chip rpr-right">RIGHT WALL</span>
        <span className="rpr-chip rpr-near">NEAR WALL &middot; you stood here</span>
      </div>
      {items.length ? (
        <ul className="rpr-list">
          {items.map((it) => (
            <li key={it.letter}>
              {it.letter} &middot; {it.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
