import { MAP_PARTS, type CaseMapSummary, type MapPartId, type MapPartView } from "./case-map.ts";

/*
 * How far a case's map is, for Home and the case summary (UX-5): read from the map's own
 * views (caseMapView in the main process, getCaseMap in the interface), the same way on both
 * sides. A part counts once it has something in it; it is approved when the version shown is
 * the approved one. A part approved while empty is not counted at all (review round 1, M2), so
 * "approved" never says more than the parts that need approving.
 */
export function mapProgress(parts: Readonly<Record<MapPartId, Pick<MapPartView, "status" | "items" | "groups">>>): { caseMap: CaseMapSummary; mapPartToApprove: MapPartId | null } {
  let approved = 0;
  let withContent = 0;
  let mapPartToApprove: MapPartId | null = null;
  for (const part of MAP_PARTS) {
    const view = parts[part];
    if (view.items.length === 0 && view.groups.length === 0) continue;
    withContent++;
    if (view.status === "approved") approved++;
    else mapPartToApprove ??= part;
  }
  return { caseMap: { approved, withContent }, mapPartToApprove };
}
