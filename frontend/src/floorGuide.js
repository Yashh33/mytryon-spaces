// "Draw on photo (Beta)": the floor's perspective and the see-through boxes,
// for the live preview. Mirrors the DRAW ON PHOTO section of main.py
// (plan_feet, homography, piece_parts, draw_floor_guide), which draws the
// same guide image for the image model.

// Never red, orange, brown, beige, grey or white: those look like sofa materials.
export const GUIDE_COLOURS = [
  { name: "blue", hex: "#1E5BFF" },
  { name: "magenta", hex: "#E820A0" },
  { name: "green", hex: "#12A150" },
  { name: "purple", hex: "#8E3BD9" },
  { name: "cyan", hex: "#00B8D4" },
];
// back-left, back-right, front-left, front-right — fractions of the photo
export const DEFAULT_FLOOR_QUAD = [[0.25, 0.58], [0.75, 0.58], [0.0, 1.0], [1.0, 1.0]];
export const FLOOR_POINT_MIN = -0.5;
export const FLOOR_POINT_MAX = 1.5;
export const BOX_HEIGHT_FT = 1.4;
export const TOP_OPACITY = 0.38;
export const SIDE_OPACITY = 0.27;
export const OUTLINE_PX = 3;
export const BACK_LINE_PX = 9;
// the edge (by its first corner) a rect's back is on: rotation names the wall the back faces
const BACK_EDGE = { 0: 0, 270: 1, 180: 2, 90: 3 };

/** Width and depth (feet) of the visible floor: 12 x 10 ft, turned or squared
 * when the room reader says the room is deeper than wide or about square. */
export function planFeetFor(room) {
  const shape = room?.layout_json?.depth_vs_width;
  if (shape === "deeper than wide") return { wFt: 10, hFt: 12 };
  if (shape === "about square") return { wFt: 11, hFt: 11 };
  return { wFt: 12, hFt: 10 };
}

/** The 8 numbers of the perspective transform taking 4 src points to 4 dst points. */
export function homography(src, dst) {
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

export function applyH(h, x, y) {
  const w = h[6] * x + h[7] * y + 1;
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/** Floor corners (fractions) -> transform from the unit square (u across, v from back to front). */
export function floorTransform(quad) {
  return homography([[0, 0], [1, 0], [1, 1], [0, 1]], [quad[0], quad[1], quad[3], quad[2]]);
}

/** The guide's label for a piece: L-SHAPE, CORNER SOFA, 3-SEATER, ARMCHAIR ... */
export function typeLabel(category, label, shape) {
  if (shape === "L") return "L-SHAPE";
  if (shape === "corner") return "CORNER SOFA";
  const m = category === "Sofa" ? /^(\d+)-seater$/.exec(label || "") : null;
  const seats = m ? Number(m[1]) : null;
  if (category === "Chair" || seats === 1) return "ARMCHAIR";
  if (seats) return `${seats}-SEATER`;
  return String(category || "").toUpperCase();
}

/** One entry per piece, in label order, with its number, guide colour and the
 * Image number of its product photo (one per item). */
export function guidePieces(items) {
  const pieces = [];
  items.forEach((item, itemIndex) => {
    const subs = item.sub_pieces && item.sub_pieces.length ? item.sub_pieces : [{ sub_index: 0, label: item.type, shape: item.shape }];
    subs.forEach((sub) => {
      const number = pieces.length + 1;
      const label = subs.length > 1 ? sub.label : item.type;
      const shape = subs.length > 1 ? sub.shape : item.shape;
      pieces.push({
        key: `${item.id}-${sub.sub_index}`,
        itemId: item.id,
        subIndex: sub.sub_index,
        number,
        shape,
        label,
        typeLabel: typeLabel(item.category, label, shape),
        colour: GUIDE_COLOURS[(number - 1) % GUIDE_COLOURS.length],
        image: itemIndex + 2,
        photoUrl: item.photo_url,
        description: item.short_description,
      });
    });
  });
  return pieces;
}

function trimSecondArm(long, short) {
  const ox0 = Math.max(long.x, short.x);
  const oy0 = Math.max(long.y, short.y);
  const ox1 = Math.min(long.x + long.w, short.x + short.w);
  const oy1 = Math.min(long.y + long.h, short.y + short.h);
  if (ox1 <= ox0 || oy1 <= oy0) return short;
  const r = { ...short };
  if (short.h >= short.w) {
    const cut = oy1 - oy0;
    if (Math.abs(oy0 - short.y) < 1e-6) r.y = short.y + cut;
    r.h = Math.max(short.h - cut, 1e-4);
  } else {
    const cut = ox1 - ox0;
    if (Math.abs(ox0 - short.x) < 1e-6) r.x = short.x + cut;
    r.w = Math.max(short.w - cut, 1e-4);
  }
  return r;
}

/** The boxes a piece is drawn as: [{ rect, back (edge | null), lounge }]. */
export function pieceParts(shape, g) {
  if (shape === "rect" || shape === "round") return [{ rect: g, back: shape === "round" ? null : BACK_EDGE[g.rotation], lounge: false }];
  return [
    { rect: g.long, back: BACK_EDGE[g.long.rotation], lounge: false },
    { rect: trimSecondArm(g.long, g.short), back: shape === "L" ? null : BACK_EDGE[g.short.rotation], lounge: shape === "L" },
  ];
}

/** Every placed piece as boxes in photo pixels (W x H photo), farthest first,
 * plus which side of the picture each L's lounge lands on. */
export function guideBoxes(quad, W, H, feet, pieces, placementByKey) {
  const dots = quad.map(([x, y]) => [x * W, y * H]);
  const h = homography([[0, 0], [feet.wFt, 0], [feet.wFt, feet.hFt], [0, feet.hFt]], [dots[0], dots[1], dots[3], dots[2]]);
  if (!h) return { boxes: [], loungeSide: {} };
  const lift = (u, v) => {
    const b = applyH(h, u, v);
    const a1 = applyH(h, u - 0.5, v);
    const a2 = applyH(h, u + 0.5, v);
    const pxPerFt = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]);
    return [b, [b[0], b[1] - BOX_HEIGHT_FT * pxPerFt]];
  };
  const boxes = [];
  const loungeSide = {};
  pieces.forEach((piece) => {
    const g = placementByKey[piece.key];
    if (!g) return;
    const parts = pieceParts(piece.shape, g).map((part) => {
      const { x, y, w, h: hh } = part.rect;
      const x0 = x * feet.wFt;
      const y0 = y * feet.hFt;
      const x1 = x0 + w * feet.wFt;
      const y1 = y0 + hh * feet.hFt;
      const lifted = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([u, v]) => lift(u, v));
      return { ...part, bottom: lifted.map((p) => p[0]), top: lifted.map((p) => p[1]), depth: y1 };
    });
    if (piece.shape === "L") {
      const cx = (pts) => pts.reduce((s, p) => s + p[0], 0) / pts.length;
      loungeSide[piece.number] = cx(parts[1].top) < cx(parts[0].top) ? "LEFT" : "RIGHT";
    }
    boxes.push({ piece, parts, depth: Math.max(...parts.map((p) => p.depth)) });
  });
  boxes.sort((a, b) => a.depth - b.depth);
  return { boxes, loungeSide };
}

export function darker(hex) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * 0.6));
  return `rgb(${c.join(",")})`;
}
