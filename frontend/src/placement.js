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
        shape: sp.shape,
        widthFt: sp.width_ft,
        placement: placedBySubIndex.get(sp.sub_index) || null,
        color: PALETTE[colorIndex % PALETTE.length],
        number: colorIndex + 1,
      });
      colorIndex += 1;
    });
  });
  return blocks;
}

/** A block's default length (normalised 0-1) scaled from its width in feet
 * against an assumed room size — see ASSUMED_ROOM_LONGEST_FT. */
export function defaultRectFor(widthFt) {
  const length = clamp01(widthFt / ASSUMED_ROOM_LONGEST_FT);
  const depth = length * BLOCK_DEPTH_RATIO;
  return { x: round4(0.5 - length / 2), y: round4(0.5 - depth / 2), w: round4(length), h: round4(depth), rotation: 0 };
}

export function defaultLFor(widthFt) {
  const long = defaultRectFor(widthFt);
  // Anchored near a corner (not the room's centre) since an L-piece is
  // meant to sit in one — both arms share the same starting corner point.
  const anchored = { ...long, x: 0.05, y: 0.05 };
  const shortLen = anchored.w * 0.55;
  const shortDepth = anchored.h;
  return {
    long: anchored,
    short: { x: anchored.x, y: anchored.y, w: round4(shortDepth), h: round4(shortLen), rotation: 90 },
    corner: "far-left",
  };
}

/** Rotates an L block 90 degrees: both arms turn together (swapping their
 * own w/h and stepping their own rotation), staying anchored at the same
 * shared corner point, and the corner name steps through the same cycle. */
const CORNER_CYCLE = { "far-left": "far-right", "far-right": "near-right", "near-right": "near-left", "near-left": "far-left" };

export function rotateLPlacement(placement) {
  const { long, short, corner } = placement;
  return {
    long: clampRectToRoom({ ...long, w: long.h, h: long.w, rotation: nextRotation(long.rotation) }),
    short: clampRectToRoom({ ...short, w: short.h, h: short.w, rotation: nextRotation(short.rotation) }),
    corner: CORNER_CYCLE[corner] || corner,
  };
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

/** Rotates 0->90->180->270->0. */
export function nextRotation(rotation) {
  return (rotation + 90) % 360;
}

/** Which wall a rect's rotation-implied back edge is against, if within
 * WALL_TOLERANCE — mirrors the backend resolver so what the salesman sees
 * matches what the generation prompt will say. */
export function resolveRectWall(rect) {
  const candidate = WALL_FOR_ROTATION[rect.rotation];
  let distance;
  if (candidate === "far") distance = rect.y;
  else if (candidate === "near") distance = 1 - (rect.y + rect.h);
  else if (candidate === "left") distance = rect.x;
  else distance = 1 - (rect.x + rect.w);
  return distance <= WALL_TOLERANCE ? candidate : null;
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

/** Flips which side the short arm of an L attaches to, mirroring both arms
 * across whichever axis the long arm's own wall isn't on, and toggling the
 * matching half of the corner name. */
export function flipLPlacement(placement) {
  const { long, short, corner } = placement;
  const [depthWord, sideWord] = corner.split("-");
  const longWall = WALL_FOR_ROTATION[long.rotation];
  const longIsDepthWall = longWall === "far" || longWall === "near";

  function mirror(rect, axis) {
    return axis === "x"
      ? { ...rect, x: clamp01(round4(1 - rect.x - rect.w)) }
      : { ...rect, y: clamp01(round4(1 - rect.y - rect.h)) };
  }

  const axis = longIsDepthWall ? "x" : "y";
  const newCorner = longIsDepthWall
    ? `${depthWord}-${sideWord === "left" ? "right" : "left"}`
    : `${depthWord === "far" ? "near" : "far"}-${sideWord}`;

  return {
    long: mirror(long, axis),
    short: { ...mirror(short, axis), rotation: (short.rotation + 180) % 360 },
    corner: newCorner,
  };
}

export function facingArrowAngle(rotation) {
  // SVG angle (degrees, clockwise from "up") for an arrow pointing the
  // direction the seats face, matching FACING_FOR_ROTATION in the backend:
  // 0 -> down (toward the camera), 90 -> right, 180 -> up (far wall), 270 -> left.
  return { 0: 180, 90: 90, 180: 0, 270: 270 }[rotation];
}
