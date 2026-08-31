import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { MapPane } from "../../../features/console/panes/MapPane";

/** `/console/map` — the constellation of contexts you can reach. */
export default function MapRoute() {
  return <MapPane data={useConsoleData()} />;
}
