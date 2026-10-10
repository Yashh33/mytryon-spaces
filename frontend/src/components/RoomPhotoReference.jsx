import { WALL_ORDER, planFeatures } from "../placement.js";

/** The room's doors/windows/pillars as a list, each under the same label the
 * plan draws beside it (DOOR 1, WINDOW, PILLAR?…), so a name always means the
 * same thing in both places. */
export function featureList(layout) {
  const features = planFeatures(layout);
  const items = [];
  WALL_ORDER.forEach((wall) => {
    features.walls[wall].forEach((group) => {
      const where = group.positions.length > 1 ? `${group.positions[0]} to ${group.positions[group.positions.length - 1]}` : group.positions[0];
      items.push({ label: group.label, color: group.color, text: `${wall} wall, ${where}` });
    });
  });
  features.obstructions.forEach((o) => {
    items.push({ label: o.label, color: o.color, text: o.location || "on the plan" });
  });
  return items;
}

/** The original room photo with the four walls named on top of it, plus the
 * labelled list of the room's doors/windows/stairs/pillars. */
export function RoomPhotoReference({ room }) {
  const items = featureList(room.layout_json);

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
            <li key={it.label}>
              <b style={{ color: it.color }}>{it.label}</b> &middot; {it.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
