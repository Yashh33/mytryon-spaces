import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Loading, ErrorBlock } from "../components/StateBlock.jsx";
import { TopBar } from "../components/TopBar.jsx";
import { StepBar } from "../components/StepBar.jsx";
import { StepFooter } from "../components/StepFooter.jsx";
import { useAdjustMode } from "../adjustMode.js";

/** After the furniture: floor plan (the usual flow) or drawing on the photo.
 * Only reached when the shop has "shape_placement" on; otherwise Furniture
 * goes straight to the floor plan. */
export default function PlacementChoice() {
  const { id } = useParams();
  const adjust = useAdjustMode(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [attempt, setAttempt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  async function load() {
    setError(null);
    try {
      setAttempt((await api.get(`/api/attempts/${id}`)).attempt);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function choose(mode) {
    setBusy(mode);
    try {
      await api.put(`/api/attempts/${id}/placement-mode`, { json: { mode } });
      const step = mode === "shapes" ? "draw" : "place";
      navigate(`/attempt/${id}/${step}${adjust.query ? `?${adjust.query}` : ""}`);
    } catch (err) {
      toast(err.message);
      setBusy(null);
    }
  }

  if (!attempt && !error) return <div className="screen"><Loading /></div>;
  if (error) return <div className="screen"><ErrorBlock message={error} onRetry={load} /></div>;

  const current = attempt.placement_mode;
  return (
    <div className="screen screen-narrow has-step-footer">
      <TopBar
        backTo={adjust.backTo || `/attempt/${id}/furniture`}
        crumbs={[
          { label: attempt.room.customer_name, to: `/customer/${attempt.room.customer_id}` },
          { label: attempt.room.room_type, to: `/room/${attempt.room.id}` },
          { label: "Attempt" },
        ]}
      />
      <div className="eyebrow">Step 3 of 4</div>
      <StepBar current={3} attemptId={attempt.id} roomId={attempt.room.id} query={adjust.query} placementMode={current} />
      <h1 style={{ marginBottom: 18 }}>How do you want to place the furniture?</h1>
      <div className="choice-list">
        <button type="button" className={"choice-card" + (current === "plan" ? " current" : "")} disabled={Boolean(busy)} onClick={() => choose("plan")}>
          <span className="choice-title">Floor plan</span>
          <span className="choice-sub">Place blocks on a plan of the room.</span>
        </button>
        <button type="button" className={"choice-card" + (current === "shapes" ? " current" : "")} disabled={Boolean(busy)} onClick={() => choose("shapes")}>
          <span className="choice-title">
            Draw on photo <span className="beta-tag">Beta</span>
          </span>
          <span className="choice-sub">Draw each piece straight onto the room photo.</span>
        </button>
      </div>
      <StepFooter backTo={adjust.backTo || `/attempt/${id}/furniture`} status={busy ? "Opening…" : "Choose one to continue"} />
    </div>
  );
}
