import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@context/convex/_generated/api";
import { gatewayOriginFrom } from "../../../../meetings/gateway";
import type { AgentActivityView } from "../../../agents/agentActivity";
import { actorsFromActivity, eventsFromActivity, mergeEvents } from "../convert";
import type { MapActor } from "../engine";
import { createActivityPoller, MAP_POLL_MS, type ActivityPoller } from "../livePoller";
import type { MapEvent } from "../types";

/** How much live history the map keeps: enough for "4 min ago", and no more. */
const KEEP_MS = 30 * 60_000;
const KEEP_EVENTS = 600;

export type LiveActivity = {
  actors: MapActor[];
  events: MapEvent[];
  /** Each workspace's latest answer, for the panels that read it whole. */
  views: ReadonlyMap<string, AgentActivityView>;
};

const EMPTY: LiveActivity = { actors: [], events: [], views: new Map() };

/**
 * The live map's people, tools and events, one poll per workspace on the map
 * (`livePoller.ts`), while `enabled`. Stops when the map closes or goes live →
 * replay, and asks every workspace again at once when the tab comes back.
 */
export function useLiveActivity(workspaceIds: readonly string[], endpoint: string | null, enabled: boolean): LiveActivity {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const [state, setState] = useState<{ views: Map<string, { view: AgentActivityView; at: number }>; events: MapEvent[] }>(
    () => ({ views: new Map(), events: [] }),
  );
  const key = workspaceIds.join("|");

  useEffect(() => {
    const origin = endpoint === null ? null : gatewayOriginFrom(endpoint);
    if (!enabled || origin === null || workspaceIds.length === 0 || typeof fetch !== "function" || typeof window === "undefined") {
      return;
    }
    const pollers: ActivityPoller[] = workspaceIds.map((workspaceId) =>
      createActivityPoller(workspaceId, {
        origin,
        mint: async (id) => await mintRef.current({ workspaceId: id as never }),
        fetchJson: async (url, token) => {
          const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
          return response.ok ? ((await response.json()) as unknown) : null;
        },
        hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        onAnswer: (id, view, at) =>
          setState((prev) => {
            const views = new Map(prev.views);
            views.set(id, { view, at });
            const fresh = mergeEvents(prev.events, eventsFromActivity(view, id)).filter((e) => e.at >= at - KEEP_MS);
            return { views, events: fresh.slice(-KEEP_EVENTS) };
          }),
      }, MAP_POLL_MS),
    );
    for (const poller of pollers) poller.start();
    const again = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") for (const poller of pollers) poller.poke();
    };
    const listens = typeof document !== "undefined" && typeof document.addEventListener === "function";
    if (listens) document.addEventListener("visibilitychange", again);
    return () => {
      for (const poller of pollers) poller.stop();
      if (listens) document.removeEventListener("visibilitychange", again);
    };
    // `key` stands for the list: a new array with the same ids is the same polls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, endpoint, enabled]);

  return useMemo(() => {
    const shown = new Set(workspaceIds);
    if (state.views.size === 0) return EMPTY;
    const actors: MapActor[] = [];
    const views = new Map<string, AgentActivityView>();
    for (const [id, { view, at }] of state.views) {
      if (!shown.has(id)) continue;
      views.set(id, view);
      actors.push(...actorsFromActivity(view, id, at));
    }
    const events = state.events.filter((e) => shown.has(e.workspaceId) || (e.kind === "move" && !!e.toWorkspaceId && shown.has(e.toWorkspaceId)));
    return { actors, events, views };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, key]);
}
