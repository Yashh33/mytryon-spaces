const MAX_UPLOAD_DIMENSION = 2560; // longest side of the JPEG sent; never enlarged
const JPEG_QUALITY = 0.9;

// every photo input: a narrow list (".jpg,.png") makes iOS misbehave
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

/** The photo to upload: the chosen file loaded by the browser (Safari on an
 * iPhone reads HEIC this way), turned upright from its EXIF orientation,
 * shrunk so its longest side is at most 2560 px (never enlarged) and saved
 * as a .jpg at quality 0.9. If the browser can't read the file at all, the
 * original file comes back unchanged: the server reads HEIC/HEIF itself.
 * Never throws. */
export async function normalizeToJpeg(file) {
  debugLog(`onChange fired ${file.name} ${file.type || "no type"} ${Math.round(file.size / 1024)}KB`);
  const result = await tryDecode(file);
  if (!result) {
    debugLog("decode FAIL: sending the original file");
    return file;
  }
  debugLog(`decode OK via ${result.via} ${result.decoded.width}x${result.decoded.height}`);

  const { decoded } = result;
  try {
    const scale = Math.min(1, MAX_UPLOAD_DIMENSION / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    canvas.getContext("2d").drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, JPEG_QUALITY);
    if (!blob) {
      debugLog("encode FAIL: sending the original file");
      return file;
    }
    debugLog(`jpeg ${canvas.width}x${canvas.height} ${Math.round(blob.size / 1024)}KB`);
    const name = (file.name || "photo").replace(/\.[^.]*$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    debugLog("canvas FAIL: sending the original file");
    return file;
  } finally {
    decoded.release();
  }
}

// errors that mean the photo itself was refused or never arrived
const PHOTO_ERRORS = new Set(["invalid_type", "empty_upload", "too_large", "heic_conversion_failed", "unreadable_image", "network_error"]);

/** The message to show when a request that sent a photo failed: the
 * server's own words, saying the photo didn't upload when that is what
 * went wrong (other failures, e.g. not enough credits, are shown as they are). */
export function photoUploadError(err) {
  const message = err?.message || "Something went wrong.";
  if (PHOTO_ERRORS.has(err?.error) || err?.status === 413) return `The photo didn't upload: ${message}`;
  return message;
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

const ROOM_LOOK_LABELS = { keep: "KEEP ROOM", warm: "AESTHETIC WARM", luxury: "LUXURY", minimal: "MINIMAL" };

export function roomLookLabel(value) {
  return ROOM_LOOK_LABELS[value] || (value || "").toUpperCase();
}
