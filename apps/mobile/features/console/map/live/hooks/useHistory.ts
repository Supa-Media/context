import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { gatewayOriginFrom } from "../../../../meetings/gateway";
import { eventsFromCrossMoves, mergeEvents } from "../convert";
import { listActivityRef, workspaceMovesRef } from "../mapData";
import { MCP_ENDPOINT } from "../../../placeholderData";
import {
  type HistoryDay,
  type ReplayHistoryDeps,
  mergeHistoryDays,
  workspaceHistory,
  workspaceHistoryDays,
} from "../replayHistory";
import type { MapEvent } from "../types";

/**
 * What happened in `span` — any window, a day or all of history — for a
 * replay: one ask of each
 * workspace's gateway (`replayHistory.ts`), which answers what was written,
 * made, moved and read there, already filtered for the viewer — all at once,
 * in parallel — plus the moves between the viewer's own workspaces
 * (`workspaceMoves.list`) when the map shows more than one.
 *
 * `null` while asking. A workspace that cannot answer adds nothing rather than
 * failing the replay: the bar is still the day, with less on it.
 */
export function useReplayHistory(
  span: { from: number; to: number } | null,
  workspaceIds: readonly string[],
  endpoint: string | null = null,
): MapEvent[] | null {
  const list = useAction(listActivityRef);
  const moves = useAction(workspaceMovesRef);
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const calls = useRef({ list, moves, mint });
  calls.current = { list, moves, mint };
  const [events, setEvents] = useState<MapEvent[] | null>(null);
  const key = workspaceIds.join("|");
  const from = span?.from ?? null;
  const to = span?.to ?? null;

  useEffect(() => {
    if (from === null || to === null || workspaceIds.length === 0) {
      setEvents(null);
      return;
    }
    let stopped = false;
    setEvents(null);
    const origin = endpoint === null || typeof fetch !== "function" ? null : gatewayOriginFrom(endpoint);
    const deps: ReplayHistoryDeps = {
      origin,
      mint: async (id) => await calls.current.mint({ workspaceId: id as Id<"workspaces"> }),
      fetchJson: async (url, token) => {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        return response.ok ? ((await response.json()) as unknown) : null;
      },
      listActivity: async (id, since) => await calls.current.list({ workspaceId: id as Id<"workspaces">, since }),
    };
    const each = workspaceIds.map((workspaceId) => workspaceHistory(deps, workspaceId, from, to));
    const across =
      workspaceIds.length > 1
        ? calls.current
            .moves({ from, to })
            .then((answer) => eventsFromCrossMoves(answer.moves.filter((m) => workspaceIds.includes(m.fromWorkspaceId) || workspaceIds.includes(m.toWorkspaceId))))
            .catch(() => [] as MapEvent[])
        : Promise.resolve([] as MapEvent[]);
    void Promise.all([...each, across]).then((lists) => {
      if (!stopped) setEvents(mergeEvents(...lists).filter((e) => e.at >= from && e.at <= to));
    });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, from, to, endpoint]);

  return events;
}

/**
 * Every local day since the viewer's workspaces' history began, and how much
 * happened on each — lines and reads they may see, nothing else — for a custom
 * range picker's activity strip: one ask of each workspace's gateway, in
 * parallel, summed per day. A gateway that does not answer it adds nothing,
 * so an older one leaves an empty strip rather than a broken picker.
 * `endpoint: null` asks nothing (a demo or a fixture).
 */
export function useHistoryDays(
  contextIds: readonly string[],
  endpoint: string | null = MCP_ENDPOINT,
): { days: HistoryDay[]; startsAt: number | null; loading: boolean } {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const call = useRef(mint);
  call.current = mint;
  const [state, setState] = useState<{ days: HistoryDay[]; startsAt: number | null; loading: boolean }>({
    days: [],
    startsAt: null,
    loading: false,
  });
  const key = contextIds.join("|");

  useEffect(() => {
    const origin = endpoint === null || typeof fetch !== "function" ? null : gatewayOriginFrom(endpoint);
    if (origin === null || contextIds.length === 0) {
      setState({ days: [], startsAt: null, loading: false });
      return;
    }
    let stopped = false;
    setState((previous) => ({ ...previous, loading: true }));
    const deps = {
      origin,
      mint: async (id: string) => await call.current({ workspaceId: id as Id<"workspaces"> }),
      fetchJson: async (url: string, token: string) => {
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
        return response.ok ? ((await response.json()) as unknown) : null;
      },
    };
    void Promise.all(contextIds.map((id) => workspaceHistoryDays(deps, id))).then((answers) => {
      if (!stopped) setState({ ...mergeHistoryDays(answers), loading: false });
    });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, endpoint]);

  return state;
}

/**
 * Moves between the viewer's workspaces since `from`, for the live map's
 * "Moved between workspaces today" panel: read on the way in and each minute,
 * while `enabled`.
 */
export function useCrossMovesSince(from: number, enabled: boolean): MapEvent[] {
  const moves = useAction(workspaceMovesRef);
  const call = useRef(moves);
  call.current = moves;
  const [events, setEvents] = useState<MapEvent[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void call.current({ from, to: Date.now() })
        .then((answer) => {
          if (!stopped) setEvents(eventsFromCrossMoves(answer.moves));
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [from, enabled]);

  return enabled ? events : [];
}
