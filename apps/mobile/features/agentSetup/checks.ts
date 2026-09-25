/**
 * What the guide can see for itself, so nobody has to report it.
 *
 * Three facts, all ones the product already records, and no new backend:
 *
 *  - **signed in**: the agent holds a live grant on this workspace
 *    (`grants.listGrants`, matched to the agent by the name it registered).
 *  - **read** and **wrote**: the gateway's agent-activity marks for that agent
 *    (`GET /agent-activity`), since the prompt was copied.
 *
 * "Make it stick" is the one step nothing can observe — we cannot see an
 * agent's own settings — so that step takes the person's word and says so.
 *
 * Pure: every state the guide can be in is a test.
 */

import { providerIdForClientName } from "../console/clients/providers";
import { displayName, displayPath } from "../console/files/paths";
import type { AgentActivityView } from "../console/agents/agentActivity";
import type { GrantFacts } from "../onboarding/tools";
import { CONSOLE_CLIENT_ID } from "../onboarding/tools";
import type { SetupAgent } from "./guides";

/** No read at all this long after the prompt was copied: say what to check. */
export const NOTHING_AFTER_MS = 3 * 60_000;
/** Read, but nothing written, this long after the prompt was copied. */
export const NO_WRITE_AFTER_MS = 3 * 60_000;
/** Still not signed in this long after the sign-in step opened. */
export const SIGNIN_SLOW_AFTER_MS = 2 * 60_000;

function isAgent(agent: SetupAgent, name: string | null | undefined): boolean {
  return providerIdForClientName(name ?? "") === agent;
}

/** Whether this agent holds a live grant here. Any grant counts: reconnecting is signing in. */
export function signedIn(agent: SetupAgent, grants: readonly GrantFacts[] | undefined): boolean {
  return (grants ?? []).some(
    (grant) =>
      grant.status === "active" &&
      grant.clientId !== CONSOLE_CLIENT_ID &&
      isAgent(agent, grant.clientName ?? grant.clientId),
  );
}

/** Whether this agent has ever called in: its grant has been used. */
export function agentUsed(agent: SetupAgent, grants: readonly GrantFacts[] | undefined): boolean {
  return (grants ?? []).some(
    (grant) =>
      grant.status === "active" &&
      grant.clientId !== CONSOLE_CLIENT_ID &&
      isAgent(agent, grant.clientName ?? grant.clientId) &&
      typeof grant.lastUsedAt === "number" &&
      grant.lastUsedAt > 0,
  );
}

export interface WrittenNote {
  path: string;
  at: number;
}

/** This agent's reads and writes since `since`, from one activity answer. */
export function agentMarks(
  agent: SetupAgent,
  activity: AgentActivityView | undefined,
  since: number,
): { reads: number; writes: WrittenNote[] } {
  if (activity === undefined) return { reads: 0, writes: [] };
  const mine = new Set(activity.agents.filter((row) => isAgent(agent, row.name)).map((row) => row.id));
  let reads = 0;
  const writes: WrittenNote[] = [];
  for (const mark of activity.marks) {
    if (!mine.has(mark.agent) || mark.at < since) continue;
    if (mark.kind === "read") reads += 1;
    else writes.push({ path: mark.path, at: mark.at });
  }
  return { reads, writes };
}

/**
 * Folds a new answer into the notes seen so far.
 *
 * The gateway only remembers the last few minutes, and a slow agent can take
 * longer than that to write six notes, so the guide keeps what it has seen.
 * Newest write of a path wins; order is first-seen, so rows do not jump.
 */
export function mergeWritten(seen: readonly WrittenNote[], fresh: readonly WrittenNote[]): WrittenNote[] {
  const out = seen.map((row) => ({ ...row }));
  for (const row of fresh) {
    const at = out.findIndex((existing) => existing.path === row.path);
    if (at === -1) out.push({ ...row });
    else if (row.at > out[at]!.at) out[at] = { ...row };
  }
  return out;
}

export type BringState =
  /** Prompt not copied yet. */
  | { kind: "ready" }
  /** Copied; nothing from the agent yet. */
  | { kind: "waiting" }
  /** It has read; nothing written yet. */
  | { kind: "reading" }
  /** Notes are arriving. */
  | { kind: "writing" }
  | { kind: "stalled-nothing" }
  | { kind: "stalled-no-write" };

export function bringState({
  copiedAt,
  now,
  reads,
  written,
}: {
  copiedAt: number | null;
  now: number;
  reads: number;
  written: readonly WrittenNote[];
}): BringState {
  if (written.length > 0) return { kind: "writing" };
  if (copiedAt === null) return { kind: "ready" };
  const waited = now - copiedAt;
  if (reads > 0) return waited >= NO_WRITE_AFTER_MS ? { kind: "stalled-no-write" } : { kind: "reading" };
  return waited >= NOTHING_AFTER_MS ? { kind: "stalled-nothing" } : { kind: "waiting" };
}

/**
 * Whether what was written is only the "Getting started" note — connected,
 * but the agent had little in memory to bring over. The finish screen says
 * so rather than calling an empty run a success story.
 */
export function onlyGettingStarted(written: readonly WrittenNote[]): boolean {
  return written.length > 0 && written.every((row) => /getting[-_ ]started/i.test(row.path));
}

/**
 * A path as the list shows it: the note's name the way the tree draws it.
 * Written by an agent, so contained like every other name that reaches a
 * screen (`displayName`) — a path is somebody else's text.
 */
export function noteTitle(path: string): string {
  return displayName(path.slice(path.lastIndexOf("/") + 1));
}

/** The folder and file, sort numbers dropped and contained, for the row's right side. */
export function notePlace(path: string): string {
  return displayPath(path);
}
