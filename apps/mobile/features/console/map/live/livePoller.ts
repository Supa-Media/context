import { decodeAgentActivity, type AgentActivityView } from "../../agents/agentActivity";
import { takeAnnouncement } from "./announce";
import { newestAt } from "./convert";

/**
 * One workspace's `GET /agent-activity`, asked every few seconds while the
 * map is on screen. The sidebar asks every half minute (`useAgentActivity`);
 * the map asks faster because somebody is watching faces move, and the
 * gateway's decision for that rate is in
 * `docs/decisions/gateway-protocol/live-map-feed.md`.
 *
 * - **Nothing is asked while the tab is hidden.** The timer keeps running and
 *   each tick skips the request; `poke` asks at once on the way back.
 * - **`since` is the newest event held**, so each answer carries only what is
 *   new (`at` is strictly increasing per workspace).
 * - **Each workspace has its own grant**, minted for it alone and renewed a
 *   minute before it runs out.
 *
 * Plain functions with the clock, timers, fetch and the mint injected, so the
 * pause and the cursor are tested without a browser.
 */

export const MAP_POLL_MS = 4_000;

export type Grant = { accessToken: string; expiresAt: number };

export type PollerDeps = {
  origin: string;
  mint(workspaceId: string): Promise<Grant>;
  /** The JSON body of a successful answer, or `null` for any failure. */
  fetchJson(url: string, token: string): Promise<unknown | null>;
  hidden(): boolean;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  onAnswer(workspaceId: string, view: AgentActivityView, at: number): void;
};

export type ActivityPoller = {
  start(): void;
  stop(): void;
  /** Ask now, if no request is in flight (the tab came back). */
  poke(): void;
  since(): number | null;
};

export function createActivityPoller(workspaceId: string, deps: PollerDeps, pollMs = MAP_POLL_MS): ActivityPoller {
  let stopped = true;
  let inFlight = false;
  let timer: unknown = null;
  let grant: Grant | null = null;
  let since: number | null = null;

  const schedule = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = stopped ? null : deps.setTimer(() => void read(), pollMs);
  };

  const read = async () => {
    if (stopped || inFlight) return;
    if (deps.hidden()) {
      schedule();
      return;
    }
    inFlight = true;
    let restore: (() => void) | null = null;
    try {
      if (grant === null || grant.expiresAt - deps.now() < 60_000) grant = await deps.mint(workspaceId);
      const next = takeAnnouncement(workspaceId, since);
      restore = next.restore;
      const body = await deps.fetchJson(`${deps.origin}/agent-activity${next.query}`, grant.accessToken);
      if (body === null) {
        restore();
      } else if (!stopped) {
        const view = decodeAgentActivity(body);
        since = newestAt(view.events ?? [], since);
        deps.onAnswer(workspaceId, view, deps.now());
      }
    } catch {
      restore?.();
      // A quieter map until the next attempt.
    } finally {
      inFlight = false;
    }
    schedule();
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void read();
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    poke() {
      if (!stopped) void read();
    },
    since: () => since,
  };
}
