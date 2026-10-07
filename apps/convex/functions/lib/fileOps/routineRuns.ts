/**
 * A routine's recent runs, read for someone who can see the routine.
 *
 * The history is Context's plumbing in the customer's bucket
 * (`.context/agent/routines/<folder>/<name>.json`, written by the gateway's
 * `apps/mcp/src/agent/routine.js`), so no ordinary read reaches it: every
 * path check refuses a dot segment. This is the one narrow way in, and it is
 * named by the *routine note's* path, never by the plumbing key: the caller
 * must be able to see that note through the live `privacy.md`, exactly as
 * `readFile` decides it, and the note must still be there. A routine you
 * cannot open has no history you can read, and one that is gone is treated
 * as never having existed. See "A run's history is Context's plumbing in the
 * customer's bucket" in `docs/decisions/routines.md`.
 *
 * Nothing is kept in the control plane: the runs are read, shaped, and handed
 * straight back to the console.
 */

import { routineFromPath, routineRunsKey } from "@context/shared/src/routines.cjs";
import { legacyStorageKey } from "@context/shared/src/storageLayout.cjs";
import type { Clearance } from "../clearance";
import { canSee } from "../privacy";
import { notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import type { FileStore } from "./store";

/** The gateway keeps this many (`MAX_RUNS_KEPT`); never hand back more. */
export const ROUTINE_RUNS_SHOWN = 20;
/** The gateway clips a run's text to this (`MAX_RUN_TEXT`); a file edited by hand is clipped again. */
const MAX_RUN_TEXT = 2000;
/** Larger than twenty runs at their longest can be; a bigger file is not ours. */
const MAX_HISTORY_BYTES = 128_000;

export interface RoutineRun {
  at: number;
  outcome: string;
  text: string;
}

function isRun(value: unknown): value is RoutineRun {
  if (value === null || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.at === "number" &&
    Number.isFinite(run.at) &&
    typeof run.outcome === "string" &&
    typeof run.text === "string"
  );
}

/** The runs, newest first. A missing or unreadable history is no runs, never an error. */
export async function readRoutineRuns(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<RoutineRun[]> {
  const path = requirePath(options.path);
  // Only a note that is a routine has a history; anything else is refused the
  // way a note the caller cannot see is, so this is never a way to probe keys.
  if (routineFromPath(path)?.kind !== "routine") throw notFound();
  const state = await loadPrivacyState(store);
  const { scope, names } = options.clearance;
  if (!canSee(path, scope, state.rules, state.overrides, names)) throw notFound();
  if ((await store.get(path)) === null) throw notFound();

  const key = routineRunsKey(path);
  const legacy = legacyStorageKey(key);
  const object = (await store.get(key)) ?? (legacy === null ? null : await store.get(legacy));
  if (object === null) return [];
  try {
    const text = await object.text();
    if (text.length > MAX_HISTORY_BYTES) return [];
    const parsed = JSON.parse(text) as { runs?: unknown };
    const runs = Array.isArray(parsed?.runs) ? parsed.runs.filter(isRun) : [];
    return runs
      .slice(-ROUTINE_RUNS_SHOWN)
      .reverse()
      .map((run) => ({ at: run.at, outcome: run.outcome.slice(0, 40), text: run.text.slice(0, MAX_RUN_TEXT) }));
  } catch {
    return [];
  }
}
