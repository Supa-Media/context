import { useEffect, useMemo, useRef, useState } from "react";
import { useNow } from "../page/TexPageParts";
import { DEFAULT_SHOWN, dayAsked, historyDays, kindsFor, type DayChoice, type HistoryDay, type Show } from "./historyLines";
import type { Read, TexPageSource } from "../page/texPageSource";
import { LATEST, type LedgerEntry, type LedgerPage } from "../page/texPageTypes";
import { FALLBACK_POLL_MS } from "../page/useTexPage";

/** Patches come in bursts as a turn writes: one read for each burst. */
const LIVE_SETTLE_MS = 400;

/** What a history view reads and which filters it reads with: shared by the Tex page's lines and the history file's. */
export interface HistoryRead {
  day: DayChoice;
  setDay: (day: DayChoice) => void;
  picked: string;
  setPicked: (picked: string) => void;
  shown: Record<Show, boolean>;
  toggle: (show: Show) => void;
  /** The first page's answer, `null` while it is read. */
  read: Read<LedgerPage> | null;
  /** Nothing is asked while a day is still being typed, or with every kind off. */
  waiting: boolean;
  /** Newest day first, each day in the order it happened (`historyDays`). */
  days: HistoryDay[];
  /** More is kept before what is shown. */
  hasOlder: boolean;
  loadingMore: boolean;
  /** Reads the page before the oldest shown, and adds it. */
  more: () => Promise<void>;
}

/**
 * A chat's history read from the gateway, a page at a time, with its filters:
 * which day, and which kinds. Nothing here keeps a copy.
 */
export function useHistoryRead({ source, chat, group, job, live = false, timing = false }: { source: TexPageSource; chat: string; group: boolean; job?: string; /** Keep reading new lines as the chat goes on: the chat's live feed, or a re-read while it is down. */ live?: boolean; /** Staff: read each turn's timing too (`turnTiming.ts`). */ timing?: boolean }): HistoryRead {
  const [day, setDay] = useState<DayChoice>("today");
  const [picked, setPicked] = useState("");
  const [shown, setShown] = useState<Record<Show, boolean>>(DEFAULT_SHOWN);
  const [read, setRead] = useState<Read<LedgerPage> | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const now = new Date(useNow());
  const asked = dayAsked(day, picked, now);
  const kinds = kindsFor(shown, { timing });
  const kindsKey = kinds.join(",");
  const waiting = (day === "pick" && asked === undefined) || kinds.length === 0;
  const query = useMemo(
    () => ({ kinds: kindsKey.split(",").filter(Boolean) as typeof kinds, ...(asked ? { day: asked } : {}), ...(job !== undefined ? { job } : {}) }),
    [kindsKey, asked, job],
  );

  // A "Show older" still reading when a filter changes is dropped, never added to the new list.
  const asking = useRef(query);
  asking.current = query;

  useEffect(() => {
    let live = true;
    setRead(null);
    setEntries([]);
    if (waiting) return;
    void source.ledger(chat, { ...query, before: LATEST }).then((r) => {
      if (!live) return;
      setRead(r);
      setEntries(r.kind === "ok" ? r.value.entries : []);
    });
    return () => {
      live = false;
    };
  }, [source, chat, query, waiting]);

  // New lines as they are written (Dev, 2026-11-03: "are we making sure we are opening a websocket for realtime
  // updates?"). The chat's Tex object pushes a patch on every append to its ledger (`sectionsForKinds`); the newest
  // page is read again and what is not held yet goes in front. While the socket is down, the same read on a timer.
  useEffect(() => {
    if (!live || waiting) return;
    let alive = true;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const fresh = () => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        void source.ledger(chat, { ...query, before: LATEST }).then((r) => {
          if (!alive || r.kind !== "ok" || asking.current !== query) return;
          setEntries((kept) => {
            const held = new Set(kept.map((e) => e.id));
            const added = r.value.entries.filter((e) => !held.has(e.id));
            return added.length === 0 ? kept : [...added, ...kept].sort((a, b) => b.at - a.at);
          });
        });
      }, LIVE_SETTLE_MS);
    };
    let up = false;
    const feed = source.live(chat, () => fresh(), (isUp) => {
      if (isUp && !up) fresh();
      up = isUp;
    });
    const timer = setInterval(() => {
      if (!up && !(typeof document !== "undefined" && document.visibilityState === "hidden")) fresh();
    }, FALLBACK_POLL_MS);
    return () => {
      alive = false;
      if (pending !== null) clearTimeout(pending);
      clearInterval(timer);
      feed?.close();
    };
  }, [live, waiting, source, chat, query]);

  const older = read?.kind === "ok" ? read.value.older : undefined;
  const more = async () => {
    if (older === undefined || loadingMore) return;
    setLoadingMore(true);
    const was = query;
    const r = await source.ledger(chat, { ...query, before: older });
    setLoadingMore(false);
    if (r.kind !== "ok" || asking.current !== was) return;
    setRead(r);
    setEntries((kept) => [...kept, ...r.value.entries]);
  };

  return {
    day,
    setDay,
    picked,
    setPicked,
    shown,
    toggle: (s) => setShown((was) => ({ ...was, [s]: !was[s] })),
    read,
    waiting,
    days: historyDays(entries, now, { group, thinking: shown.thinking, fold: job === undefined, timing, tools: shown.tools }),
    hasOlder: older !== undefined && !waiting,
    loadingMore,
    more,
  };
}
