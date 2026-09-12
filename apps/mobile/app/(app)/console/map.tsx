import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { MapPane } from "../../../features/console/panes/MapPane";

/**
 * `/console/map` — the constellation of contexts you can reach.
 *
 * **Reachable from nowhere, deliberately.** Its last door was the "Elsewhere in
 * the console" card at the foot of settings: three destinations repeated under
 * all nineteen sections, drawn unconditionally *because* taking it off any one
 * section took the map out of the product. A fire escape on every floor is not
 * a place in the navigation, and the owner's answer when that was put to them
 * was that the map can vanish. It had already lost its rail row — `ConsoleRail`
 * records why, that Map and Connections are facts about a context rather than
 * places inside one — and a phone has no left panel at all.
 *
 * The route and the pane are untouched and still render, so this is one
 * entry point away from coming back; `features/app/reachability.ts` is where
 * that claim would go.
 */
export default function MapRoute() {
  return <MapPane data={useConsoleData()} />;
}
