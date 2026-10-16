import { FloorPlan } from "./FloorPlan.jsx";

/** The room layout's states on the floor plan screen: still to be read
 * (not_started / pending), failed or ready. */
export function RoomPlanView({ room, ...floorPlanProps }) {
  if (room.layout_status === "pending" || room.layout_status === "not_started") {
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
