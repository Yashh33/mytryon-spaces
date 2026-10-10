// Turns the on-screen floor plan <svg> into a PNG for the placement writer.
// The plan is styled by the app's stylesheet, which a standalone image can't
// see, so every element's computed look is written onto a copy first.

const STYLE_PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "letter-spacing",
  "text-anchor", "dominant-baseline", "paint-order", "display", "visibility",
];

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("plan image failed to render"));
    img.src = src;
  });
}

/** PNG blob of the plan exactly as it looks with nothing selected — walls
 * and their names, camera, feature labels, furniture with numbers and part
 * names — about `longSide` px on its longer side. Anything marked
 * data-noexport (selection outline, resize and rotate handles) is left out,
 * and a piece dimmed while another is being placed is drawn at full strength. */
export async function exportPlanPng(svg, longSide = 1000) {
  const clone = svg.cloneNode(true);
  const originals = [svg, ...svg.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  originals.forEach((el, i) => {
    const computed = getComputedStyle(el);
    copies[i].setAttribute("style", STYLE_PROPS.map((p) => `${p}:${computed.getPropertyValue(p)}`).join(";"));
    if (el.classList.contains("fp-block")) {
      copies[i].removeAttribute("opacity");
      copies[i].style.opacity = "1";
    }
    copies[i].removeAttribute("class");
  });
  clone.querySelectorAll("[data-noexport]").forEach((node) => node.remove());

  const { width: vbW, height: vbH } = svg.viewBox.baseVal;
  const scale = longSide / Math.max(vbW, vbH);
  const width = Math.round(vbW * scale);
  const height = Math.round(vbH * scale);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  clone.removeAttribute("style");

  const xml = new XMLSerializer().serializeToString(clone);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("plan image failed to encode");
  return blob;
}
