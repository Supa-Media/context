import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { BrowsePane } from "../../../features/console/panes/BrowsePane";

/** `/console/browse` — the folder tree and note preview. */
export default function BrowseRoute() {
  return <BrowsePane data={useConsoleData()} />;
}
