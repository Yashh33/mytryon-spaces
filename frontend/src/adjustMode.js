import { useSearchParams } from "react-router-dom";

/** The Furniture / Placement / Finish steps are also opened from "Adjust &
 * try again", marked with ?adjust=<source attempt id>. In that case the back
 * button returns to that Adjust screen with this attempt as its draft, and
 * the mark is carried along to the next step.
 * Returns { backTo: string | null, query: "" | "adjust=<id>" }. */
export function useAdjustMode(attemptId) {
  const [searchParams] = useSearchParams();
  const source = searchParams.get("adjust");
  if (!source) return { backTo: null, query: "" };
  return { backTo: `/attempt/${source}/adjust?draft=${attemptId}`, query: `adjust=${source}` };
}
