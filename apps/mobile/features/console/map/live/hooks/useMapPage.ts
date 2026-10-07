import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useColors, useScheme } from "../../../../design/theme";
import { darkMapColors, lightMapColors } from "../../../../design/tokens/colors";
import { useReducedMotion } from "../../../../design/useReducedMotion";
import { MCP_ENDPOINT } from "../../../placeholderData";
import type { ConsoleData } from "../../../types";
import { applyEvents, mergeEvents } from "../convert";
import {
  actorsAt,
  folderCountsAt,
  histogram,
  mapPalette,
  momentsOf,
  type FollowState,
  type MapActor,
  type MapData,
  type MapEngine,
} from "../engine";
import { crossMoveRows, liveFeed, nameBook, replayFeed, workingNowLine, type CrossMoveRow, type FeedItem } from "../feed";
import { setMapFolderCounts } from "../mapCounts";
import { useMapFixtureSource } from "../MapSourceContext";
import { REPLAY_IDLE_MS, replayReducer, replayWindow, startOfDay, type ReplayAction, type ReplayState } from "../replayClock";
import type { MapClock, MapEvent, MapView } from "../types";
import { useCrossMovesSince, useReplayHistory } from "./useHistory";
import { useLiveActivity } from "./useLiveActivity";
import { useMapGraphs, type MapWorkspace } from "./useMapGraphs";

export type MapMode = "live" | "today" | "week";
export type MapScopeChoice = "one" | "all";

/** Bars on the replay's activity histogram. */
export const HISTOGRAM_BARS = 72;

/** A clock for "2 min ago" that moves on its own, every `ms`. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function nullableReplay(state: ReplayState | null, action: ReplayAction | { type: "stop" }): ReplayState | null {
  if (action.type === "stop") return null;
  if (action.type === "start") return replayReducer(state as ReplayState, action);
  return state === null ? null : replayReducer(state, action);
}

/**
 * Everything the map page draws, from the console's data: which workspaces,
 * their graphs, who is in them now or was at the playhead, the feed, the
 * counts the sidebar shows, and the replay's state. The page's components
 * only lay this out.
 */
