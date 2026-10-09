import { useEffect, useId, useMemo, useState } from "react";
import { IMAGE_ACCEPT, debugLog, normalizeToJpeg } from "../utils.js";

export function UploadBox({ file, existingUrl, onChange }) {
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
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
    setError(null);
    setBusy(true);
    try {
      onChange(await normalizeToJpeg(picked));
    } catch (err) {
      setError(err.message);
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
        onClick={() => debugLog("input clicked")}
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
        {error && !busy ? <div style={{ padding: "0 10px 10px", color: "#c0392b", fontWeight: 600 }}>{error}</div> : null}
      </label>
      <input
        id={inputId}
        type="file"
        accept={IMAGE_ACCEPT}
        className="visually-hidden"
        onClick={(e) => e.stopPropagation()}
        onChange={handleFile}
      />
    </>
  );
}
