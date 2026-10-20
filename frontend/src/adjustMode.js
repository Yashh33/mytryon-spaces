import { useSearchParams } from "react-router-dom";

/** The Furniture / Placement / Finish steps are also opened from "Adjust &
 * try again", marked with ?adjust=<attempt id>. Adjust edits that attempt
 * itself (no draft copy is made); its Generate makes the new attempt. In that
 * case the back button returns to the Adjust screen, and the mark is carried
 * along to the next step.
 * Returns { active: boolean, backTo: string | null, query: "" | "adjust=<id>" }. */
export function useAdjustMode() {
  const [searchParams] = useSearchParams();
  const source = searchParams.get("adjust");
  if (!source) return { active: false, backTo: null, query: "" };
  return { active: true, backTo: `/attempt/${source}/adjust`, query: `adjust=${source}` };
}
