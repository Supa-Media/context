import type { Id } from "@context/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { eventsFromCrossMoves, eventsFromHistory, mergeEvents } from "../convert";
import { listActivityRef, workspaceMovesRef } from "../mapData";
import type { MapEvent } from "../types";

/**
 * What happened in a stretch of time, for a replay: each workspace's
 * `activity.md` lines since `from` (`files.listActivity`, filtered per reader
 * by the control plane), plus the moves between the viewer's own workspaces
 * (`workspaceMoves.list`) when the map shows more than one.
 *
 * `null` while asking. A workspace that cannot answer adds nothing rather than
 * failing the replay: the bar is still the day, with less on it.
 */
export function useReplayHistory(span: { from: number; to: number } | null, workspaceIds: readonly string[]): MapEvent[] | null {
  const list = useAction(listActivityRef);
  const moves = useAction(workspaceMovesRef);
  const calls = useRef({ list, moves });
  calls.current = { list, moves };
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
    const reads = workspaceIds.map((workspaceId) =>
      calls.current
        .list({ workspaceId: workspaceId as Id<"workspaces">, since: from })
        .then((entries) => eventsFromHistory(entries, workspaceId))
        .catch(() => [] as MapEvent[]),
    );
    const across =
      workspaceIds.length > 1
        ? calls.current
            .moves({ from, to })
            .then((answer) => eventsFromCrossMoves(answer.moves.filter((m) => workspaceIds.includes(m.fromWorkspaceId) || workspaceIds.includes(m.toWorkspaceId))))
            .catch(() => [] as MapEvent[])
        : Promise.resolve([] as MapEvent[]);
    void Promise.all([...reads, across]).then((lists) => {
      if (!stopped) setEvents(mergeEvents(...lists).filter((e) => e.at >= from && e.at <= to));
    });
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, from, to]);

  return events;
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
