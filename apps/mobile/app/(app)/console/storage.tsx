import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { StoragePane } from "../../../features/console/panes/StoragePane";

/** `/console/storage` — the customer's bucket and what we could prove about it. */
export default function StorageRoute() {
  return <StoragePane data={useConsoleData()} />;
}
