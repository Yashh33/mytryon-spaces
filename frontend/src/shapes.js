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

/** The shape a piece is drawn with. */
export function pieceKind(subShape) {
  if (subShape === "L") return "L";
  if (subShape === "corner") return "corner";
  if (subShape === "curved") return "curved";
  return "rect";
}

/** The type in a shape's label: L-SHAPE, CORNER SOFA, 3-SEATER, ARMCHAIR,
 * DINING TABLE ... With seats picked on the Furniture step: "L-SHAPE · 3
 * SEATS + LOUNGE", "CORNER · 3 + 2 SEATS", "CURVED · 4 SEATS". Mirrors
 * shape_type_label in main.py. */
export function typeLabel(category, label, kind, picked = null) {
  if (picked && kind === "L") return `L-SHAPE · ${picked.long} SEATS + LOUNGE`;
  if (picked && kind === "corner") return `CORNER · ${picked.long} + ${picked.short} SEATS`;
  if (picked && kind === "curved") return `CURVED · ${picked.total} SEATS`;
  if (kind === "L") return "L-SHAPE";
  if (kind === "corner") return "CORNER SOFA";
  if (kind === "curved") return "CURVED SOFA";
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
      const widthFt = subs.length > 1 ? sub.width_ft : item.width_ft;
      const kind = pieceKind(subs.length > 1 ? sub.shape : item.shape);
      return {
        key: `${item.id}:${sub.sub_index}`,
        item_id: item.id,
        sub_index: sub.sub_index,
        name: `${item.category} · ${label}`,
        label,
        photo_url: item.photo_url,
        kind,
        type: typeLabel(item.category, label, kind, subs.length > 1 ? null : item.seats),
        width_ft: widthFt,
        category: item.category,
        seats: subs.length > 1 ? null : item.seats || null, // picked on the Furniture step (L / corner / curved)
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
  if (kind === "curved") return []; // a curved band has no 4-corner parts: see curvedOutline
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
  if (shape.kind === "curved") return false; // always its back arc
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
export function newShape(piece, index, aspect = 1.5) {
  const dx = ((index % 3) - 1) * 0.12;
  const dy = (index % 2) * 0.05;
  const at = (x, y) => [round5(clampIn(x + dx)), round5(clampIn(y + dy))];
  const base = { item_id: piece.item_id, sub_index: piece.sub_index, kind: piece.kind, colour: piece.colour };
  if (piece.kind === "rect") {
    return { ...base, points: [at(0.37, 0.58), at(0.63, 0.58), at(0.63, 0.72), at(0.37, 0.72)], backrest: [0], lounge: null };
  }
  if (piece.kind === "curved") {
    // centred across the photo a little below the middle, backrest on the far
    // side, ends coming toward the camera, with a gentle curve (30% of the deepest bend)
    const [half, backY, frontY, inset] = [0.22, 0.62, 0.71, 0.04];
    const sag = 0.3 * BEND_MAX * (2 * half * aspect); // photo-height units, toward the back
    const c = (x, y) => [round5(clampIn(x)), round5(clampIn(y))];
    const points = [
      c(0.5 - half, backY),
      c(0.5 + half, backY),
      c(0.5 + half - inset, frontY),
      c(0.5 - half + inset, frontY),
      c(0.5, backY - sag),
    ];
    return { ...base, points, backrest: [0], lounge: null };
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

// ---- a curved sofa -------------------------------------------------------------
// Five points: p0, p1 the back arc's ends, p2, p3 the front arc's ends (p2
// beside p1, p3 beside p0), p4 the middle of the back arc. Each arc is a
// quadratic curve through its ends and its middle; the front arc's middle is
// p4 moved as far as the front ends sit from the back ends, so the seat keeps
// its depth. Dots on p0..p3; the bend handle is p4. Mirrors curved_outline in
// main.py, which draws the same band on the guide image.

export const CURVE_STEPS = 48;
const BEND_MIN = 0.02; // the flattest bend: the back arc's middle this share of its width off the straight line
const BEND_MAX = 0.6; // the deepest bend

function arc(a, middle, b, steps) {
  const c = [2 * middle[0] - (a[0] + b[0]) / 2, 2 * middle[1] - (a[1] + b[1]) / 2];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** A curved sofa's band: { outline, back } point lists (fractions of the photo). */
export function curvedOutline(points, steps = CURVE_STEPS) {
  const [p0, p1, p2, p3, p4] = points;
  const shift = [(p2[0] + p3[0]) / 2 - (p0[0] + p1[0]) / 2, (p2[1] + p3[1]) / 2 - (p0[1] + p1[1]) / 2];
  const back = arc(p0, p4, p1, steps);
  const front = arc(p2, [p4[0] + shift[0], p4[1] + shift[1]], p3, steps); // p2 -> p3, so the outline runs round
  return { outline: [...back, ...front], back };
}

/** The back arc's chord in photo pixels: middle, unit normal, length, and how
 * far p4 sits off the chord along that normal. */
function bendOf(points, aspect) {
  const P = points.map(([x, y]) => [x * aspect, y]);
  const [p0, p1, , , p4] = P;
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (len < 1e-6) return null;
  const normal = [-(p1[1] - p0[1]) / len, (p1[0] - p0[0]) / len];
  const sag = (p4[0] - mid[0]) * normal[0] + (p4[1] - mid[1]) * normal[1];
  return { mid, normal, len, sag };
}

function placeBend(points, sag, aspect) {
  const b = bendOf(points, aspect);
  if (!b) return null;
  const p4 = [(b.mid[0] + b.normal[0] * sag) / aspect, b.mid[1] + b.normal[1] * sag];
  const out = [...points.slice(0, 4), p4];
  if (out.some(([x, y]) => outside(x) || outside(y))) return null;
  return out.map(([x, y]) => [round5(clampIn(x)), round5(clampIn(y))]);
}

/** `origPoints` (a curved sofa) with its bend handle dragged to (x, y): the
 * back arc's middle moves straight out from the chord, between almost
 * straight and a deep curve, staying on the side it was on. Null when it
 * would leave the photo. */
export function bendCurve(origPoints, x, y, aspect) {
  const b = bendOf(origPoints, aspect);
  if (!b) return null;
  const side = b.sag < 0 ? -1 : 1;
  const want = ((x * aspect - b.mid[0]) * b.normal[0] + (y - b.mid[1]) * b.normal[1]) * side;
  const sag = side * Math.min(BEND_MAX * b.len, Math.max(BEND_MIN * b.len, want));
  return placeBend(origPoints, sag, aspect);
}

/** `origPoints` (a curved sofa) with corner `index` (0..3) moved to (x, y);
 * the bend follows, keeping its depth for the back arc's new width. */
export function moveCurvedCorner(origPoints, index, x, y, aspect) {
  const before = bendOf(origPoints, aspect);
  if (!before) return null;
  const moved = origPoints.map((p, i) => (i === index ? [clampIn(x), clampIn(y)] : p));
  const after = bendOf(moved, aspect);
  if (!after) return null;
  return placeBend(moved, (before.sag / before.len) * after.len, aspect);
}

// ---- an L-shape's (or corner sofa's) corners -------------------------------
// A two-part shape (L or corner sofa) shows dots only on its outer corners:
// p0, p1 (the back edge), p5 (the front corner of the long run) and p2 (the
// outer corner of the second part's tip). The inner corner p4 and the tip's
// inner corner p3 follow: the tip keeps its width along the back edge's
// direction, the second part's inner side heads for the same vanishing point
// as the shape's two sides, and the long run's front edge runs alongside its
// back edge.

const OUTER_DOTS = [0, 1, 2, 5];

/** Is this a two-part shape that moves as one piece (L or corner sofa)? */
export function isTwoPart(shape) {
  return shape.kind === "L" || shape.kind === "corner";
}

/** The corner indexes that get a dot when the shape is selected. */
export function cornerDots(shape) {
  if (shape.kind === "curved") return [0, 1, 2, 3]; // p4 is the bend handle
  return isTwoPart(shape) ? OUTER_DOTS : shape.points.map((_, i) => i);
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];

/** `origPoints` (an L or corner sofa) with outer corner `index` moved to
 * (x, y) and the two inner corners following; null when that gives no
 * sensible shape, so the caller keeps the last one that did. Worked in photo
 * pixels (`aspect` = w / h). */
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

// ---- turn on the floor ------------------------------------------------------------
// Turning a sofa as it would turn in the real room (the round handle spins it
// on the screen instead). The shape's 4 outer corners are taken as a real
// rectangle lying on the floor — the piece's width in feet by FLOOR_DEPTH_FT,
// or for an L / corner sofa its outer bounding rectangle, as deep as its
// drawn proportions suggest — and the perspective transform from that floor
// rectangle to the photo is worked out. Every point goes onto the floor,
// turns about the rectangle's centre and comes back through the same
// transform, so the shape keeps its size on the floor and every edge keeps
// its number (backrest line and LOUNGE stay put).

export const FLOOR_DEPTH_FT = 3;
const FALLBACK_WIDTH_FT = 6;
export const FLOOR_TURN_DEG_PER_WIDTH = 360; // dragging across the whole photo turns it all the way round

/** The 4 corners treated as the floor rectangle, in order round it. */
function floorQuad(points, kind) {
  if (kind === "L" || kind === "corner") {
    const [p0, p1, p2, p3, , p5] = points;
    // the bounding rectangle's 4th corner: the tip's edge line meets the long run's outer end line
    const d = intersect(p3, p2, p5, p0) || [p0[0] + p2[0] - p1[0], p0[1] + p2[1] - p1[1]];
    return [p0, p1, p2, d];
  }
  return points.slice(0, 4); // a rectangle's corners; a curved sofa's back ends then front ends
}

function applyHw(h, x, y) {
  const w = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w, w];
}

/** `origPoints` turned by `deg` on the floor (positive = clockwise seen from
 * above); null when the result would cross the horizon or leave the photo,
 * so the caller keeps the last shape that worked. */
export function turnOnFloor(origPoints, kind, deg, aspect, widthFt) {
  const quad = floorQuad(origPoints, kind);
  const W = widthFt > 0 ? widthFt : FALLBACK_WIDTH_FT;
  let D = FLOOR_DEPTH_FT;
  if (kind === "L" || kind === "corner") {
    // its bounding rectangle is deeper than a straight sofa: as the drawing's proportions suggest
    const px = (p) => [p[0] * aspect, p[1]];
    const back = Math.hypot(...sub(px(quad[1]), px(quad[0])));
    const side = Math.hypot(...sub(px(quad[2]), px(quad[1])));
    if (back > 1e-6) D = Math.min(W * 1.2, Math.max(FLOOR_DEPTH_FT, (W * side) / back));
  }
  const floor = [[0, 0], [W, 0], [W, D], [0, D]];
  const toPhoto = homography(floor, quad);
  const toFloor = homography(quad, floor);
  if (!toPhoto || !toFloor) return null;
  const a = (deg * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const centre = [W / 2, D / 2];
  const floorSide = Math.sign(applyHw(toPhoto, centre[0], centre[1])[2]); // the side of the horizon the floor is on
  const out = [];
  for (const [x, y] of origPoints) {
    const f = applyHw(toFloor, x, y);
    const dx = f[0] - centre[0];
    const dy = f[1] - centre[1];
    const turned = applyHw(toPhoto, centre[0] + dx * cos - dy * sin, centre[1] + dx * sin + dy * cos);
    if (Math.sign(turned[2]) !== floorSide || !Number.isFinite(turned[0]) || !Number.isFinite(turned[1])) return null;
    out.push([turned[0], turned[1]]);
  }
  if (out.some(([x, y]) => outside(x) || outside(y))) return null;
  return out.map(([x, y]) => [round5(x), round5(y)]);
}

/** The sign that makes a positive floor turn swing the sofa's FRONT toward
 * the right of the picture. A turn of +deg is clockwise seen from above, which
 * swings a front that faces the camera to the left, so such a sofa needs -1;
 * one whose front faces away from the camera (its back line below its
 * middle) needs +1. */
export function floorTurnSign(shape) {
  const { kind, points } = shape;
  let back;
  if (kind === "curved") back = [points[4]];
  else
    back = shapeParts(kind, points).flatMap((corners, part) => {
      const edge = shape.backrest?.[part];
      return edge == null ? [] : [corners[edge], corners[(edge + 1) % 4]];
    });
  if (!back.length) return -1;
  const backY = back.reduce((sum, p) => sum + p[1], 0) / back.length;
  const middleY = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return backY <= middleY ? -1 : 1;
}

/** An L's corner points with its lounge moved to the other end of its long
 * part, on the same side: the whole L mirrored along the long part's own
 * length in the floor's perspective (a projective mirror of the long part's
 * quad onto itself), so the long part stays exactly where it is and its
 * back line stays on the same wall edge. Null when the lounge won't fit on
 * the photo there (or the shape isn't an L). */
export function moveLoungeToOtherEnd(shape, aspect) {
  if (shape.kind !== "L" || shape.lounge == null) return null;
  const long = shapeParts("L", shape.points)[1 - shape.lounge];
  const len = (a, b) => Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1]);
  // u runs along the long part's length, v across it
  const lengthwise = len(long[0], long[1]) + len(long[2], long[3]) >= len(long[1], long[2]) + len(long[3], long[0]);
  const quad = lengthwise ? long : [long[1], long[2], long[3], long[0]];
  const square = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const toSquare = homography(quad, square);
  const toPhoto = homography(square, quad);
  if (!toSquare || !toPhoto) return null;
  const floorSide = Math.sign(applyHw(toPhoto, 0.5, 0.5)[2]);
  const out = [];
  for (const [x, y] of shape.points) {
    const [u, v] = applyHw(toSquare, x, y);
    const back = applyHw(toPhoto, 1 - u, v);
    if (Math.sign(back[2]) !== floorSide || !Number.isFinite(back[0]) || !Number.isFinite(back[1])) return null;
    out.push([back[0], back[1]]);
  }
  if (out.some(([x, y]) => outside(x) || outside(y))) return null;
  return out.map(([x, y]) => [round5(x), round5(y)]);
}

// ---- every point on the photo ------------------------------------------------------
// A shape fits when every point of it is at least EDGE inside the photo: its
// corners, the whole of a curved sofa's two arcs (sampled along the curve)
// and, with the 3D box guide, the raised top of its box — raised as main.py's
// _box_lift does: BOX_HEIGHT_FT at the scale of its back line (its length /
// the piece's width), more near the camera and less far away, by the
// distance below a horizon at BOX_HORIZON of the photo's height.

export const BOX_HEIGHT_FT = 1.4;
const BOX_HORIZON = 0.4;
const BOX_FALLBACK_WIDTH_FT = 6;

/** The floor outline a box is built on and the back line its scale is measured along. */
function boxOutline(shape, aspect) {
  const { kind, points } = shape;
  if (kind === "curved") {
    const { outline, back } = curvedOutline(points);
    return { outline, ruler: back };
  }
  if (kind === "rect") {
    const e = shape.backrest?.[0] ?? 0;
    return { outline: points.slice(0, 4), ruler: [points[e], points[(e + 1) % 4]] };
  }
  const backs = shapeParts(kind, points).flatMap((corners, part) => {
    const e = shape.backrest?.[part];
    return e == null ? [] : [[corners[e], corners[(e + 1) % 4]]];
  });
  const length = ([a, b]) => Math.hypot((b[0] - a[0]) * aspect, b[1] - a[1]);
  const ruler = backs.length ? backs.reduce((best, b) => (length(b) > length(best) ? b : best)) : [points[0], points[1]];
  return { outline: points, ruler };
}

/** How far (photo-height fractions) a floor point at height y is raised for its box top. */
function boxLift(ruler, aspect, widthFt) {
  let length = 0;
  for (let i = 1; i < ruler.length; i++) length += Math.hypot((ruler[i][0] - ruler[i - 1][0]) * aspect, ruler[i][1] - ruler[i - 1][1]);
  const base = BOX_HEIGHT_FT * (length / (widthFt > 0 ? widthFt : BOX_FALLBACK_WIDTH_FT));
  const backY = ruler.reduce((sum, p) => sum + p[1], 0) / ruler.length;
  if (backY - BOX_HORIZON < 1e-3) return () => base; // back line at or above the horizon
  return (y) => Math.max(0, (base * (y - BOX_HORIZON)) / (backY - BOX_HORIZON));
}

/** Does `shape` with these `points` fit on the photo with the EDGE margin —
 * its whole outline and, with `boxes`, its raised box top too? */
export function shapeFits(shape, points, aspect, widthFt, boxes) {
  const { outline, ruler } = boxOutline({ ...shape, points }, aspect);
  if (outline.some(([x, y]) => outside(x) || outside(y))) return false;
  if (!boxes) return true;
  const lift = boxLift(ruler, aspect, widthFt);
  return outline.every(([, y]) => y - lift(y) >= EDGE - 1e-6);
}

// ---- one part of an L / corner sofa longer or shorter -------------------------------
// Part 0 (the long part) = p0 p1 q p5, part 1 (the second part) = q p2 p3 p4,
// q where line p5-p4 meets line p1-p2. Only the chosen part's free end moves.

const pix = (p, aspect) => [p[0] * aspect, p[1]];
const unpix = (p, aspect) => [p[0] / aspect, p[1]];
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const unit = (v) => {
  const n = Math.hypot(v[0], v[1]);
  return n > 1e-9 ? [v[0] / n, v[1] / n] : null;
};

/** A part's long direction (unit vector, photo pixels with x scaled by
 * `aspect`, pointing to its free end) and its length along it. */
export function partAxis(points, part, aspect) {
  const P = points.map((p) => pix(p, aspect));
  const [p0, p1, p2, , , p5] = P;
  if (part === 1) {
    const q = intersect(P[5], P[4], p1, p2) || p1;
    return { dir: unit(sub(p2, p1)), length: dist(q, p2) };
  }
  return { dir: unit(sub(p0, p1)), length: dist(p1, p0), depth: dist(p0, p5) };
}

/** The points with one part's free end moved by `t` x that part's length
 * (+ longer, - shorter). Part 1: p2 moves along p1->p2 and p3 / p4 follow
 * as moveLCorner makes them (tip width, depth and part 0 unchanged). Part 0:
 * p0 moves along p1->p0 and p5 along p4->p5 to the point where the end edge
 * keeps its angle (p1..p4 unchanged). Null when a corner would leave the
 * photo or the part would become shorter than it is deep. */
export function extendPart(origPoints, part, t, aspect) {
  const P = origPoints.map((p) => pix(p, aspect));
  const [p0, p1, p2, p3, p4, p5] = P;
  if (part === 1) {
    const q = intersect(p5, p4, p1, p2);
    const dir = unit(sub(p2, p1));
    if (!q || !dir) return null;
    const length = dist(q, p2);
    const moved = add(p2, [dir[0] * t * length, dir[1] * t * length]);
    if (dist(q, moved) < dist(p2, p3)) return null; // never shorter than its tip is wide
    const [x, y] = unpix(moved, aspect);
    return moveLCorner(origPoints, 2, x, y, aspect);
  }
  const dir = unit(sub(p0, p1));
  if (!dir) return null;
  const length = dist(p1, p0);
  const newP0 = add(p0, [dir[0] * t * length, dir[1] * t * length]);
  // the end edge keeps its angle: p5 is where the line through the new p0, parallel to p0->p5, meets line p4->p5
  const newP5 = intersect(newP0, add(newP0, sub(p5, p0)), p4, p5);
  if (!newP5) return null;
  if (dist(p1, newP0) < dist(newP0, newP5)) return null; // never shorter than it is deep
  const out = P.map((p, i) => (i === 0 ? newP0 : i === 5 ? newP5 : p)).map((p) => unpix(p, aspect));
  if (out.some(([x, y]) => outside(x) || outside(y))) return null;
  return out.map(([x, y]) => [round5(x), round5(y)]);
}

/** Where a part's length handle sits (photo fractions): the middle of its
 * free end edge (p2-p3 for part 1, p0-p5 for part 0), pushed `gap` (in
 * photo-height units) outward along the part. */
export function partEndHandle(points, part, aspect, gap) {
  const P = points.map((p) => pix(p, aspect));
  const [a, b] = part === 1 ? [P[2], P[3]] : [P[0], P[5]];
  const { dir } = partAxis(points, part, aspect);
  const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const at = dir ? add(middle, [dir[0] * gap, dir[1] * gap]) : middle;
  return { at: unpix(at, aspect), angle: dir ? (Math.atan2(dir[1], dir[0]) * 180) / Math.PI : 0 };
}

// ---- seat sections and facing arrows ----------------------------------------
// The dashed seat-section lines and white facing arrows, in photo pixels on
// the floor. Mirrors seat_sections, _square_to_quad, _u_along, _seat_maps,
// seat_section_lines, seat_arrow_starts, facing_fronts and draw_facing_arrows
// in main.py, so the editor draws what the guide image and the Preview draw
// (there they are raised onto the top of each box).

const SEATER_RE = /^(\d+)-seater$/;
export const SEAT_DASH = 7; // dash and gap, in pixels for a 1536 px wide photo
export const SEAT_GAP = 5;
const GUIDE_LINE_PX = 12;
const ARROW_START = 0.12; // an arrow starts this share of the depth in front of its black line
const ARROW_LENGTH = 1 / 3; // and is this share of the depth long
const ARROW_MIN_PX = 44; // but at least this long (for a 1536 px wide photo)
const ARROW_MAX_REACH = 0.85; // and never past this share of the depth

/** A piece's seat sections, or null: a straight sofa {n} (two or more); an L
 * {n: the long part's seats}; a corner sofa {n: with the corner seat, m: the
 * shorter part's}; a curved sofa {n}. L / corner / curved only with seats
 * picked on the Furniture step. */
export function seatSections(piece) {
  if (piece.kind === "L" || piece.kind === "corner" || piece.kind === "curved") {
    const seats = piece.seats;
    if (!seats) return null;
    return piece.kind === "corner" ? { n: seats.long, m: seats.short } : { n: seats.long || seats.total };
  }
  const match = piece.category === "Sofa" ? SEATER_RE.exec(piece.label || "") : null;
  const count = match ? Number(match[1]) : null;
  return count && count >= 2 ? { n: count } : null;
}

const midOf = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const edgeMid = (corners, edge) => midOf(corners[edge % 4], corners[(edge + 1) % 4]);

/** The projective map from the unit square to a quad's four corners. */
function squareToQuad(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, h;
  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    [a, b, c, d, e, f, g, h] = [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  } else {
    const [dx1, dx2, dy1, dy2] = [x1 - x2, x3 - x2, y1 - y2, y3 - y2];
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
    [a, b, c] = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0];
    [d, e, f] = [y1 - y0 + g * y1, y3 - y0 + h * y3, y0];
  }
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

/** Where `point` (on the line v of the map `at`) is along it, 0-1. */
function uAlong(at, point, v) {
  let [lo, hi] = [0, 1];
  const start = at(0, v);
  const end = at(1, v);
  const [ex, ey] = [end[0] - start[0], end[1] - start[1]];
  const target = (point[0] - start[0]) * ex + (point[1] - start[1]) * ey;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const [mx, my] = at(mid, v);
    if ((mx - start[0]) * ex + (my - start[1]) * ey < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The point `share` of the way along a polyline (photo fractions), in pixels. */
function pointAlong(line, share, W, H) {
  const pts = line.map(([x, y]) => [x * W, y * H]);
  const lengths = pts.slice(1).map((p, i) => dist(pts[i], p));
  const goal = share * lengths.reduce((s, l) => s + l, 0);
  let run = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (run + lengths[i] >= goal && lengths[i] > 0) {
      const t = (goal - run) / lengths[i];
      const [a, b] = [pts[i], pts[i + 1]];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    run += lengths[i];
  }
  return pts[pts.length - 1];
}

/** Parts in pixels, each part's unit-square map (null without a black line), and u4. */
function seatMaps(shape, W, H) {
  const parts = shapeParts(shape.kind, shape.points).map((part) => part.map(([x, y]) => [x * W, y * H]));
  const maps = parts.map((corners, index) => {
    const edge = index < shape.backrest.length ? shape.backrest[index] : null;
    return edge == null ? null : squareToQuad([0, 1, 2, 3].map((i) => corners[(edge + i) % 4]));
  });
  let u4 = null;
  if (shape.kind !== "rect") {
    const p4 = [shape.points[4][0] * W, shape.points[4][1] * H];
    u4 = maps[0] && shape.backrest[0] === 0 ? uAlong(maps[0], p4, 1) : null;
  }
  return { parts, maps, u4 };
}

function longPartIndex(shape, parts) {
  if (shape.kind === "L") return 1 - shape.lounge;
  const longest = parts.map((c) => Math.max(...[0, 1, 2, 3].map((i) => dist(c[i], c[(i + 1) % 4]))));
  return longest[0] >= longest[1] ? 0 : 1;
}

/** The dashed seat-section lines [[back point, front point], ...] in photo pixels. */
export function seatSectionLines(shape, sections, W, H) {
  const { n, m } = sections;
  if (shape.kind === "curved") {
    const { outline, back } = curvedOutline(shape.points);
    const front = outline.slice(back.length).reverse(); // p3 -> p2, alongside the back arc
    const lines = [];
    for (let k = 1; k < n; k++) lines.push([pointAlong(back, k / n, W, H), pointAlong(front, k / n, W, H)]);
    return lines;
  }
  const { parts, maps, u4 } = seatMaps(shape, W, H);
  const split = (index, count, lo = 0, hi = 1, ends = []) => {
    const at = maps[index];
    if (!at) return [];
    const cuts = [];
    for (let k = 1; k < count; k++) cuts.push(lo + ((hi - lo) * k) / count);
    return [...cuts, ...ends].map((u) => [at(u, 0), at(u, 1)]);
  };
  if (shape.kind === "rect") return split(0, n);
  const longIndex = shape.kind === "L" ? 1 - shape.lounge : longPartIndex(shape, parts);
  const joinEnd = (index) => {
    const at = maps[index];
    const q = parts[1][0];
    return dist(at(0, 0.5), q) <= dist(at(1, 0.5), q) ? 0 : 1;
  };
  if (shape.kind === "L") {
    if (longIndex === 0) return u4 != null ? split(0, n, 0, u4, [u4]) : split(0, n);
    return maps[1] ? split(1, n, 0, 1, [joinEnd(1)]) : [];
  }
  if (u4 == null) return [...split(longIndex, n), ...split(1 - longIndex, m)];
  if (longIndex === 0) {
    const longLines = n > 1 ? split(0, n - 1, 0, u4, [u4]) : split(0, 1, 0, 1, [u4]);
    return [...longLines, ...split(1, m, 0, 1, maps[1] ? [joinEnd(1)] : [])];
  }
  return [...(maps[1] ? split(1, n - 1, 0, 1, [joinEnd(1)]) : []), ...split(0, m, 0, u4, [u4])];
}

/** Where each part's arrow starts when it has seat lines: by part index
 * ("curved" for a curved sofa), the middle of a seat section on its
 * black-line edge — the middle one for an odd count, the one just left of
 * centre in the photo for an even count. */
export function seatArrowStarts(shape, sections, W, H) {
  const { n, m } = sections;
  const even = (lo, hi, count) => Array.from({ length: count }, (_, k) => [lo + ((hi - lo) * k) / count, lo + ((hi - lo) * (k + 1)) / count]);
  const middleOf = (spans, pointAt) => {
    if (!spans.length) return null;
    if (spans.length % 2) {
      const [low, high] = spans[(spans.length - 1) / 2];
      return pointAt((low + high) / 2);
    }
    const [left, right] = spans.slice(spans.length / 2 - 1, spans.length / 2 + 1).map((s) => pointAt((s[0] + s[1]) / 2));
    return left[0] <= right[0] ? left : right;
  };
  if (shape.kind === "curved") {
    const { back } = curvedOutline(shape.points);
    return { curved: middleOf(even(0, 1, n), (share) => pointAlong(back, share, W, H)) };
  }
  const { parts, maps, u4 } = seatMaps(shape, W, H);
  const spans = {};
  if (shape.kind === "rect") spans[0] = even(0, 1, n);
  else if (shape.kind === "L") {
    const longIndex = 1 - shape.lounge;
    spans[longIndex] = even(0, longIndex === 0 && u4 != null ? u4 : 1, n);
  } else {
    const longIndex = longPartIndex(shape, parts);
    if (u4 == null) {
      spans[longIndex] = even(0, 1, n);
      spans[1 - longIndex] = even(0, 1, m);
    } else if (longIndex === 0) {
      spans[0] = [...even(0, u4, n - 1), [u4, 1]];
      spans[1] = even(0, 1, m);
    } else {
      spans[1] = even(0, 1, n - 1);
      spans[0] = even(0, u4, m);
    }
  }
  const out = {};
  for (const [index, partSpans] of Object.entries(spans)) {
    const at = maps[index];
    if (at) out[index] = middleOf(partSpans, (u) => at(u, 0));
  }
  return out;
}

/** The parts the facing arrows are about, in photo pixels: {back, front, start, part}. */
function facingFronts(shape, W, H) {
  if (shape.kind === "curved") {
    const [p0, p1, p2, p3, p4] = shape.points.map(([x, y]) => [x * W, y * H]);
    return [{ back: midOf(p0, p1), front: midOf(p2, p3), start: p4, part: "curved" }];
  }
  const parts = shapeParts(shape.kind, shape.points).map((part) => part.map(([x, y]) => [x * W, y * H]));
  let order = [0];
  if (shape.kind !== "rect") {
    const longIndex = longPartIndex(shape, parts);
    order = shape.kind === "L" ? [longIndex] : [longIndex, 1 - longIndex];
  }
  return order.map((index) => {
    const corners = parts[index];
    let edge = shape.backrest[index];
    if (edge == null) {
      // no black line set: its longest edge
      edge = [1, 2, 3].reduce((best, i) => (dist(corners[i], corners[(i + 1) % 4]) > dist(corners[best], corners[(best + 1) % 4]) ? i : best), 0);
    }
    const back = edgeMid(corners, edge);
    return { back, front: edgeMid(corners, edge + 2), start: back, part: String(index) };
  });
}

/** The white facing arrows as polygons in photo pixels, on the floor: from
 * near the black line toward the front, along the black-edge middle ->
 * opposite-edge middle direction; from a seat section's middle when the
 * piece has `sections` (seatSections). */
export function facingArrows(shape, sections, W, H) {
  const unit = W / 1536;
  const [shaft, head, headLen] = [5 * unit, 13 * unit, 18 * unit];
  const starts = sections ? seatArrowStarts(shape, sections, W, H) : {};
  const polygons = [];
  for (const front of facingFronts(shape, W, H)) {
    const [vx, vy] = [front.front[0] - front.back[0], front.front[1] - front.back[1]];
    const depth = Math.hypot(vx, vy);
    const gap = Math.max(depth * ARROW_START, GUIDE_LINE_PX * 0.75);
    if (depth * ARROW_MAX_REACH <= gap) continue;
    const [ux, uy] = [vx / depth, vy / depth];
    const from = starts[front.part] || front.start;
    const start = [from[0] + ux * gap, from[1] + uy * gap];
    const limit = [from[0] + ux * depth * ARROW_MAX_REACH, from[1] + uy * depth * ARROW_MAX_REACH];
    const room = dist(start, limit);
    const length = Math.min(Math.max(depth * ARROW_LENGTH, ARROW_MIN_PX * unit), room);
    if (length < 1) continue;
    const [px, py] = [-uy, ux];
    const tip = Math.min(headLen, length * 0.5);
    const neck = length - tip;
    const at = (along, across) => [start[0] + ux * along + px * across, start[1] + uy * along + py * across];
    polygons.push([at(0, shaft), at(neck, shaft), at(neck, head), at(length, 0), at(neck, -head), at(neck, -shaft), at(0, -shaft)]);
  }
  return polygons;
}
