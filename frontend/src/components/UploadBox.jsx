import { useEffect, useId, useMemo, useState } from "react";
import { IMAGE_ACCEPT, downscaleImage } from "../utils.js";

const HIDDEN_INPUT_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  opacity: 0,
  overflow: "hidden",
  pointerEvents: "none",
};

export function UploadBox({ file, existingUrl, onChange }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);

  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const previewUrl = objectUrl || existingUrl;

  async function handleFile(e) {
    const picked = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!picked || busy) return;
    setBusy(true);
    try {
      onChange(await downscaleImage(picked));
    } catch {
      // Let the server convert the original if downscaling fails.
      onChange(picked);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <label
        htmlFor={inputId}
        className={"upload-box" + (previewUrl ? " has-image" : "")}
        style={{ display: "block", pointerEvents: busy ? "none" : undefined }}
      >
        {busy ? (
          <div style={{ padding: 10 }}>Preparing photo…</div>
        ) : previewUrl ? (
          <>
            <img src={previewUrl} alt="" />
            <div className="upload-change">Change photo</div>
          </>
        ) : (
          <div style={{ padding: 10 }}>Tap to add a photo</div>
        )}
      </label>
      <input
        id={inputId}
        type="file"
        accept={IMAGE_ACCEPT}
        style={HIDDEN_INPUT_STYLE}
        onClick={(e) => e.stopPropagation()}
        onChange={handleFile}
      />
    </>
  );
}
