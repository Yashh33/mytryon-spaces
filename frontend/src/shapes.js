// "Draw on photo" shapes — geometry shared by the draw screen. Mirrors the
// DRAW ON PHOTO section of main.py (shape_parts, SHAPE_COLOURS, SHARED_EDGE),
// which draws the same shapes onto the guide image the image model gets.
//
// A shape: { item_id, sub_index, kind: "rect" | "L" | "corner", colour,
//   points: [[x, y], ...] as fractions of the photo's width and height,
//   backrest: [edge | null per part], lounge: part index | null (L only) }.
// Edge i of a part runs from its corner i to corner i + 1.

// Colour names go into the prompt ("BLUE shape: ..."), so they are plain words.
// Never red, orange, brown, beige, grey or white: those read as sofa materials.
// A piece's colour comes from its place in the list (the server does the same).
export const SHAPE_COLOURS = [
  { name: "BLUE", hex: "#1E5BFF" },
  { name: "MAGENTA", hex: "#E820A0" },
  { name: "GREEN", hex: "#12A150" },
  { name: "PURPLE", hex: "#8E3BD9" },
  { name: "CYAN", hex: "#00B8D4" },
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

/** The type in a shape's label: L-SHAPE, CORNER SOFA, 3-SEATER, ARMCHAIR,
 * DINING TABLE ... Mirrors shape_type_label in main.py. */
export function typeLabel(category, label, kind) {
  if (kind === "L") return "L-SHAPE";
  if (kind === "corner") return "CORNER SOFA";
  const m = category === "Sofa" ? /^(\d+)-seater$/.exec(label || "") : null;
  const seats = m ? Number(m[1]) : null;
  if (category === "Chair" || seats === 1) return "ARMCHAIR";
  if (seats) return `${seats}-SEATER`;
  return String(category || "").toUpperCase();
}

/** One row per piece that gets its own shape ("3+2" is two), in item order,
 * each with its own colour and the label drawn above its shape ("1 · L-SHAPE"),
 * as on the guide image the image model gets. */
export function piecesOf(items) {
  const pieces = items.flatMap((item) => {
    const subs = item.sub_pieces && item.sub_pieces.length ? item.sub_pieces : [{ sub_index: 0, label: item.type, shape: item.shape }];
    return subs.map((sub) => {
      const label = subs.length > 1 ? sub.label : item.type;
      const kind = pieceKind(subs.length > 1 ? sub.shape : item.shape);
      return {
        key: `${item.id}:${sub.sub_index}`,
        item_id: item.id,
        sub_index: sub.sub_index,
        name: `${item.category} · ${label}`,
        photo_url: item.photo_url,
        kind,
        type: typeLabel(item.category, label, kind),
      };
    });
  });
  return pieces.map((p, i) => ({ ...p, colour: SHAPE_COLOURS[i % SHAPE_COLOURS.length].name, tag: `${i + 1} · ${p.type}` }));
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

// Every corner of every shape stays at least EDGE (2% of the photo) inside its edges.
export const EDGE = 0.02;
const clampIn = (v) => Math.min(1 - EDGE, Math.max(EDGE, v));
const outside = (v) => v < EDGE - 1e-6 || v > 1 - EDGE + 1e-6;
const round5 = (v) => Math.round(v * 100000) / 100000;

/** A new shape for a piece, dropped in the lower middle of the photo (the
 * floor), offset a little per piece so shapes don't land on each other. The
 * backrest starts on the edge farthest from the camera (the top edge). */
export function newShape(piece, index) {
  const dx = ((index % 3) - 1) * 0.12;
  const dy = (index % 2) * 0.05;
  const at = (x, y) => [round5(clampIn(x + dx)), round5(clampIn(y + dy))];
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
  const mx = Math.min(Math.max(dx, EDGE - Math.min(...xs)), 1 - EDGE - Math.max(...xs));
  const my = Math.min(Math.max(dy, EDGE - Math.min(...ys)), 1 - EDGE - Math.max(...ys));
  return { ...shape, points: origPoints.map(([x, y]) => [round5(x + mx), round5(y + my)]) };
}

export function moveCorner(shape, index, x, y) {
  return { ...shape, points: shape.points.map((p, i) => (i === index ? [round5(clampIn(x)), round5(clampIn(y))] : p)) };
}

// ---- an L-shape's corners ---------------------------------------------------
// An L shows dots only on its outer corners: p0, p1 (the back edge), p5 (the
// front corner of the long run) and p2 (the outer corner of the lounge tip).
// The inner corner p4 and the tip's inner corner p3 follow: the tip keeps its
// width along the back edge's direction, the lounge's inner side heads for
// the same vanishing point as the shape's two sides, and the long run's front
// edge runs alongside its back edge.

const L_OUTER_DOTS = [0, 1, 2, 5];

/** The corner indexes that get a dot when the shape is selected. */
export function cornerDots(shape) {
  return shape.kind === "L" ? L_OUTER_DOTS : shape.points.map((_, i) => i);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];

/** `origPoints` (an L) with outer corner `index` moved to (x, y) and the two
 * inner corners following; null when that gives no sensible L, so the caller
 * keeps the last one that did. Worked in photo pixels (`aspect` = w / h). */
export function moveLCorner(origPoints, index, x, y, aspect) {
  const pix = ([px, py]) => [px * aspect, py];
  const P = origPoints.map(pix);
  P[index] = pix([clampIn(x), clampIn(y)]);
  const [p0, p1, p2, , , p5] = P;
  const tipWidth = Math.hypot(...sub(pix(origPoints[3]), pix(origPoints[2])));
  const back = sub(p0, p1);
  const backLen = Math.hypot(...back);
  if (backLen < 1e-6) return null;
  const p3 = add(p2, [(back[0] / backLen) * tipWidth, (back[1] / backLen) * tipWidth]);
  const vanish = intersect(p0, p5, p1, p2);
  const toward = vanish && Math.hypot(...sub(vanish, p3)) > 1e-6 ? vanish : add(p3, sub(p1, p2));
  const p4 = intersect(p5, add(p5, sub(p1, p0)), p3, toward);
  if (!p4) return null;
  const out = [p0, p1, p2, p3, p4, p5].map(([px, py]) => [px / aspect, py]);
  if (out.some(([px, py]) => outside(px) || outside(py))) return null;
  return out.map(([px, py]) => [round5(clampIn(px)), round5(clampIn(py))]);
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
  return { ...shape, points: shape.points.map(([x, y]) => [round5(clampIn(axis - x)), y]) };
}

/** Mirrored top to bottom about its centre (an L's lounge goes from the
 * camera side to the back-wall side, or back); edges keep their numbers, so
 * the backrest line and LOUNGE move with them. */
export function flipShapeVertical(shape) {
  const ys = shape.points.map((p) => p[1]);
  const axis = Math.min(...ys) + Math.max(...ys);
  return { ...shape, points: shape.points.map(([x, y]) => [x, round5(clampIn(axis - y))]) };
}

// ---- whole-shape resize / rotate ------------------------------------------
// Done in photo pixels (x scaled by the photo's width/height `aspect`), so a
// shape keeps its true form on a photo of any shape. Only the corner points
// change: every edge keeps its number, so the backrest and the lounge stay
// on the same edges.

const MIN_SIZE = 0.03; // a shape never shrinks below this share of the photo
export const ROTATE_SNAP_DEG = 5; // within this of a quarter turn, it snaps to it

/** The point a shape resizes and turns about: the middle of its corners. */
export function shapeCentre(points) {
  return [points.reduce((s, p) => s + p[0], 0) / points.length, points.reduce((s, p) => s + p[1], 0) / points.length];
}

/** Turn of `deg` degrees snapped to 0, 90, 180 or 270 when within ROTATE_SNAP_DEG. */
export function snapAngle(deg) {
  const quarter = Math.round(deg / 90) * 90;
  return Math.abs(deg - quarter) <= ROTATE_SNAP_DEG ? quarter : deg;
}

function offsets(points, centre, aspect, deg) {
  const a = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  return points.map(([x, y]) => {
    const dx = (x - centre[0]) * aspect;
    const dy = y - centre[1];
    return [(dx * cos - dy * sin) / aspect, dx * sin + dy * cos];
  });
}

/** The largest scale the turned shape can take about `centre` and still
 * stay inside the photo — the shape stops at the edge. */
function maxScale(offs, centre) {
  let limit = Infinity;
  for (const [dx, dy] of offs) {
    if (dx > 1e-9) limit = Math.min(limit, (1 - EDGE - centre[0]) / dx);
    if (dx < -1e-9) limit = Math.min(limit, (centre[0] - EDGE) / -dx);
    if (dy > 1e-9) limit = Math.min(limit, (1 - EDGE - centre[1]) / dy);
    if (dy < -1e-9) limit = Math.min(limit, (centre[1] - EDGE) / -dy);
  }
  return limit;
}

/** `origPoints` scaled by `scale` and turned by `deg` (clockwise on screen)
 * about their centre, never smaller than MIN_SIZE and never outside the
 * photo. With `fixedCentre` (the resize handle) growth stops where the
 * shape meets the photo's edge. Without it (a turn, or a pinch) the shape
 * is nudged back onto the photo; a pinch stops growing at the photo's size,
 * and a turn that can't fit at its size returns null, so the caller keeps
 * the last shape that did. */
export function transformPoints(origPoints, scale, deg, aspect, fixedCentre = false) {
  const centre = shapeCentre(origPoints);
  const offs = offsets(origPoints, centre, aspect, deg);
  const lo = (i) => Math.min(...offs.map((o) => o[i]));
  const hi = (i) => Math.max(...offs.map((o) => o[i]));
  const smallest = Math.min(hi(0) - lo(0), hi(1) - lo(1));
  const minScale = smallest > 0 ? MIN_SIZE / smallest : 0;
  let s = Math.max(scale, minScale);
  if (fixedCentre) {
    s = Math.min(s, maxScale(offs, centre));
    if (s < 1e-6) return null;
  } else {
    const fit = Math.min((1 - 2 * EDGE) / Math.max(hi(0) - lo(0), 1e-9), (1 - 2 * EDGE) / Math.max(hi(1) - lo(1), 1e-9));
    if (s > fit) {
      // a turn alone (scale 1) never changes the size: it stops instead;
      // a pinch stops growing at the photo's size
      if (scale === 1) return null;
      s = fit;
    }
  }
  // nudge back onto the photo
  const shift = (i) => {
    const min = centre[i] + lo(i) * s;
    const max = centre[i] + hi(i) * s;
    return min < EDGE ? EDGE - min : max > 1 - EDGE ? 1 - EDGE - max : 0;
  };
  const [sx, sy] = [shift(0), shift(1)];
  return offs.map(([dx, dy]) => [round5(clampIn(centre[0] + sx + dx * s)), round5(clampIn(centre[1] + sy + dy * s))]);
}

// ---- tilt (up / down) ---------------------------------------------------------
// Laying a shape flatter on the floor, like a rug seen in perspective: its
// height shrinks and its far (top) edge gets a little narrower than its near
// edge. Done with a perspective transform of the shape's bounding box about
// its centre, so straight edges stay straight and every edge keeps its number.

export const TILT_HALVING = 0.15; // dragging up this share of the photo's height halves the shape's height
const TILT_TAPER = 0.3; // how much narrower the far edge gets as the shape flattens
const TILT_MIN = 0.2;
const TILT_MAX = 4;

/** Height factor for a tilt drag of `dy` (photo-height fractions, down positive). */
export function tiltFactor(dy) {
  return Math.min(TILT_MAX, Math.max(TILT_MIN, 2 ** (dy / TILT_HALVING)));
}

/** The 8 numbers of the perspective transform taking 4 src points to 4 dst points. */
function homography(src, dst) {
  const m = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 9; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[8] / row[i]);
}

/** `origPoints` tilted: height times `k` about the centre of their bounding
 * box, the top edge narrower than the bottom when k < 1 (wider when k > 1).
 * Null when the result would be too small or leave the photo. */
export function tiltPoints(origPoints, k, aspect) {
  const P = origPoints.map(([x, y]) => [x * aspect, y]);
  const xs = P.map((p) => p[0]);
  const ys = P.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [w, h] = [maxX - minX, maxY - minY];
  if (w < 1e-6 || h < 1e-6 || h * k < MIN_SIZE) return null;
  const [cx, cy] = [(minX + maxX) / 2, (minY + maxY) / 2];
  const s = TILT_TAPER * (1 - k);
  const half = (h * k) / 2;
  const t = homography(
    [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
    [
      [cx - (w * (1 - s)) / 2, cy - half],
      [cx + (w * (1 - s)) / 2, cy - half],
      [cx + (w * (1 + s)) / 2, cy + half],
      [cx - (w * (1 + s)) / 2, cy + half],
    ]
  );
  if (!t) return null;
  const out = P.map(([x, y]) => {
    const d = t[6] * x + t[7] * y + 1;
    return [(t[0] * x + t[1] * y + t[2]) / d / aspect, (t[3] * x + t[4] * y + t[5]) / d];
  });
  if (out.some(([x, y]) => outside(x) || outside(y))) return null;
  return out.map(([x, y]) => [round5(clampIn(x)), round5(clampIn(y))]);
}

export function centroid(corners) {
  return [corners.reduce((s, p) => s + p[0], 0) / corners.length, corners.reduce((s, p) => s + p[1], 0) / corners.length];
}
