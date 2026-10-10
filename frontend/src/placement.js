// Pure geometry/data helpers for the floor-plan placement screen. No React,
// no DOM — kept separate from FloorPlan.jsx / Place.jsx so the placement
// math is easy to reason about and test in isolation.

export const PALETTE = ["#F07522", "#2563EB", "#16A34A", "#9333EA"];

// [width-ratio, depth-ratio]. Depth maps to the plan's vertical axis (the
// camera looks from near/bottom toward far/top), width to the horizontal
// axis, so "wider than deep" is landscape (wide > tall) and "deeper than
// wide" is portrait (tall > wide).
export const ROOM_ASPECT = {
  "wider than deep": [4, 3],
  "deeper than wide": [3, 4],
  "about square": [1, 1],
};

// No real-world room dimensions exist anywhere in this data model (the
// vision layout is qualitative only). This is a deliberate, documented
// approximation purely for sizing blocks on the plan — it never leaves
// the browser and is never sent to the backend.
export const ASSUMED_ROOM_LONGEST_FT = 18;
export const BLOCK_DEPTH_RATIO = 0.35; // depth as a fraction of length, fixed per the spec
export const WALL_SNAP_TOLERANCE = 0.04;
export const WALL_TOLERANCE = 0.06; // matches the backend resolver's "against a wall" threshold

// The room rectangle fills ~70% of the plan's area, leaving a margin all
// round (outside the room) for wall-feature labels, their leader lines and
// the camera marker. Room area fraction = (1 - 2*ROOM_MARGIN_FRACTION)^2.
export const ROOM_MARGIN_FRACTION = 0.083;
const PLAN_BASE_SIZE = 400;
// A dedicated band below the near-wall label margin, just for the camera
// marker and its "Camera" label — fixed in pixels so it fits regardless of
// the room's aspect (a proportional margin can be too thin in portrait).
const CAMERA_BAND = 36;

/** Plan-space geometry for a room of the given aspect: where the room
 * rectangle sits (roomX/roomY/roomW/roomH) inside the full plan canvas
 * (planW/planH), which is larger than the room to leave a label margin
 * (plus, at the bottom, the camera band). */
export function planGeometry(depthVsWidth) {
  const [aw, ah] = roomAspect(depthVsWidth);
  const scale = PLAN_BASE_SIZE / Math.max(aw, ah);
  const roomW = aw * scale;
  const roomH = ah * scale;
  const f = ROOM_MARGIN_FRACTION;
  const marginX = (roomW * f) / (1 - 2 * f);
  const marginY = (roomH * f) / (1 - 2 * f);
  return {
    roomX: marginX,
    roomY: marginY,
    roomW,
    roomH,
    marginX,
    marginY,
    planW: roomW + marginX * 2,
    planH: roomH + marginY * 2 + CAMERA_BAND,
  };
}

/** Horizontal fraction (0-1) along the near wall for the camera marker. */
export function cameraXFraction(cameraPosition) {
  const p = (cameraPosition || "").toLowerCase();
  if (p.includes("left")) return 0.15;
  if (p.includes("right")) return 0.85;
  return 0.5;
}

/** Camera marker geometry: a circle just below the near wall, two short
 * dashed lines fanning up into the room to show the view direction, and
 * where its "Camera" label sits — all within CAMERA_BAND. */
export function cameraGeometry(cameraPosition, geom) {
  const cx = geom.roomX + cameraXFraction(cameraPosition) * geom.roomW;
  const wallY = geom.roomY + geom.roomH;
  const cy = wallY + 16;
  return {
    cx,
    cy,
    r: 6,
    fanLeft: { x: cx - 14, y: wallY },
    fanRight: { x: cx + 14, y: wallY },
    labelY: cy + 16,
  };
}

// Label placement for merged wall-feature groups (see mergeAdjacentFeatures):
// far/near labels sit above/below the room, side-wall labels sit outside
// that wall, right-aligned on the left and left-aligned on the right.
// Collisions (labels landing too close together) push the later one an
// extra "row" further out — see assignLabelRows.
const LABEL_BASE_OFFSET = 14;
const LABEL_ROW_STEP = 12;
const MIN_LABEL_GAP = 70; // px, along the wall's length axis

/** Assigns each group (in wall order) a collision row: 0 normally, 1+ when
 * its label would otherwise land within MIN_LABEL_GAP of another group's,
 * so the later one stacks further from the wall instead of overlapping. */
export function assignLabelRows(groups, geom, wall) {
  const isFarNear = wall === "far" || wall === "near";
  const mids = groups.map(({ span }) => {
    const t = (span[0] + span[1]) / 2;
    return isFarNear ? geom.roomX + t * geom.roomW : geom.roomY + t * geom.roomH;
  });
  const order = mids.map((_, i) => i).sort((a, b) => mids[a] - mids[b]);
  const rowLastMid = [];
  const rows = new Array(groups.length);
  order.forEach((i) => {
    let row = 0;
    while (rowLastMid[row] != null && mids[i] - rowLastMid[row] < MIN_LABEL_GAP) row += 1;
    rowLastMid[row] = mids[i];
    rows[i] = row;
  });
  return rows;
}

/** Where a merged group's label and its text-anchor go, outside the room
 * rectangle on the wall's own side. */
