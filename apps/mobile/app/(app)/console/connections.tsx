import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { ConnectionsPane } from "../../../features/console/panes/ConnectionsPane";

/**
 * `/console/connections` — the MCP endpoint and per-client grants.
 *
 * **Reachable from nowhere, deliberately.** Its last door was "Manage sharing…"
 * on a context's right-click menu, a row that answered a question about one
 * context by navigating out of it; the owner's call was to take it off, leaving
 * Open and Settings…. Nothing here went with it — every card on this pane is
 * mounted inside settings too, from the same components rather than a copy:
 * `MembersSection` under Settings → People, and the endpoint with the connected
 * AI apps under Settings → AI apps.
 *
 * The route and the pane still render, so this is one entry point away from
 * coming back; `features/app/reachability.ts` is where that claim would go.
 */
export default function ConnectionsRoute() {
  return <ConnectionsPane data={useConsoleData()} />;
}
