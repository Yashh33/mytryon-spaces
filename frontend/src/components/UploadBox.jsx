import { useEffect, useId, useMemo, useState } from "react";
import { IMAGE_ACCEPT, debugLog, normalizeToJpeg } from "../utils.js";

export function UploadBox({ file, existingUrl, onChange, required = false, label = "Add a photo", hint = "Tap to take a photo or choose one" }) {
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
    <div className="upload-field">
      <label
        htmlFor={inputId}
        className={"upload-box" + (previewUrl ? " has-image" : " is-empty")}
        style={{ display: "block", pointerEvents: busy ? "none" : undefined }}
        onClick={() => debugLog("input clicked")}
      >
        {busy ? (
          <div className="upload-empty">Preparing photo…</div>
        ) : previewUrl ? (
          <>
            <img src={previewUrl} alt="" />
            <div className="upload-change">Change photo</div>
          </>
        ) : (
          <div className="upload-empty">
            <span className="upload-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
                <circle cx="12" cy="13.5" r="3.5" />
              </svg>
            </span>
            <span className="upload-label">{label}</span>
            <span className="upload-hint">{hint}</span>
          </div>
        )}
        {required && !previewUrl && !busy ? <span className="upload-required">Required</span> : null}
        {error && !busy ? <div style={{ padding: "0 10px 10px", color: "#c0392b", fontWeight: 600 }}>{error}</div> : null}
      </label>
      <input
        id={inputId}
        type="file"
        accept={IMAGE_ACCEPT}
        className="visually-hidden"
        aria-required={required || undefined}
        onClick={(e) => e.stopPropagation()}
        onChange={handleFile}
      />
    </div>
  );
}
