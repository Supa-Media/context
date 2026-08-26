import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { ConnectionsPane } from "../../../features/console/panes/ConnectionsPane";

/** `/console/connections` — the MCP endpoint and per-client grants. */
export default function ConnectionsRoute() {
  return <ConnectionsPane data={useConsoleData()} />;
}
