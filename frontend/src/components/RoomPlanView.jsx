import { FloorPlan } from "./FloorPlan.jsx";

/** The pending/failed/ready states shared between the placement screen and
 * the read-only "View room plan" preview on the furniture step. */
export function RoomPlanView({ room, ...floorPlanProps }) {
  if (room.layout_status === "pending") {
    return (
      <div className="floor-plan-skeleton">
        <div className="skel" style={{ position: "absolute", inset: 0, borderRadius: 12 }} />
        <div className="floor-plan-skeleton-label">
          <span className="spinner-inline" /> Reading the room&hellip;
        </div>
      </div>
    );
  }

  return (
    <div className="floor-plan-wrap">
      {room.layout_status === "failed" ? (
        <div className="floor-plan-failed-note">The room layout couldn&rsquo;t be read. You can still add walls and pieces by hand.</div>
      ) : null}
      <FloorPlan room={room} {...floorPlanProps} />
    </div>
  );
}
