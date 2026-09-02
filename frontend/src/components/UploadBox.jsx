import { useEffect, useMemo, useRef } from "react";
import { downscaleImage } from "../utils.js";

export function UploadBox({ file, existingUrl, onChange }) {
  const inputRef = useRef(null);
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
    if (!picked) return;
    const downscaled = await downscaleImage(picked);
    onChange(downscaled);
  }

  return (
    <div className={"upload-box" + (previewUrl ? " has-image" : "")} onClick={() => inputRef.current.click()}>
      {previewUrl ? (
        <>
          <img src={previewUrl} alt="" />
          <div className="upload-change">Change photo</div>
        </>
      ) : (
        <div style={{ padding: 10 }}>Tap to add a photo</div>
      )}
      <input ref={inputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleFile} />
    </div>
  );
}
