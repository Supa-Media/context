import { trackButton } from "../../observability/client";
import type { ConsoleData } from "../types";

/** Settings' "Download everything": the whole workspace open now, as a zip. */
export function downloadEverything(data: ConsoleData): void {
  trackButton("download_everything");
  data.files.download("", "folder");
}
