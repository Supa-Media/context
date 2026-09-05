/**
 * What is running.
 *
 * The cheapest and least invasive of the four collectors: `ps` needs no
 * permission at all, returns no document names, no URLs and no window titles,
 * and is enough on its own for `detect()` to know that a conferencing app is
 * open. It is deliberately the first signal — everything else in this folder
 * costs the person a permission dialog.
 *
 * Names are the executable's last path component (`zoom.us`, `Google Chrome`),
 * lowercased by nothing here: `detect()` and the blocklist both normalise, and
 * a collector that pre-normalises throws away the evidence a reason string
 * wants to quote.
 */

import { run } from "../exec.ts";

/** Parse `ps -Ac -o comm=` output. Exported for the suite; no `ps` required. */
export function parseProcessList(stdout: string): string[] {
  const names = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    // `ps -c` already gives the accounting name rather than the full path, but
    // helper processes still arrive as paths on some builds.
    .map((line) => line.split("/").filter(Boolean).pop() ?? line);
  return [...new Set(names)].sort();
}

export async function collectProcesses(): Promise<string[]> {
  return parseProcessList(await run("/bin/ps", ["-Ac", "-o", "comm="], { timeoutMs: 3_000 }));
}
