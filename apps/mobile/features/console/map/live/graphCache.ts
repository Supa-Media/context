import { currentEpoch } from "../../../offline/epoch";
import type { GraphAnswer } from "./convert";

/**
 * The last map answer per workspace, kept in this tab's memory so the map
 * opens drawn.
 *
 * The answer took seconds to arrive and was thrown away whenever somebody
 * left the map, so every visit started blank (Dev2, 2026-10-08: "why isnt it
 * instant"). It is kept here, in memory only: a browser tab keeps no copy of
 * a workspace on the device (decided by the owner, 2026-10-08), and this is
 * gone with the tab. The map draws it at once and asks again straight away,
 * so it is never shown for longer than a fresh answer takes to come.
 *
 * Keyed by the session epoch as `serverTree` is, so nothing read before a
 * sign-out is drawn after it.
 */

type Held = { epoch: number; at: number; answer: GraphAnswer };

const held = new Map<string, Held>();

/** Older than this and it is not drawn at all; the map waits for a fresh one. */
export const GRAPH_CACHE_MAX_AGE_MS = 30 * 60_000;

/** The answer last read for this workspace this session, or `undefined`. */
export function cachedGraph(workspaceId: string, now: number = Date.now()): GraphAnswer | undefined {
  const found = held.get(workspaceId);
  if (found === undefined) return undefined;
  if (found.epoch !== currentEpoch() || now - found.at > GRAPH_CACHE_MAX_AGE_MS) {
    held.delete(workspaceId);
    return undefined;
  }
  return found.answer;
}

/** Keep an answer read under `epoch`, unless the session has ended since. */
export function holdGraph(workspaceId: string, answer: GraphAnswer, epoch: number, now: number = Date.now()): void {
  if (epoch !== currentEpoch()) return;
  held.set(workspaceId, { epoch, at: now, answer });
}

/** Tests only. */
export function forgetGraphs(): void {
  held.clear();
}
