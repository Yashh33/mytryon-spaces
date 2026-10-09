const MAX_UPLOAD_DIMENSION = 1600;
const TARGET_BYTES = 600 * 1024;
const QUALITIES = [0.82, 0.75, 0.68, 0.6];
const READ_ERROR = "Couldn't read this photo. Try another photo or take a screenshot of it.";

export const IMAGE_ACCEPT = "image/*";

// ---- ?debug=1 on-screen log -------------------------------------------------
const debugLines = [];
const debugSubscribers = new Set();

export function isDebug() {
  return typeof window !== "undefined" && window.location.search.includes("debug=1");
}

export function getDebugLines() {
  return debugLines;
}

export function clearDebug() {
  debugLines.length = 0;
  debugSubscribers.forEach((fn) => fn());
}

export function subscribeDebug(fn) {
  debugSubscribers.add(fn);
  return () => debugSubscribers.delete(fn);
}

export function debugLog(msg) {
  if (!isDebug()) return;
  const stamp = new Date().toTimeString().slice(0, 8);
  debugLines.push(`${stamp} ${msg}`);
  if (debugLines.length > 50) debugLines.shift();
  debugSubscribers.forEach((fn) => fn());
}

// ---- image normalisation ----------------------------------------------------
function isHeic(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "image/heic" || type === "image/heif" || name.endsWith(".heic") || name.endsWith(".heif") || !type;
}

async function decodeViaBitmap(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close && bitmap.close() };
}

async function decodeViaImg(blob) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("img decode failed"));
      img.src = url;
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

async function tryDecode(blob) {
  try {
    const d = await decodeViaBitmap(blob);
    return { decoded: d, via: "bitmap" };
  } catch {
    // fall through
  }
  try {
    const d = await decodeViaImg(blob);
    return { decoded: d, via: "img" };
  } catch {
    return null;
  }
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/** Always returns a NEW image/jpeg File (longest edge <= 1600px, ~600 KB) or
 * throws — it never hands back the original file. iPhone HEIC is decoded by
 * the browser when it can, otherwise converted with heic2any (lazy chunk). */
export async function normalizeToJpeg(file) {
  debugLog(`onChange fired ${file.name} ${file.type || "no type"} ${Math.round(file.size / 1024)}KB`);
  let result = await tryDecode(file);
  if (!result && isHeic(file)) {
    try {
      const { default: heic2any } = await import("heic2any");
      let converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
      if (Array.isArray(converted)) converted = converted[0];
      result = await tryDecode(converted);
      if (result) result.via = "heic2any";
    } catch {
      result = null;
    }
  }
  if (!result) {
    debugLog("decode FAIL");
    throw new Error(READ_ERROR);
  }
  debugLog(`decode OK via ${result.via}`);

  const { decoded } = result;
  try {
    const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    canvas.getContext("2d").drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

    let blob = null;
    let used = QUALITIES[0];
    for (const q of QUALITIES) {
      blob = await canvasToBlob(canvas, q);
      used = q;
      if (!blob) break;
      if (blob.size <= TARGET_BYTES) break;
    }
    if (!blob) {
      debugLog("decode FAIL");
      throw new Error(READ_ERROR);
    }
    debugLog(`compressed ${Math.round(blob.size / 1024)}KB at q${used}`);
    const name = (file.name || "photo").replace(/\.[^.]*$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } finally {
    decoded.release();
  }
}

export const downscaleImage = normalizeToJpeg;

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function formatShortDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }).toUpperCase();
}

export function initials(name) {
  return (name || "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

export function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

/** Appends non-empty params as a query string, e.g. withQuery("/api/x", { shop_id: "3" }) -> "/api/x?shop_id=3". */
export function withQuery(path, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}
