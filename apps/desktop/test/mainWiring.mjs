/**
 * The main process's wiring, read as text.
 *
 * `main/index.ts` used to be the whole of it, and a dozen suites read that one
 * file because it imports Electron and cannot be loaded here. It is now split
 * by subject into the modules listed below, with `index.ts` keeping the startup
 * order. A check about one subject reads the module that holds it
 * (`readMainSource`); a check that sweeps the whole surface — "no other call
 * site", "at least N calls", "the shell reaches every producer" — reads all of
 * them (`readMainWiring`), so splitting a file can never shrink what it sees.
 *
 * **A new module split out of `index.ts` goes in this list**, or the sweeps
 * stop seeing the code it took with it.
 */

import { readFileSync } from "node:fs";

export const MAIN_WIRING_FILES = Object.freeze([
  "index.ts",
  "launchFlags.ts",
  "notices.ts",
  "dialogs.ts",
  "appMenu.ts",
  "context.ts",
  "startup.ts",
  "services.ts",
  "shellView.ts",
  "surfaces.ts",
  "meetings.ts",
  "outboxDrain.ts",
  "consoleCapture.ts",
  "windowIpc.ts",
  "connectFlow.ts",
  "smokeReport.ts",
]);

/** One module under `src/main/`, raw. */
export function readMainSource(name) {
  return readFileSync(new URL(`../src/main/${name}`, import.meta.url), "utf8");
}

/** Every module in {@link MAIN_WIRING_FILES}, raw, `index.ts` first. */
export function readMainWiring() {
  return MAIN_WIRING_FILES.map(readMainSource).join("\n");
}
