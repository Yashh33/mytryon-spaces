// Pure geometry/data helpers for the floor-plan placement screen. No React,
// no DOM — kept separate from FloorPlan.jsx / Place.jsx so the placement
// math is easy to reason about and test in isolation.

export const PALETTE = ["#F07522", "#2563EB", "#16A34A", "#9333EA"];

export const ROOM_ASPECT = {
  "deeper than wide": [3, 4],
  "about square": [1, 1],
  "wider than deep": [4, 3],
};

// No real-world room dimensions exist anywhere in this data model (the
// vision layout is qualitative only). This is a deliberate, documented
// approximation purely for sizing blocks on the plan — it never leaves
// the browser and is never sent to the backend.
export const ASSUMED_ROOM_LONGEST_FT = 18;
export const BLOCK_DEPTH_RATIO = 0.35; // depth as a fraction of length, fixed per the spec
export const WALL_SNAP_TOLERANCE = 0.04;
export const WALL_TOLERANCE = 0.06; // matches the backend resolver's "against a wall" threshold

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
export const GAP_TYPES = new Set(["door", "doorway", "opening", "balcony door", "glazed opening"]);
export const DASHED_GAP_TYPES = new Set(["glazed opening", "balcony door"]);
export const ARC_TYPES = new Set(["door", "doorway"]);
export const BAND_TYPES = new Set(["recess"]);
export const POINT_TYPES = new Set(["pillar", "column"]);

// Feature types a salesman can add via "Add feature" (obstructions —
// pillar/column — are added separately, via "Add obstruction").
export const ADDABLE_FEATURE_TYPES = [
  "window", "door", "doorway", "opening", "balcony door", "glazed opening", "recess", "step", "other",
];

// Whether a feature type physically blocks furniture from standing in
// front of it. Only meaningful for salesman-added features — vision-
// generated ones never carry this flag (the backend that produces them is
// unchanged), so they're simply never flagged as an overlap risk.
export function defaultBlocksFurniture(type) {
  return ["door", "doorway", "opening", "balcony door", "glazed opening", "step"].includes(type);
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

/** Parses "3+2" into [{label:"3-seater", seats:3}, {label:"2-seater", seats:2}]. */
export function multiPieceSegments(type) {
  const parts = String(type)
    .split("+")
    .map((p) => parseInt(p, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (parts.length < 2) return null;
  return parts.map((seats) => ({ label: `${seats}-seater`, seats }));
}

export function isMultiPieceSofa(item) {
  return item.category === "Sofa" && multiPieceSegments(item.type) != null;
}

/** Builds the flat list of placeable "blocks" from an attempt's items — one
 * block per item, except multi-piece sofas (3+2, 3+3, ...) which split into
 * one block per sub-piece. Only subIndex 0 of a split item is backed by the
 * server (item.placement); further sub-pieces have no server-side slot
 * (the backend stores exactly one placement per item), so their position is
 * kept in localStorage — see placementStorage below. */
export function itemsToBlocks(items) {
  const blocks = [];
  let colorIndex = 0;
  items.forEach((item) => {
    const segments = isMultiPieceSofa(item) ? multiPieceSegments(item.type) : null;
    if (segments) {
      const mainSeats = Math.max(...segments.map((s) => s.seats));
      const perSeatWidth = item.width_ft / mainSeats;
      segments.forEach((seg, subIndex) => {
        blocks.push({
          key: `${item.id}-${subIndex}`,
          itemId: item.id,
          subIndex,
          persisted: subIndex === 0,
          label: `${item.category} — ${seg.label}`,
          shape: "rect",
          widthFt: round4(perSeatWidth * seg.seats),
          placement: subIndex === 0 ? item.placement : null,
          color: PALETTE[colorIndex % PALETTE.length],
          number: colorIndex + 1,
        });
        colorIndex += 1;
      });
    } else {
      blocks.push({
        key: `${item.id}-0`,
        itemId: item.id,
        subIndex: 0,
        persisted: true,
        label: `${item.category} (${item.type})`,
        shape: item.shape,
        widthFt: item.width_ft,
        placement: item.placement,
        color: PALETTE[colorIndex % PALETTE.length],
        number: colorIndex + 1,
      });
      colorIndex += 1;
    }
  });
  return blocks;
}

/** localStorage-backed placement for sub-pieces beyond the first (see
 * itemsToBlocks) — there's no server slot for them this pass. */
const SUBPLACEMENT_PREFIX = "mytryon_subplacement_";

export function loadSubPlacement(attemptId, itemId, subIndex) {
  try {
    const raw = window.localStorage.getItem(`${SUBPLACEMENT_PREFIX}${attemptId}_${itemId}_${subIndex}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSubPlacement(attemptId, itemId, subIndex, placement) {
  try {
    window.localStorage.setItem(`${SUBPLACEMENT_PREFIX}${attemptId}_${itemId}_${subIndex}`, JSON.stringify(placement));
  } catch {
    // ignore — purely a nice-to-have, never blocks the real save
  }
}

export function clearSubPlacement(attemptId, itemId, subIndex) {
  try {
    window.localStorage.removeItem(`${SUBPLACEMENT_PREFIX}${attemptId}_${itemId}_${subIndex}`);
  } catch {
    // ignore
  }
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