export function labelPosition(wall, span, row, geom) {
  const mid = (span[0] + span[1]) / 2;
  const { roomX, roomY, roomW, roomH } = geom;
  if (wall === "far") {
    return { x: roomX + mid * roomW, y: roomY - LABEL_BASE_OFFSET - row * LABEL_ROW_STEP, anchor: "middle" };
  }
  if (wall === "near") {
    return { x: roomX + mid * roomW, y: roomY + roomH + LABEL_BASE_OFFSET + row * LABEL_ROW_STEP, anchor: "middle" };
  }
  if (wall === "left") {
    return { x: roomX - LABEL_BASE_OFFSET, y: roomY + mid * roomH + row * LABEL_ROW_STEP, anchor: "end" };
  }
  return { x: roomX + roomW + LABEL_BASE_OFFSET, y: roomY + mid * roomH + row * LABEL_ROW_STEP, anchor: "start" }; // right
}

export const THIRD_BOUNDS = [
  [0, 1 / 3],
  [1 / 3, 2 / 3],
  [2 / 3, 1],
];
export const POSITION_THIRD_INDEX = {
  "left third": 0, centre: 1, "right third": 2,
  "far third": 0, "middle third": 1, "near third": 2,
};
export const FAR_NEAR_POSITIONS = ["left third", "centre", "right third"];
export const SIDE_POSITIONS = ["far third", "middle third", "near third"];
export const SIZE_FILL = { small: 0.4, medium: 0.7, large: 1.0 };

export const WALL_KEY = { far: "far_wall", left: "left_wall", right: "right_wall", near: "near_wall" };
export const ROTATION_FOR_WALL = { far: 0, left: 90, near: 180, right: 270 };
export const WALL_FOR_ROTATION = { 0: "far", 90: "left", 180: "near", 270: "right" };

// Feature types that create a gap in the wall line rather than sitting on
// its solid face.
export const GAP_TYPES = new Set(["door", "doorway", "opening", "balcony door", "glazed opening", "window", "unknown"]);
export const DOUBLE_DASHED_GAP_TYPES = new Set(["glazed opening"]);
export const DASHED_GAP_TYPES = new Set(["balcony door"]);
export const WINDOW_TYPES = new Set(["window"]);
export const ARC_TYPES = new Set(["door", "doorway"]);
export const UNKNOWN_TYPES = new Set(["unknown"]);
export const BAND_TYPES = new Set(["recess", "built-in"]);
export const POINT_TYPES = new Set(["pillar", "column"]);

// Feature types a salesman can add via "Add feature" (obstructions —
// pillar/column — are added separately, via "Add obstruction").
export const ADDABLE_FEATURE_TYPES = [
  "window", "door", "doorway", "opening", "balcony door", "glazed opening", "built-in", "recess", "step", "other",
];

// Fill/border colour for each wall-feature (and obstruction) type, for the
// 2D floor-plan style. Anything not listed falls back to the neutral
// recess/step/unknown/other pair. Drawing-only.
export const FEATURE_COLORS = {
  window: { fill: "#DBEAFE", border: "#2563EB" },
  door: { fill: "#8B5A2B", border: "#6B4420" },
  doorway: { fill: "#8B5A2B", border: "#6B4420" },
  "balcony door": { fill: "#8B5A2B", border: "#6B4420" },
  opening: { fill: "#ECEAE6", border: "#6B665F" },
  "glazed opening": { fill: "#DBEAFE", border: "#2563EB" },
  pillar: { fill: "#B42318", border: "#7A1710" },
  column: { fill: "#B42318", border: "#7A1710" },
  panelling: { fill: "#EDE4FF", border: "#7C3AED" },
};
export const DEFAULT_FEATURE_COLOR = { fill: "#ECEAE6", border: "#6B665F" };

export function featureColor(type) {
  return FEATURE_COLORS[type] || DEFAULT_FEATURE_COLOR;
}

// Whether a feature type physically blocks furniture from standing in
// front of it. Only meaningful for salesman-added features — vision-
// generated ones never carry this flag (the backend that produces them is
// unchanged), so they're simply never flagged as an overlap risk.
export function defaultBlocksFurniture(type) {
  return ["door", "doorway", "opening", "balcony door", "glazed opening", "step", "built-in"].includes(type);
}

export function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

export function roomAspect(depthVsWidth) {
  return ROOM_ASPECT[depthVsWidth] || ROOM_ASPECT["about square"];
}

/** Normalised [start, end] span of a wall feature, centred within its third. */
export function featureSpan(position, size) {
  const idx = POSITION_THIRD_INDEX[position];
  if (idx == null) return null;
  const [lo, hi] = THIRD_BOUNDS[idx];
  const thirdWidth = hi - lo;
  const fill = SIZE_FILL[size] || SIZE_FILL.medium;
  const span = thirdWidth * fill;
  const start = lo + (thirdWidth - span) / 2;
  return [round4(start), round4(start + span)];
}

/** Groups a wall's features into render-ready groups, merging runs of
 * consecutive-third features of the same type into one wider span (e.g.
 * three "unknown" features across left/centre/right thirds become one band
 * across the whole wall) instead of drawing three overlapping symbols.
 * Each group carries the original `indices` it was built from, so deleting
 * a merged band can remove every feature it represents. */
