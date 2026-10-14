// "Draw on photo" shapes — geometry shared by the draw screen. Mirrors the
// DRAW ON PHOTO section of main.py (shape_parts, SHAPE_COLOURS, SHARED_EDGE),
// which draws the same shapes onto the guide image the image model gets.
//
// A shape: { item_id, sub_index, kind: "rect" | "L" | "corner", colour,
//   points: [[x, y], ...] as fractions of the photo's width and height,
//   backrest: [edge | null per part], lounge: part index | null (L only) }.
// Edge i of a part runs from its corner i to corner i + 1.

// Colour names go into the prompt ("RED shape: ..."), so they are plain words.
export const SHAPE_COLOURS = [
  { name: "RED", hex: "#E53935" },
  { name: "BLUE", hex: "#1E5BFF" },
  { name: "GREEN", hex: "#12A150" },
  { name: "YELLOW", hex: "#FFD000" },
  { name: "PURPLE", hex: "#8E3BD9" },
  { name: "CYAN", hex: "#00B8D4" },
  { name: "ORANGE", hex: "#FF7A00" },
  { name: "PINK", hex: "#FF4FA3" },
];
export const COLOUR_HEX = Object.fromEntries(SHAPE_COLOURS.map((c) => [c.name, c.hex]));

// the edge of each part of a two-part shape that it shares with the other part
export const SHARED_EDGE = { 0: 2, 1: 3 };

/** The shape a piece is drawn with; null for a curved sofa (not supported). */
export function pieceKind(subShape) {
  if (subShape === "L") return "L";
  if (subShape === "corner") return "corner";
  if (subShape === "curved") return null;
  return "rect";
}

/** One row per piece that gets its own shape ("3+2" is two), in item order,
 * each with its own colour. */
export function piecesOf(items) {
  const pieces = items.flatMap((item) => {
    const subs = item.sub_pieces && item.sub_pieces.length ? item.sub_pieces : [{ sub_index: 0, label: item.type, shape: item.shape }];
    return subs.map((sub) => ({
      key: `${item.id}:${sub.sub_index}`,
      item_id: item.id,
      sub_index: sub.sub_index,
      name: `${item.category} · ${subs.length > 1 ? sub.label : item.type}`,
      photo_url: item.photo_url,
      kind: pieceKind(subs.length > 1 ? sub.shape : item.shape),
    }));
  });
  return pieces.map((p, i) => ({ ...p, colour: SHAPE_COLOURS[i % SHAPE_COLOURS.length].name }));
}

function intersect(a, b, c, d) {
  const [x1, y1] = a;
  const [x2, y2] = b;
  const [x3, y3] = c;
  const [x4, y4] = d;
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** The 4-corner parts of a shape. An L or corner sofa is one outline of six
 * corners p0..p5 clockwise from the outer corner of its first part:
 * part 0 = p0 p1 q p5, part 1 = q p2 p3 p4, where q is where line p5-p4 meets
 * line p1-p2 — so the two parts always stay joined along q-p4. */
export function shapeParts(kind, points) {
  if (kind === "rect") return [points.slice(0, 4)];
  const [p0, p1, p2, p3, p4, p5] = points;
  const q = intersect(p5, p4, p1, p2) || [(p1[0] + p2[0]) / 2, (p4[1] + p5[1]) / 2];
  return [
    [p0, p1, q, p5],
    [q, p2, p3, p4],
  ];
}

/** May this edge of this part carry the backrest? Never the lounge, never
 * the edge where two parts meet. */
export function backrestAllowed(shape, part, edge) {
  if (shape.kind === "L" && shape.lounge === part) return false;
  if (shape.kind !== "rect" && SHARED_EDGE[part] === edge) return false;
  return true;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const round5 = (v) => Math.round(v * 100000) / 100000;

/** A new shape for a piece, dropped in the lower middle of the photo (the
 * floor), offset a little per piece so shapes don't land on each other. The
 * backrest starts on the edge farthest from the camera (the top edge). */
export function newShape(piece, index) {
  const dx = ((index % 3) - 1) * 0.12;
  const dy = (index % 2) * 0.05;
  const at = (x, y) => [round5(clamp01(x + dx)), round5(clamp01(y + dy))];
  const base = { item_id: piece.item_id, sub_index: piece.sub_index, kind: piece.kind, colour: piece.colour };
  if (piece.kind === "rect") {
    return { ...base, points: [at(0.37, 0.58), at(0.63, 0.58), at(0.63, 0.72), at(0.37, 0.72)], backrest: [0], lounge: null };
  }
  const points = [at(0.3, 0.52), at(0.7, 0.52), at(0.7, 0.82), at(0.58, 0.82), at(0.58, 0.64), at(0.3, 0.64)];
  // part 1's own outside edge (q-p2) carries a corner sofa's second backrest
  return piece.kind === "L" ? { ...base, points, backrest: [0, null], lounge: 1 } : { ...base, points, backrest: [0, 0], lounge: null };
}

/** The whole shape moved by (dx, dy), kept inside the photo. */
export function moveShape(shape, origPoints, dx, dy) {
  const xs = origPoints.map((p) => p[0]);
  const ys = origPoints.map((p) => p[1]);
  const mx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
  const my = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
  return { ...shape, points: origPoints.map(([x, y]) => [round5(x + mx), round5(y + my)]) };
}

export function moveCorner(shape, index, x, y) {
  return { ...shape, points: shape.points.map((p, i) => (i === index ? [round5(clamp01(x)), round5(clamp01(y))] : p)) };
}

/** An L's lounge moves to the other part; the long run gets its default backrest. */
export function swapLounge(shape) {
  const lounge = shape.lounge === 0 ? 1 : 0;
  const backrest = [0, 0];
  backrest[lounge] = null;
  return { ...shape, lounge, backrest };
}

/** Mirrored left to right (the lounge on the other side); edges keep their numbers. */
export function flipShape(shape) {
  const xs = shape.points.map((p) => p[0]);
  const axis = Math.min(...xs) + Math.max(...xs);
  return { ...shape, points: shape.points.map(([x, y]) => [round5(clamp01(axis - x)), y]) };
}

export function centroid(corners) {
  return [corners.reduce((s, p) => s + p[0], 0) / corners.length, corners.reduce((s, p) => s + p[1], 0) / corners.length];
}