export function useMapPage(data: ConsoleData) {
  const colors = useColors();
  const scheme = useScheme();
  const reducedMotion = useReducedMotion();
  const [scope, setScope] = useState<MapScopeChoice>("one");
  const [view, setView] = useState<MapView>("map");
  const [mode, setModeState] = useState<MapMode>("live");
  const [switchedAt, setSwitchedAt] = useState(() => Date.now());
  const [replay, dispatch] = useReducer(nullableReplay, null);
  const [follow, setFollow] = useState<FollowState | null>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const now = useNow(15_000);

  const all: MapWorkspace[] = useMemo(
    () => data.contexts.map((c) => ({ id: c.id, slug: c.slug, displayName: c.displayName, kind: c.kind })),
    [data.contexts],
  );
  const selected = all.find((w) => w.id === data.selectedContextId) ?? all[0] ?? null;
  const many = all.length > 1;
  const shown = useMemo(
    () => (scope === "all" && many ? all : selected === null ? [] : [selected]),
    [scope, many, all, selected],
  );
  const ids = useMemo(() => shown.map((w) => w.id), [shown]);

  // The screenshot fixture's invented data, when there is one; the network otherwise.
  const fixture = useMapFixtureSource();
  const remote = fixture === null && !data.demo;
  const fetched = useMapGraphs(shown, remote);
  const polled = useLiveActivity(ids, remote ? MCP_ENDPOINT : null, mode === "live");
  const span = useMemo(() => (mode === "live" ? null : replayWindow(mode, switchedAt)), [mode, switchedAt]);
  const asked = useReplayHistory(remote ? span : null, ids, remote ? MCP_ENDPOINT : null);
  const todayFrom = startOfDay(now);
  const crossToday = useCrossMovesSince(todayFrom, scope === "all" && many && mode === "live" && remote);
  const graphs = useMemo(
    () =>
      fixture === null
        ? fetched
        : { ...fetched, loading: false, graphs: fixture.graphs.filter((g) => ids.includes(g.workspaceId)) },
    [fixture, fetched, ids],
  );
  const live = useMemo(
    () =>
      fixture === null
        ? polled
        : {
            ...polled,
            actors: fixture.live.actors.filter((a) => a.workspaceId === undefined || ids.includes(a.workspaceId)),
            events: fixture.live.events.filter((e) => ids.includes(e.workspaceId)),
          },
    [fixture, polled, ids],
  );
  const history = useMemo(
    () =>
      fixture === null || span === null
        ? asked
        : fixture.history(span.from, span.to).filter((e) => ids.includes(e.workspaceId)),
    [fixture, span, asked, ids],
  );

  // A replay starts once its history has arrived, trimmed to the day's first change.
  useEffect(() => {
    if (mode === "live" || history === null) return;
    if (replay !== null && replay.range === mode) return;
    dispatch({ type: "start", range: mode, now: switchedAt, firstAt: history[0]?.at });
  }, [mode, history, replay, switchedAt]);

  const setMode = useCallback((next: MapMode) => {
    setModeState(next);
    setSwitchedAt(Date.now());
    dispatch({ type: "stop" });
  }, []);

  const replaying = mode !== "live" && replay !== null;
  const events: MapEvent[] = useMemo(
    () => (mode === "live" ? mergeEvents(live.events, crossToday) : (history ?? [])),
    [mode, live.events, crossToday, history],
  );
  const actors: MapActor[] = mode === "live" ? live.actors : [];
  // Live, the graphs catch up with moves and new notes between their reads.
  const present = useMemo(
    () => (mode === "live" ? applyEvents(graphs.graphs, events) : graphs.graphs),
    [mode, graphs.graphs, events],
  );
  const selfId = live.actors.find((a) => a.self && a.kind === "person")?.id ?? null;
  const clock: MapClock = replaying
    ? { kind: "replay", from: replay.from, to: replay.to, at: replay.seek, speed: replay.speed, idleMs: REPLAY_IDLE_MS[replay.range] }
    : { kind: "live" };
  const palette = useMemo(() => mapPalette(colors, scheme === "dark" ? darkMapColors : lightMapColors), [colors, scheme]);

  const mapData: MapData = useMemo(
    () => ({
      graphs: present,
      actors,
      events,
      scope: scope === "all" && many ? { kind: "all" } : { kind: "one", workspaceId: selected?.id ?? "" },
      view,
      clock,
      palette,
      selfId,
    }),
    // `clock` is rebuilt from its parts each render; these are what change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [present, actors, events, scope, many, selected?.id, view, replaying, replay?.from, replay?.to, replay?.seek, replay?.speed, replay?.range, palette, selfId],
  );

  const book = useMemo(() => nameBook(present), [present]);
  const t = replaying ? replay.at : now;

  // The sidebar's counts: the selected workspace's top folders, at the playhead or now.
  const counts = useMemo(() => {
    if (selected === null || !present.some((g) => g.workspaceId === selected.id)) return null;
    return folderCountsAt(present, events, replaying ? t : Number.MAX_SAFE_INTEGER)[selected.id] ?? null;
  }, [present, events, replaying, t, selected]);
  useEffect(() => {
    setMapFolderCounts(counts === null || selected === null ? null : { workspaceId: selected.id, byRoot: counts });
  }, [counts, selected]);
  useEffect(() => () => setMapFolderCounts(null), []);

  const feed: FeedItem[] = useMemo(
    () => (replaying ? replayFeed({ events, t, book }) : liveFeed({ actors: live.actors, events, now, book, selfId })),
    [replaying, events, t, book, live.actors, now, selfId],
  );
  const working: MapActor[] = useMemo(
    () => (replaying ? actorsAt(events, t, REPLAY_IDLE_MS[replay.range]) : live.actors.filter((a) => !a.self)),
    [replaying, events, t, live.actors, replay?.range],
  );
  const crossRows: CrossMoveRow[] = useMemo(
    () => (scope === "all" && many ? crossMoveRows(events, replaying ? replay.from : todayFrom, t, book) : []),
    [scope, many, events, replaying, replay?.from, todayFrom, t, book],
  );
  const bars = useMemo(
    () => (replaying ? histogram(events, replay.from, replay.to, HISTOGRAM_BARS) : []),
    [replaying, events, replay?.from, replay?.to],
  );
  const moments = useMemo(
    () => (replaying ? momentsOf(events, (ws, path) => book.title(ws, path)).filter((m) => m.at >= replay.from && m.at <= replay.to) : []),
    [replaying, events, book, replay?.from, replay?.to],
  );

  // The engine reports the playhead every frame; the bar redraws ten times a second.
  const lastTick = useRef(0);
  const onTime = useCallback((at: number) => {
    const wall = Date.now();
    if (wall - lastTick.current < 100) return;
    lastTick.current = wall;
    dispatch({ type: "tick", at });
  }, []);

  const followActor = useCallback((id: string | null) => {
    engineRef.current?.follow(id);
    if (id === null) setFollow(null);
  }, []);

  return {
    data: mapData,
    workspaces: all,
    selected,
    many,
    scope,
    setScope,
    view,
    setView,
    mode,
    setMode,
    replay,
    replaying,
    dispatch,
    onTime,
    graphs,
    live,
    events,
    feed,
    working,
    workingLine: workingNowLine(working, replaying),
    crossRows,
    bars,
    moments,
    book,
    now,
    t,
    follow,
    setFollow,
    followActor,
    engineRef,
    reducedMotion,
    historyLoading: mode !== "live" && history === null,
  };
}

export type MapPageState = ReturnType<typeof useMapPage>;