export function mergeAdjacentFeatures(features) {
  const withSlots = features
    .map((feature, index) => ({ feature, index, slot: POSITION_THIRD_INDEX[feature.position] }))
    .filter((f) => f.slot != null)
    .sort((a, b) => a.slot - b.slot);

  const groups = [];
  withSlots.forEach((entry) => {
    const prev = groups[groups.length - 1];
    if (prev && prev.type === entry.feature.type && entry.slot === prev.lastSlot + 1) {
      prev.members.push(entry);
      prev.lastSlot = entry.slot;
    } else {
      groups.push({ type: entry.feature.type, members: [entry], lastSlot: entry.slot });
    }
  });

  return groups.map((group) => {
    const spans = group.members.map((m) => featureSpan(m.feature.position, m.feature.size)).filter(Boolean);
    const start = Math.min(...spans.map((s) => s[0]));
    const end = Math.max(...spans.map((s) => s[1]));
    const primary = group.members[0].feature;
    return {
      type: group.type,
      notes: primary.notes,
      span: [start, end],
      blocksFurniture: group.members.some((m) => m.feature.blocks_furniture),
      indices: group.members.map((m) => m.index),
    };
  });
}

/** Builds the flat list of placeable "blocks" from an attempt's items — one
 * block per placeable sub-piece, taken directly from each item's server-side
 * sub_pieces breakdown (see GET /api/attempts/{id}) rather than recomputed
 * here. Each block's placement comes from the matching entry (by sub_index)
 * in the item's placement array, or null if that sub-piece isn't placed
 * yet — every sub-piece has a real server-side slot via
 * /api/attempts/{id}/items/{item_id}/placement/{sub_index}. */
export function itemsToBlocks(items) {
  const blocks = [];
  let colorIndex = 0;
  items.forEach((item) => {
    const subPieces = item.sub_pieces && item.sub_pieces.length ? item.sub_pieces : [{ sub_index: 0, label: item.type, shape: item.shape, width_ft: item.width_ft }];
    const placedBySubIndex = new Map((item.placement || []).map((entry) => [entry.sub_index, entry.geometry]));
    const isSplit = subPieces.length > 1;
    subPieces.forEach((sp) => {
      blocks.push({
        key: `${item.id}-${sp.sub_index}`,
        itemId: item.id,
        subIndex: sp.sub_index,
        label: isSplit ? `${item.category} — ${sp.label}` : `${item.category} (${item.type})`,
        // Raw category/type/sub-piece label, kept alongside the formatted
        // `label` above purely so the plan can style and caption each piece
        // (sofa seat count, dining/bed styling, etc.) — never read for
        // geometry and never sent back to the API.
        category: item.category,
        type: item.type,
        subLabel: sp.label,
        shape: sp.shape,
        widthFt: sp.width_ft,
        inSet: isSplit,
        placement: placedBySubIndex.get(sp.sub_index) || null,
        color: PALETTE[colorIndex % PALETTE.length],
        number: colorIndex + 1,
      });
      colorIndex += 1;
    });
  });
  return blocks;
}

// ---------------------------------------------------------------------------
// Drawing-only labelling helpers (seat counts, backrest captions). None of
// these feed geometry, facing or the saved placement shape — purely what
// text/band to draw on top of a block FloorPlan.jsx has already placed.
// ---------------------------------------------------------------------------

/** "n SEATER" count for a straight sofa block: from its sub-piece label when
 * it states one (e.g. "3-seater"), else from its own type string (e.g. a
 * single unsplit sofa typed "3+2" never reaches here — that always splits —
 * but a future straight single type stating a number would resolve the same
 * way), else estimated from length and clamped to a sane range. */
export function sofaSeatCount(block) {
  const fromText = (s) => {
    const m = /(\d+)\s*-?\s*seat/i.exec(s || "");
    return m ? parseInt(m[1], 10) : null;
  };
  const stated = fromText(block.subLabel) || fromText(block.type);
  const n = stated || Math.round(block.widthFt / 2.3);
  return Math.min(5, Math.max(1, n));
}

export function isStraightSofa(block) {
  return block.category === "Sofa" && block.shape === "rect";
}

export function isChair(block) {
  return block.category === "Chair" && block.shape === "rect";
}

export function isDiningTable(block) {
  return block.category === "Dining table";
}

export function isBed(block) {
  return block.category === "Bed";
}

/** Lightens (positive amt) or darkens (negative amt) a "#rrggbb" colour by
 * `amt` (-1..1) toward black/white. Drawing-only — used to derive a block's
 * backrest/seat/arm shades from its one base PALETTE colour. */
