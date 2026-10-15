import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { useAdjustMode } from "../adjustMode.js";

/** "Draw on photo" → Preview: the guide image exactly as a render would send
 * it to the image model now (boxes or flat, labels, black lines, grey
 * border), built by the server from the saved shapes — the same code as the
 * render. No AI call, no credits; fetched fresh on every visit, so it
 * always follows the latest shapes. */
export default function GuidePreview() {
  const { id } = useParams();
  const adjust = useAdjustMode(id);
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(null);
  const [imageUrl, setImageUrl] = useState(null);
  const [error, setError] = useState(null);
  const [imageError, setImageError] = useState(null);
  const query = adjust.query ? `?${adjust.query}` : "";
  const drawUrl = `/attempt/${id}/draw${query}`;

  async function load() {
    setError(null);
    setImageError(null);
    try {
      const data = await api.get(`/api/attempts/${id}`);
      setAttempt(data.attempt);
    } catch (err) {
      setError(err.message);
      return;
    }
    try {
      const res = await fetch(`/api/attempts/${id}/guide-preview?t=${Date.now()}`, { credentials: "include", cache: "no-store" });
      if (!res.ok) {
        let message = `The preview couldn't be built (error ${res.status}).`;
        try {
          const body = await res.json();
          if (body?.message) message = body.message;
        } catch {
          // not JSON: keep the status line
        }
        throw new Error(message);
      }
      setImageUrl(URL.createObjectURL(await res.blob())); // the old one is released by the effect below
    } catch (err) {
      setImageError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => () => imageUrl && URL.revokeObjectURL(imageUrl), [imageUrl]);

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  return (
    <div className="screen has-step-footer">
      <TopBar
        backTo={drawUrl}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} placementMode="shapes" />
      <h1 style={{ marginBottom: 4 }}>Preview</h1>
      <div className="hint-line" style={{ marginBottom: 12 }}>This is what the AI will use to place the furniture.</div>

      {imageError ? (
        <ErrorBlock message={imageError} onRetry={load} />
      ) : imageUrl ? (
        <a href={imageUrl} target="_blank" rel="noreferrer" className="guide-preview" title="Open full size">
          <img src={imageUrl} alt="The guide image the AI will get" />
        </a>
      ) : (
        <Loading />
      )}

      <StepFooter
        backTo={drawUrl}
        status={imageUrl ? "Tap the picture to see it full size" : ""}
        primaryLabel="Next"
        primaryDisabled={!imageUrl && !imageError} // a preview that fails never blocks the flow
        onPrimary={() => navigate(`/attempt/${id}/finish${query}`)}
      />
    </div>
  );
}
