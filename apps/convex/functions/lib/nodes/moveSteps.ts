/**
 * One object of a queued move, moved so that it never stops the move behind
 * it (`moveWork.ts`). Plan: project file `move-engine/plan.md`, step A.
 *
 * `moveObject` (`mcp/src/moves/queued.js`) is the step itself: create-only
 * copy, guarded retire, idempotent on a re-run. This file is what the worker
 * does around it:
 *
 *  - **Retried in place.** A storage error or a note edited mid-copy is tried
 *    again a few times with a short wait, inside the pass, rather than failing
 *    the whole pass and waiting out a back-off.
 *  - **A clash is settled, never waited out.** A different object already at
 *    the destination is not ours and will not go away by retrying. Both are
 *    kept: the moving object lands beside it as `name (moved).ext`, the way a
 *    sync tool keeps a conflicted copy. That is only done where the new name
 *    is exactly as visible as the destination would have been: a name with a
 *    rule of its own, or a destination held back by an exact-note rule, is
 *    left failing (and shown as stuck) rather than risk showing it wider.
 *  - **Never throws.** Whatever happens is an outcome; the worker counts
 *    failures and keeps moving the objects behind this one.
 */

import { MoveObjectConflict, moveObject } from "../../../../mcp/src/moves/queued.js";
import type { PrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import { effectiveVisibility, hasOverride } from "../privacy";

/** Tries of one object within a pass. */
export const OBJECT_TRIES = 3;
/** The waits between those tries. */
const TRY_WAITS_MS = [250, 1_000];
/** `(moved)`, `(moved 2)` … names tried for one clash before giving up. */
export const CLASH_NAMES = 20;

export type ObjectOutcome =
  | { state: "moved"; path: string; etag?: string; size?: number; clashWith?: string }
  | { state: "gone" }
  | { state: "failed"; conflict: boolean };

export interface StepOptions {
  /** The workspace's rules, read at most once per pass. */
  privacy: () => Promise<PrivacyState>;
  /** Waits between tries; tests pass a clock that does not sleep. */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `a/plan.md` beside a clash: `a/plan (moved).md`, then `a/plan (moved 2).md`. */
export function clashName(path: string, n: number): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const tag = n <= 1 ? " (moved)" : ` (moved ${n})`;
  return dot > slash + 1 ? `${path.slice(0, dot)}${tag}${path.slice(dot)}` : `${path}${tag}`;
}

function isClash(error: unknown): boolean {
  return error instanceof MoveObjectConflict && (error as MoveObjectConflict & { clash?: boolean }).clash === true;
}

function outcomeOf(answer: { state: string; etag?: string; size?: number }, path: string): ObjectOutcome {
  if (answer.state !== "moved") return { state: "gone" };
  return {
    state: "moved",
    path,
    ...(typeof answer.etag === "string" ? { etag: answer.etag } : {}),
    ...(typeof answer.size === "number" ? { size: answer.size } : {}),
  };
}

/** Whether `name` would be seen by exactly whoever the destination would have been. */
function asVisible(state: PrivacyState, destination: string, name: string): boolean {
  if (state.invalid) return false;
  if (hasOverride(state.overrides, destination) || hasOverride(state.overrides, name)) return false;
  return effectiveVisibility(name, state.rules, state.overrides) === effectiveVisibility(destination, state.rules, state.overrides);
}

/** A different object is at the destination: keep both, the moving one under the first free `(moved)` name. */
async function settleClash(store: FileStore, source: string, destination: string, options: StepOptions): Promise<ObjectOutcome> {
  if (destination.endsWith("/")) return { state: "failed", conflict: true };
  let state: PrivacyState;
  try {
    state = await options.privacy();
  } catch {
    return { state: "failed", conflict: true };
  }
  for (let n = 1; n <= CLASH_NAMES; n += 1) {
    const name = clashName(destination, n);
    if (!asVisible(state, destination, name)) return { state: "failed", conflict: true };
    try {
      const outcome = outcomeOf(await moveObject(store, source, name), name);
      return outcome.state === "moved" ? { ...outcome, clashWith: destination } : outcome;
    } catch (error) {
      if (isClash(error)) continue;
      return { state: "failed", conflict: error instanceof MoveObjectConflict };
    }
  }
  return { state: "failed", conflict: true };
}

/** Move one object to `destination`, retried in place; a clash keeps both. Never throws. */
export async function moveOneObject(store: FileStore, source: string, destination: string, options: StepOptions): Promise<ObjectOutcome> {
  const wait = options.wait ?? sleep;
  let conflict = false;
  for (let attempt = 0; attempt < OBJECT_TRIES; attempt += 1) {
    try {
      return outcomeOf(await moveObject(store, source, destination), destination);
    } catch (error) {
      if (isClash(error)) return await settleClash(store, source, destination, options);
      conflict = error instanceof MoveObjectConflict;
      if (attempt + 1 < OBJECT_TRIES) await wait(TRY_WAITS_MS[Math.min(attempt, TRY_WAITS_MS.length - 1)]!);
    }
  }
  return { state: "failed", conflict };
}