export function shadeColor(hex, amt) {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;
  const mix = (ch) => (amt >= 0 ? ch + (255 - ch) * amt : ch * (1 + amt));
  r = Math.round(Math.min(255, Math.max(0, mix(r))));
  g = Math.round(Math.min(255, Math.max(0, mix(g))));
  b = Math.round(Math.min(255, Math.max(0, mix(b))));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Block geometry. Placements are stored normalised (0-1 of the room's width
// and depth), but every rotate/flip/resize is done in feet, where both axes
// share one scale, so a block keeps its true proportions in a non-square
// room. Feet come from ASSUMED_ROOM_LONGEST_FT and the room's aspect.
//
// Shapes:
//   rect, round  {x, y, w, h, rotation}
//   L, curved, corner  {long, short, corner} — two arm rects meeting at a bend
//                in `corner`. A curved block is drawn as a quarter-annulus
//                spanning the same two arms; a corner sofa has a backrest
//                on both arms.
// A rect's `rotation` names the wall its BACK faces (0 far, 90 left,
// 180 near, 270 right); its seats face the opposite way.
// ---------------------------------------------------------------------------

export const ARM_SHAPES = new Set(["L", "curved", "corner"]);
export const MIN_BLOCK_FT = 1;
export const SET_PIECE_SNAP_FT = 1; // sub-pieces of a set derive whole-foot widths on the server
export const SINGLE_PIECE_SNAP_FT = 0.5; // matches the width input's step on the furniture step

// Unit vector (x right, y toward the camera) the seats face, per rotation —
// matches FACING_FOR_ROTATION in the backend resolver.
export const FACING_VECTOR = { 0: [0, 1], 90: [1, 0], 180: [0, -1], 270: [-1, 0] };

const CORNER_CW = { "far-left": "far-right", "far-right": "near-right", "near-right": "near-left", "near-left": "far-left" };

export function roomFeet(depthVsWidth) {
  const [aw, ah] = roomAspect(depthVsWidth);
  const longest = Math.max(aw, ah);
  return { wFt: (ASSUMED_ROOM_LONGEST_FT * aw) / longest, hFt: (ASSUMED_ROOM_LONGEST_FT * ah) / longest };
}

/** Rotates the back one wall clockwise (as seen on the plan): far -> right -> near -> left. */
export function rotateCW(rotation) {
  return (rotation + 270) % 360;
}

function snapTo(value, step) {
  return Math.max(MIN_BLOCK_FT, Math.round(value / step) * step);
}

/** Snaps a rect's edges to 0/1 when within WALL_SNAP_TOLERANCE. */
export function snapRect(rect) {
  let { x, y, w, h } = rect;
  if (x <= WALL_SNAP_TOLERANCE) x = 0;
  if (y <= WALL_SNAP_TOLERANCE) y = 0;
  if (1 - (x + w) <= WALL_SNAP_TOLERANCE) x = round4(1 - w);
  if (1 - (y + h) <= WALL_SNAP_TOLERANCE) y = round4(1 - h);
  return { ...rect, x: clamp01(round4(x)), y: clamp01(round4(y)) };
}

export function clampRectToRoom(rect) {
  const w = Math.min(rect.w, 1);
  const h = Math.min(rect.h, 1);
  return { ...rect, w, h, x: clamp01(Math.min(rect.x, 1 - w)), y: clamp01(Math.min(rect.y, 1 - h)) };
}

// ---- rect / round --------------------------------------------------------

function rectToFeet(rect, feet) {
  const alongX = rect.rotation % 180 === 0;
  const wF = rect.w * feet.wFt;
  const hF = rect.h * feet.hFt;
  return {
    cx: rect.x * feet.wFt + wF / 2,
    cy: rect.y * feet.hFt + hF / 2,
    lengthFt: alongX ? wF : hF,
    depthFt: alongX ? hF : wF,
    rotation: rect.rotation,
  };
}

function rectFromFeet({ cx, cy, lengthFt, depthFt, rotation }, feet) {
  const alongX = rotation % 180 === 0;
  const wF = Math.min(alongX ? lengthFt : depthFt, feet.wFt);
  const hF = Math.min(alongX ? depthFt : lengthFt, feet.hFt);
  return clampRectToRoom({
    x: round4((cx - wF / 2) / feet.wFt),
    y: round4((cy - hF / 2) / feet.hFt),
    w: round4(wF / feet.wFt),
    h: round4(hF / feet.hFt),
    rotation,
  });
}

// ---- L / curved arms -----------------------------------------------------

function cornerSigns(corner) {
  return { sx: corner.endsWith("left") ? 1 : -1, sy: corner.startsWith("far") ? 1 : -1 };
}

/** Recovers an arm placement's parameters in `units` (feet, or plan pixels
 * when passed {wFt: roomW, hFt: roomH}): the outer bend point (bx, by) in
 * `corner`, the two arm lengths, the depth, and which axis the long arm
 * runs along. */
export function armParams(placement, units) {
  const { long, short, corner } = placement;
  const { sx, sy } = cornerSigns(corner);
  const [L, S] = [long, short].map((r) => ({ x: r.x * units.wFt, y: r.y * units.hFt, w: r.w * units.wFt, h: r.h * units.hFt }));
  return {
    corner,
    bx: sx > 0 ? Math.min(L.x, S.x) : Math.max(L.x + L.w, S.x + S.w),
    by: sy > 0 ? Math.min(L.y, S.y) : Math.max(L.y + L.h, S.y + S.h),
    longAxis: L.w >= L.h ? "x" : "y",
    longFt: Math.max(L.w, L.h),
    shortFt: Math.max(S.w, S.h),
    depthFt: Math.min(L.w, L.h),
  };
}

/** Horizontal/vertical arm lengths and the bounding box of arm params. */
export function armExtent(p) {
  const { sx, sy } = cornerSigns(p.corner);
  const hLen = p.longAxis === "x" ? p.longFt : p.shortFt;
  const vLen = p.longAxis === "x" ? p.shortFt : p.longFt;
  const x0 = sx > 0 ? p.bx : p.bx - hLen;
  const y0 = sy > 0 ? p.by : p.by - vLen;
  return { sx, sy, hLen, vLen, x0, y0, x1: x0 + hLen, y1: y0 + vLen };
}

function clampArmParams(p, feet) {
  const e = armExtent(p);
  let dx = Math.min(0, feet.wFt - e.x1);
  if (e.x0 + dx < 0) dx = -e.x0;
  let dy = Math.min(0, feet.hFt - e.y1);
  if (e.y0 + dy < 0) dy = -e.y0;
  return { ...p, bx: p.bx + dx, by: p.by + dy };
}

/** Builds {long, short, corner} from arm params. Each arm's rotation is
 * derived from which side its back (the outer edge, on the bend's side)
 * faces, so rotate/flip can never leave an arm facing the wrong way. */
export function armsFromParams(p, feet) {
  const { sx, sy, hLen, vLen } = armExtent(p);
  const d = p.depthFt;
  const horiz = { x: sx > 0 ? p.bx : p.bx - hLen, y: sy > 0 ? p.by : p.by - d, w: hLen, h: d, rotation: sy > 0 ? 0 : 180 };
  const vert = { x: sx > 0 ? p.bx : p.bx - d, y: sy > 0 ? p.by : p.by - vLen, w: d, h: vLen, rotation: sx > 0 ? 90 : 270 };
  const toNorm = (r) => ({
    x: clamp01(round4(r.x / feet.wFt)),
    y: clamp01(round4(r.y / feet.hFt)),
    w: clamp01(round4(r.w / feet.wFt)),
    h: clamp01(round4(r.h / feet.hFt)),
    rotation: r.rotation,
  });
  const [long, short] = p.longAxis === "x" ? [horiz, vert] : [vert, horiz];
  return { long: toNorm(long), short: toNorm(short), corner: p.corner };
}

// ---- operations, by shape ------------------------------------------------

/** A fresh placement for a block dropped at normalised (nx, ny). */
export function defaultPlacement(shape, widthFt, feet, nx, ny) {
  const cx = nx * feet.wFt;
  const cy = ny * feet.hFt;
  if (ARM_SHAPES.has(shape)) {
    const longFt = Math.min(widthFt, feet.wFt);
    let shortFt;
    if (shape === "curved") shortFt = Math.min(longFt, feet.hFt);
    else if (shape === "corner") shortFt = Math.min(longFt * 0.8, feet.hFt);
    else shortFt = Math.min(longFt, longFt * BLOCK_DEPTH_RATIO + 2.5);
    const p = {
      corner: "far-left",
      longAxis: "x",
      longFt,
      shortFt,
      depthFt: longFt * BLOCK_DEPTH_RATIO,
      bx: cx - longFt / 2,
      by: cy - shortFt / 2,
    };
    return armsFromParams(clampArmParams(p, feet), feet);
  }
  const depthFt = shape === "round" ? widthFt : widthFt * BLOCK_DEPTH_RATIO;
  return rectFromFeet({ cx, cy, lengthFt: widthFt, depthFt, rotation: 0 }, feet);
}

/** Rotates a block 90 degrees clockwise about its own centre. */
export function rotatePlacement(shape, placement, feet) {
  if (ARM_SHAPES.has(shape)) {
    const p = armParams(placement, feet);
    const e = armExtent(p);
    const cx = (e.x0 + e.x1) / 2;
    const cy = (e.y0 + e.y1) / 2;
    const corner = CORNER_CW[p.corner];
    // the bounding box turns with it: width and depth swap about the centre
    const nx0 = cx - e.vLen / 2;
    const ny0 = cy - e.hLen / 2;
    const bx = corner.endsWith("left") ? nx0 : nx0 + e.vLen;
    const by = corner.startsWith("far") ? ny0 : ny0 + e.hLen;
    const q = { ...p, corner, bx, by, longAxis: p.longAxis === "x" ? "y" : "x" };
    return armsFromParams(clampArmParams(q, feet), feet);
  }
  const f = rectToFeet(placement, feet);
  return rectFromFeet({ ...f, rotation: rotateCW(f.rotation) }, feet);
}

/** Mirrors an L/curved block along its long arm, so the short arm turns the
 * other way while the long arm stays on its wall; updates `corner`. */
export function flipPlacement(shape, placement, feet) {
  if (!ARM_SHAPES.has(shape)) return placement;
  const p = armParams(placement, feet);
  const e = armExtent(p);
  const [depthWord, sideWord] = p.corner.split("-");
  const corner =
    p.longAxis === "x"
      ? `${depthWord}-${sideWord === "left" ? "right" : "left"}`
      : `${depthWord === "far" ? "near" : "far"}-${sideWord}`;
  const bx = corner.endsWith("left") ? e.x0 : e.x1;
  const by = corner.startsWith("far") ? e.y0 : e.y1;
  return armsFromParams({ ...p, corner, bx, by }, feet);
}

/** Moves a block rigidly by a normalised delta, snapping its outer edges to
 * nearby walls and keeping it inside the room. */
export function translatePlacement(shape, placement, dx, dy) {
  if (!ARM_SHAPES.has(shape)) {
    return clampRectToRoom(snapRect({ ...placement, x: placement.x + dx, y: placement.y + dy }));
  }
  const arms = [placement.long, placement.short].map((r) => ({ ...r, x: r.x + dx, y: r.y + dy }));
  let x0 = Math.min(...arms.map((r) => r.x));
  let y0 = Math.min(...arms.map((r) => r.y));
  let x1 = Math.max(...arms.map((r) => r.x + r.w));
  let y1 = Math.max(...arms.map((r) => r.y + r.h));
  let sx = 0;
  let sy = 0;
  if (x0 <= WALL_SNAP_TOLERANCE) sx = -x0;
  else if (1 - x1 <= WALL_SNAP_TOLERANCE) sx = 1 - x1;
  if (y0 <= WALL_SNAP_TOLERANCE) sy = -y0;
  else if (1 - y1 <= WALL_SNAP_TOLERANCE) sy = 1 - y1;
  x0 += sx; x1 += sx; y0 += sy; y1 += sy;
  if (x0 < 0) sx -= x0;
  if (x1 > 1) sx -= x1 - 1;
  if (y0 < 0) sy -= y0;
  if (y1 > 1) sy -= y1 - 1;
  const [long, short] = arms.map((r) => ({
    ...r,
    x: clamp01(round4(r.x + sx)),
    y: clamp01(round4(r.y + sy)),
  }));
  return { ...placement, long, short };
}

/** Resizes a block toward a normalised pointer position on one of its resize
 * handles. `handle` selects which dimension follows the pointer:
 *   - "length" (default): rect length, or the long arm for L/curved. Depth
 *     stays fixed. Back edge (and, for arms, the bend) stays put.
 *   - "short": the short arm for L/curved only. Depth stays fixed.
 *   - "depth": rect depth only. Length stays fixed.
 * Returns the new placement and, for "length", the new length in feet as
 * `widthFt` (null for "short"/"depth", which never change width_ft). */
export function resizePlacement(shape, placement, nx, ny, feet, snapFt, handle = "length") {
  const px = nx * feet.wFt;
  const py = ny * feet.hFt;

  if (ARM_SHAPES.has(shape)) {
    const p = armParams(placement, feet);
    const { sx, sy } = cornerSigns(p.corner);
    const resizingLong = handle !== "short";
    // the long arm runs along p.longAxis; the short arm runs along the other axis
    const alongX = resizingLong ? p.longAxis === "x" : p.longAxis !== "x";
    const reach = alongX ? (px - p.bx) * sx : (py - p.by) * sy;
    const room = alongX ? (sx > 0 ? feet.wFt - p.bx : p.bx) : sy > 0 ? feet.hFt - p.by : p.by;
    const minLen = p.depthFt + MIN_BLOCK_FT;
    const len = Math.max(minLen, Math.min(snapTo(reach, snapFt), room));
    const q = resizingLong ? { ...p, longFt: len } : { ...p, shortFt: len };
    return { placement: armsFromParams(clampArmParams(q, feet), feet), widthFt: resizingLong ? len : null };
  }

  const f = rectToFeet(placement, feet);
  if (shape === "round") {
    const diameter = Math.min(snapTo(2 * Math.hypot(px - f.cx, py - f.cy), snapFt), feet.wFt, feet.hFt);
    return { placement: rectFromFeet({ ...f, lengthFt: diameter, depthFt: diameter }, feet), widthFt: diameter };
  }

  if (handle === "depth") {
    const r = placement.rotation;
    const alongXd = r % 180 === 0;
    let d;
    if (r === 0) d = py - placement.y * feet.hFt;
    else if (r === 180) d = (placement.y + placement.h) * feet.hFt - py;
    else if (r === 90) d = px - placement.x * feet.wFt;
    else d = (placement.x + placement.w) * feet.wFt - px;
    const maxD = alongXd ? feet.hFt : feet.wFt;
    const depthFt = Math.min(Math.max(MIN_BLOCK_FT, Math.round(d / snapFt) * snapFt), maxD);
    let rect;
    if (alongXd) {
      const hN = depthFt / feet.hFt;
      const y = r === 0 ? placement.y : placement.y + placement.h - hN; // back edge stays put
      rect = { ...placement, y, h: hN };
    } else {
      const wN = depthFt / feet.wFt;
      const x = r === 90 ? placement.x : placement.x + placement.w - wN; // back edge stays put
      rect = { ...placement, x, w: wN };
    }
    return {
      placement: clampRectToRoom({ ...rect, x: round4(rect.x), y: round4(rect.y), w: round4(rect.w), h: round4(rect.h) }),
      widthFt: null,
    };
  }

  const alongX = f.rotation % 180 === 0;
  const start = alongX ? placement.x * feet.wFt : placement.y * feet.hFt;
  const pointer = alongX ? px : py;
  const lengthFt = Math.min(snapTo(pointer - start, snapFt), (alongX ? feet.wFt : feet.hFt) - start);
  const depthFt = f.depthFt;
  const wF = alongX ? lengthFt : depthFt;
  const hF = alongX ? depthFt : lengthFt;
  let x0;
  let y0;
  if (alongX) {
    x0 = start;
    // keep the back edge where it was: top for rotation 0, bottom for 180
    y0 = f.rotation === 0 ? placement.y * feet.hFt : (placement.y + placement.h) * feet.hFt - hF;
  } else {
    y0 = start;
    // left for rotation 90, right for 270
    x0 = f.rotation === 90 ? placement.x * feet.wFt : (placement.x + placement.w) * feet.wFt - wF;
  }
  const rect = clampRectToRoom({
    x: round4(x0 / feet.wFt),
    y: round4(y0 / feet.hFt),
    w: round4(wF / feet.wFt),
    h: round4(hF / feet.hFt),
    rotation: f.rotation,
  });
  return { placement: rect, widthFt: lengthFt };
}

/** The rects a block occupies, for overlap testing. */
export function placementRects(shape, placement) {
  return ARM_SHAPES.has(shape) ? [placement.long, placement.short] : [placement];
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** A thin rect representing a wall-feature's footprint, for overlap testing
 * against blocks — a shallow band just inside the wall it's on. */
export function featureFootprint(wall, span) {
  const THICK = 0.05;
  const [start, end] = span;
  if (wall === "far") return { x: start, y: 0, w: end - start, h: THICK };
  if (wall === "near") return { x: start, y: 1 - THICK, w: end - start, h: THICK };
  if (wall === "left") return { x: 0, y: start, w: THICK, h: end - start };
  return { x: 1 - THICK, y: start, w: THICK, h: end - start }; // "right"
}

// ---------------------------------------------------------------------------
// 2D figure geometry (drawing only). Every sofa/chair figure is built in ONE
// local frame — u along the length, v along the depth, the BACK at v = 0 —
// and placed on the plan with ONE affine matrix, so no part can end up on the
// wrong side after Rotate/Flip. Matrices are SVG-style [a, b, c, d, e, f]:
//   x' = a*u + c*v + e,   y' = b*u + d*v + f
// ---------------------------------------------------------------------------

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function frameApply(m, u, v) {
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
}

export function frameCss(m) {
  return `matrix(${m.join(" ")})`;
}

/** Screen size of a local w x h box under frame `m` (axes swap on 90/270). */
export function frameSize(m, w, h) {
  return m[0] === 0 ? [h, w] : [w, h];
}

/** Local -> plan matrix for a straight piece (rect) of length L, depth D
 * whose bounding box top-left is (X, Y); `rotation` names the wall the back
 * faces (0 far, 90 left, 180 near, 270 right). */
export function rectFrame(X, Y, L, D, rotation) {
  if (rotation === 90) return [0, -1, 1, 0, X, Y + L];
  if (rotation === 180) return [-1, 0, 0, -1, X + L, Y + D];
  if (rotation === 270) return [0, 1, -1, 0, X + D, Y];
  return [1, 0, 0, 1, X, Y];
}

/** Local -> plan matrix for an L/curved block from armParams (any units).
 * Local origin = the outer bend corner, u runs along the LONG arm, v runs
 * along the short arm; the back is the outer edge of the long arm (v = 0). */
export function armFrame(p) {
  const { sx, sy } = cornerSigns(p.corner);
  return p.longAxis === "x" ? [sx, 0, 0, sy, p.bx, p.by] : [0, sy, sx, 0, p.bx, p.by];
}

export function figureMetrics(L, D) {
  return { t: clampNum(L * 0.08, 5, 11), bt: clampNum(D * 0.26, 5, 11), g: 2 };
}

function pillRow(u0, u1, bt, n) {
  const gap = 2;
  const w = Math.max((u1 - u0 - gap * (n - 1)) / n, 1);
  return Array.from({ length: n }, (_, i) => ({ u0: u0 + i * (w + gap), v0: 0, u1: u0 + i * (w + gap) + w, v1: bt }));
}

/** Straight sofa (n seats) or chair (n = 1): back pills along the back,
 * a hand-rest at both ends across the full depth, one seat. */
export function straightFigure(L, D, n) {
  const { t, bt, g } = figureMetrics(L, D);
  const u0 = t + g;
  const u1 = L - t - g;
  const seat = { u0, v0: bt + g, u1, v1: D - 1 };
  return {
    handRests: [{ u0: 0, v0: 0, u1: t, v1: D }, { u0: L - t, v0: 0, u1: L, v1: D }],
    backPills: pillRow(u0, u1, bt, n),
    seatPoints: [[seat.u0, seat.v0], [seat.u1, seat.v0], [seat.u1, seat.v1], [seat.u0, seat.v1]],
    seatRadii: [6, 6, 6, 6],
    label: seat,
  };
}

/** L-shape: long arm Lf x d with the back along its full outer side, plus a
 * lounge (short arm) at the u = 0 end running to S. The lounge has no back;
 * ONE hand-rest sits outside it at the lounge end; the other end is open. */
export function lFigure(Lf, S, d) {
  const { t, bt, g } = figureMetrics(Lf, d);
  const Sx = Math.max(S, d + 1);
  const span = Lf - t - g;
  const n = Math.max(2, Math.round(span / Math.max(d * 0.95, 1)));
  return {
    lounge: { u0: 0, v0: 0, u1: d, v1: Sx },
    handRests: [{ u0: 0, v0: 0, u1: t, v1: Sx }],
    backPills: pillRow(t + g, Lf, bt, n),
    seatPoints: [[t + g, bt + g], [Lf - 1, bt + g], [Lf - 1, d - 1], [d - 1, d - 1], [d - 1, Sx - 1], [t + g, Sx - 1]],
    seatRadii: [6, 6, 6, 2, 6, 6],
    labelLong: { u0: d, v0: bt + g, u1: Lf - 1, v1: d - 1 },
    labelLounge: { u0: t + g, v0: d, u1: d - 1, v1: Sx - 1 },
  };
}

/** Corner sofa: a square corner with a backrest along BOTH outer arms (v = 0
 * and u = 0), a hand-rest at each far end, and one L-shaped seat. */
export function cornerFigure(Lf, S, d) {
  const { t, bt, g } = figureMetrics(Lf, d);
  const Sx = Math.max(S, d + 1);
  const seatEndU = Lf - t - g;
  const seatEndV = Sx - t - g;
  const nLong = Math.max(1, Math.round((seatEndU - (bt + g)) / Math.max(d * 0.95, 1)));
  const nShort = Math.max(1, Math.round((seatEndV - (bt + g)) / Math.max(d * 0.95, 1)));
  const wLong = Math.max((seatEndU - (bt + g) - 2 * (nLong - 1)) / nLong, 1);
  const wShort = Math.max((seatEndV - (bt + g) - 2 * (nShort - 1)) / nShort, 1);
  const backPills = [{ u0: 0, v0: 0, u1: bt, v1: bt }];
  for (let i = 0; i < nLong; i += 1) {
    const u0 = bt + g + i * (wLong + 2);
    backPills.push({ u0, v0: 0, u1: u0 + wLong, v1: bt });
  }
  for (let i = 0; i < nShort; i += 1) {
    const v0 = bt + g + i * (wShort + 2);
    backPills.push({ u0: 0, v0, u1: bt, v1: v0 + wShort });
  }
  return {
    handRests: [{ u0: Lf - t, v0: 0, u1: Lf, v1: d }, { u0: 0, v0: Sx - t, u1: d, v1: Sx }],
    backPills,
    seatPoints: [[bt + g, bt + g], [seatEndU, bt + g], [seatEndU, d - 1], [d - 1, d - 1], [d - 1, seatEndV], [bt + g, seatEndV]],
    seatRadii: [6, 6, 6, 2, 6, 6],
    label: { u0: bt + g, v0: bt + g, u1: seatEndU, v1: d - 1 },
  };
}

/** Curved sofa: quarter-annulus around centre (Lf, S) in the local frame.
 * The back is a thick round-capped dashed stroke along the outer arc, one
 * seat band, a hand-rest at each end. */
export function curvedFigure(Lf, S, d) {
  const { bt, g } = figureMetrics(Lf, d);
  const rx = Math.max(Lf, d + 2);
  const ry = Math.max(S, d + 2);
  const ht = clampNum(d * 0.22, 5, 11);
  const pt = (ex, ey, a) => [Lf - ex * Math.cos(a), S - ey * Math.sin(a)];
  const mid = (rx - (bt + d) / 2 + (ry - (bt + d) / 2)) / 2;
  let a0 = Math.asin(clampNum((ht + g) / Math.max(ry - (bt + d) / 2, 1), 0, 0.95));
  let a1 = Math.acos(clampNum((ht + g) / Math.max(rx - (bt + d) / 2, 1), 0, 0.95));
  if (a1 - a0 < 0.3) {
    a0 = 0.15;
    a1 = Math.PI / 2 - 0.15;
  }
  // back: dashed round-capped stroke on the outer arc's centre line
  const bx = rx - bt / 2;
  const by = ry - bt / 2;
  const b0 = pt(bx, by, a0);
  const b1 = pt(bx, by, a1);
  let arcLen = 0;
  let prev = b0;
  for (let i = 1; i <= 24; i += 1) {
    const cur = pt(bx, by, a0 + ((a1 - a0) * i) / 24);
    arcLen += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    prev = cur;
  }
  const n = Math.max(2, Math.round(arcLen / Math.max(d * 0.95, 1)));
  const pitch = arcLen / n;
  const back = {
    d: `M ${b0[0]} ${b0[1]} A ${bx} ${by} 0 0 1 ${b1[0]} ${b1[1]}`,
    width: bt,
    dash: Math.max(pitch - 2 - bt, 0.1),
    gap: bt + 2,
    offset: -bt / 2,
  };
  // seat band: an inset annular sector; FloorPlan rounds it by stroking it
  const r = clampNum((d - bt - g) / 4, 1.5, 4);
  const sox = Math.max(rx - bt - g - r, 1);
  const soy = Math.max(ry - bt - g - r, 1);
  const six = Math.max(rx - d + r, 1);
  const siy = Math.max(ry - d + r, 1);
  const da = r / Math.max(mid, 1);
  const s0 = a0 + da;
  const s1 = a1 - da;
  const p0 = pt(sox, soy, s0);
  const p1 = pt(sox, soy, s1);
  const q1 = pt(six, siy, s1);
  const q0 = pt(six, siy, s0);
  const c = pt((sox + six) / 2, (soy + siy) / 2, (s0 + s1) / 2);
  const band = Math.max(Math.min(sox - six, soy - siy), 1);
  return {
    back,
    seat: {
      d: `M ${p0[0]} ${p0[1]} A ${sox} ${soy} 0 0 1 ${p1[0]} ${p1[1]} L ${q1[0]} ${q1[1]} A ${six} ${siy} 0 0 0 ${q0[0]} ${q0[1]} Z`,
      r,
    },
    handRests: [{ u0: 0, v0: S - ht, u1: d, v1: S }, { u0: Lf - ht, v0: 0, u1: Lf, v1: d }],
    label: { u: c[0], v: c[1], w: band, h: band },
  };
}

export function sofaName(n) {
  return n === 1 ? "1 SEAT" : `${n} SEATER`;
}

/** Lines to print a seat name on: one line normally, two ("2" / "SEATER")
 * when the seat is narrower than the text and taller than wide. Text is
 * never rotated. */
export function nameLines(text, w, h) {
  const space = text.indexOf(" ");
  if (space < 0 || text.length * 7.4 <= w || h <= w) return [text];
  return [text.slice(0, space), text.slice(space + 1)];
}

/** Whole quarter-turns (0-3) a drag has turned a piece: the pointer's angle
 * about the piece centre now vs at pointer-down, in 90-degree steps. */
export function rotateSteps(angleNow, angleStart) {
  const steps = Math.round((angleNow - angleStart) / (Math.PI / 2));
  return ((steps % 4) + 4) % 4;
}

/** Applies rotatePlacement `steps` times to the ORIGINAL placement. */
export function rotateBy(shape, placement, feet, steps) {
  let result = placement;
  for (let i = 0; i < steps; i += 1) result = rotatePlacement(shape, result, feet);
  return result;
}
