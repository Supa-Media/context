/**
 * Which screen the guide shows, and what the widget's tile says — from saved
 * progress and the facts in `checks.ts`.
 *
 * Pure, for the reason the rest of this folder is: a guide that moves on by
 * itself has to be right about when, and every "when" here is a test.
 */

import type { AgentActivityView } from "../console/agents/agentActivity";
import type { GrantFacts } from "../onboarding/tools";
import {
  agentMarks,
  agentUsed,
  bringState,
  mergeWritten,
  onlyGettingStarted,
  signedIn,
  SIGNIN_SLOW_AFTER_MS,
  type BringState,
  type WrittenNote,
} from "./checks";
import { GETTING_STARTED } from "./bring";
import { GUIDE_STEPS, type SetupAgent, type StepKey } from "./guides";
import type { SetupProgress } from "./progress";

export type TileState =
  | { kind: "new" }
  | { kind: "partway"; step: number; of: number }
  | { kind: "connected" };

/**
 * The tile in the widget.
 *
 * "Connected" needs the agent to have called in, not a click on Finish: a
 * grant revoked in Settings takes the tile back to "Set up" even on a device
 * that finished. Somebody who connected before this guide existed has no
 * record and is simply connected.
 */
export function tileState(
  agent: SetupAgent,
  progress: SetupProgress | undefined,
  grants: readonly GrantFacts[] | undefined,
): TileState {
  const used = agentUsed(agent, grants);
  const of = GUIDE_STEPS[agent].length;
  if (progress !== undefined && !progress.finished && progress.step > 0) {
    return { kind: "partway", step: progress.step + 1, of };
  }
  if (used || (progress?.finished === true && signedIn(agent, grants))) return { kind: "connected" };
  return { kind: "new" };
}

/**
 * Where to open. A saved step, unless the agent is already signed in and the
 * saved step is before sign-in — reconnecting from Settings, or connecting
 * before this guide existed — in which case the steps it already did are
 * skipped rather than repeated.
 */
export function openingStep(
  agent: SetupAgent,
  progress: SetupProgress,
  grants: readonly GrantFacts[] | undefined,
): number {
  const signin = GUIDE_STEPS[agent].indexOf("signin");
  if (progress.finished) return GUIDE_STEPS[agent].length - 1;
  if (progress.step < signin && signedIn(agent, grants)) return signin + 1;
  return progress.step;
}

export type SigninState = "waiting" | "slow" | "done";

export function signinState(
  agent: SetupAgent,
  grants: readonly GrantFacts[] | undefined,
  openedAt: number,
  now: number,
): SigninState {
  if (signedIn(agent, grants)) return "done";
  return now - openedAt >= SIGNIN_SLOW_AFTER_MS ? "slow" : "waiting";
}

export type BringView =
  | { kind: "pick" }
  | { kind: "live"; state: BringState; signedIn: boolean; reads: number; written: WrittenNote[] }
  | { kind: "done"; written: WrittenNote[] }
  | { kind: "little"; written: WrittenNote[] };

const GETTING_STARTED_PATH = new RegExp(GETTING_STARTED.replace(/ /g, "[-_ ]"), "i");

/**
 * The last step. The prompt ends with a "Getting started" note, so that note
 * arriving is the agent saying it is finished; until then the list fills in
 * as notes land. Only that note, and nothing else, is an agent with little to
 * bring — connected, and the finish screen says what to do about memory.
 */
export function bringView({
  agent,
  progress,
  grants,
  activity,
  now,
}: {
  agent: SetupAgent;
  progress: SetupProgress;
  grants: readonly GrantFacts[] | undefined;
  activity: AgentActivityView | undefined;
  now: number;
}): BringView {
  if (progress.copiedAt === null && progress.written.length === 0) return { kind: "pick" };
  const since = progress.copiedAt ?? 0;
  const marks = agentMarks(agent, activity, since);
  const written = mergeWritten(progress.written, marks.writes);
  if (written.some((row) => GETTING_STARTED_PATH.test(row.path))) {
    return onlyGettingStarted(written) ? { kind: "little", written } : { kind: "done", written };
  }
  return {
    kind: "live",
    state: bringState({ copiedAt: progress.copiedAt, now, reads: marks.reads, written }),
    signedIn: signedIn(agent, grants),
    reads: marks.reads,
    written,
  };
}

export function stepKey(agent: SetupAgent, step: number): StepKey {
  return GUIDE_STEPS[agent][step] ?? GUIDE_STEPS[agent][0]!;
}
