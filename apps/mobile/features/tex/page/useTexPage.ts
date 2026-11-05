import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchFrame } from "./texPageLive";
import { keepOverview, keptOverview } from "./texPageMemory";
import { readJobDetail, readSection } from "./texPageRead";
import type { Read, TexPageSource } from "./texPageSource";
import type { MachinesPage } from "./texMachineTypes";
import type { JobDetail, ListKind, ListPage, Overview, PageAction } from "./texPageTypes";

/** How often the page re-reads while its socket is down and it is visible. */
export const FALLBACK_POLL_MS = 30_000;

/** How long a tile shows its loading bar before it gives up and shows its title alone. */
export const TILES_WAIT_MS = 4_000;

export type Phase = "loading" | "ready" | "failed" | "notYours";

/**
 * What the five tiles can say yet. The page draws before they are read
 * (the owner, 2026-11-04: "tiles loaded beside the page"): a tile whose line
 * is not known shows a bar while `waiting`, then its title alone. Tex's
 * computer is known only from a fresh read, never from a kept copy.
 */
export interface TilesKnown {
  lines: boolean;
  computer: boolean;
  waiting: boolean;
}

/** Every live change, so each open view re-reads only what it shows. */
export interface Changes {
  /** Bumped per list kind and per job id. */
  version: (key: string) => number;
  subscribe: (fn: () => void) => () => void;
}

export interface TexPageState {
  phase: Phase;
  overview: Overview | null;
  live: boolean;
  changes: Changes;
  /** Do something on the page, then re-read what it touched. */
  act: (action: PageAction) => Promise<{ ok: boolean; error?: string }>;
  /** A job page's live copy, when a patch carried one. */
  jobPatch: (id: string) => JobDetail | null;
  tiles: TilesKnown;
}

const LIST_KINDS = new Set(["routines", "checkins", "about", "settings", "advisor", "mailcheck", "jobs", "thinking", "machines"]);

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

const NOTHING_KNOWN: TilesKnown = { lines: false, computer: false, waiting: true };

/**
 * The overview for one chat, kept live by the socket, and a re-read on a timer while the socket is down.
 * `handle` keys the copy kept for coming back (`texPageMemory.ts`); without it nothing is kept.
 */
export function useTexPage(source: TexPageSource | null, chat: string, handle?: string): TexPageState {
  const [phase, setPhase] = useState<Phase>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tiles, setTiles] = useState<TilesKnown>(NOTHING_KNOWN);
  /** What the page shows now, and the tiles' last fresh read (which may land before the first screen). */
  const latest = useRef<Overview | null>(null);
  const freshTiles = useRef<Overview["tiles"] | null>(null);
  const [live, setLive] = useState(false);
  const versions = useRef(new Map<string, number>());
  const listeners = useRef(new Set<() => void>());
  const jobs = useRef(new Map<string, JobDetail>());
  const epoch = useRef(0);

  const bump = useCallback((key: string) => {
    versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    for (const fn of listeners.current) fn();
  }, []);

  /** Sets the page and keeps it for coming back. */
  const show = useCallback(
    (next: Overview) => {
      latest.current = next;
      setOverview(next);
      if (handle) keepOverview(handle, chat, next);
    },
    [chat, handle],
  );

  // The first screen and the tiles are read side by side, and each is drawn as it lands: the tiles' reads
  // (routines, About, Tex's browser) are the slow ones, and the page no longer waits for them.
  const load = useCallback(async () => {
    if (source === null) return;
    const mine = epoch.current;
    const core = source.overview(chat, "core").then((read) => {
      if (mine !== epoch.current) return;
      if (read.kind === "ok") {
        show({ ...read.value, tiles: freshTiles.current ?? latest.current?.tiles ?? read.value.tiles });
        setPhase("ready");
      } else if (read.kind === "notYours") {
        latest.current = null;
        setOverview(null);
        setPhase("notYours");
      } else {
        setPhase((was) => (was === "ready" ? was : "failed"));
      }
    });
    const tileRead = source.overview(chat, "tiles").then((read) => {
      if (mine !== epoch.current || read.kind !== "ok") return;
      // Before the first screen lands, the tiles wait for it.
      freshTiles.current = read.value.tiles;
      if (latest.current !== null) show({ ...latest.current, tiles: read.value.tiles });
      setTiles({ lines: true, computer: true, waiting: false });
    });
    await Promise.all([core, tileRead]);
  }, [chat, show, source]);

  const onPatch = useCallback(
    (patch: PatchFrame) => {
      if (patch.section === "job") {
        const job = readJobDetail(patch.value);
        if (job) {
          jobs.current.set(job.id, job);
          bump(`job:${job.id}`);
        }
        // The home page's job parts (status, minions, earlier) come as their own patches with values:
        // re-reading the whole page here would cost a full read every poll while a job runs.
        bump("jobs");
        return;
      }
      if (LIST_KINDS.has(patch.section)) {
        bump(patch.section);
        void load();
        return;
      }
      if (patch.value === undefined) return void load();
      const was = latest.current;
      if (was !== null) show(readSection(was, patch.section, patch.value) ?? was);
      if (patch.section === "thinking") bump("thinking");
      if (patch.section === "earlier") bump("jobs");
    },
    [bump, load, show],
  );

  useEffect(() => {
    epoch.current += 1;
    jobs.current.clear();
    // Coming back draws the last copy at once, and reads again behind it.
    const kept = handle ? keptOverview(handle, chat) : null;
    latest.current = kept;
    freshTiles.current = null;
    setOverview(kept);
    setPhase(kept !== null ? "ready" : "loading");
    setTiles(kept !== null ? { lines: true, computer: false, waiting: true } : NOTHING_KNOWN);
    if (source === null) return;
    void load();
    const giveUp = setTimeout(() => setTiles((was) => (was.waiting ? { ...was, waiting: false } : was)), TILES_WAIT_MS);
    let socketUp = false;
    const feed = source.live(chat, onPatch, (up) => {
      // Coming back up: anything missed while down is read once.
      if (up && !socketUp) void load();
      socketUp = up;
      setLive(up);
    });
    const timer = setInterval(() => {
      if (!socketUp && !hidden()) void load();
    }, FALLBACK_POLL_MS);
    return () => {
      clearTimeout(giveUp);
      clearInterval(timer);
      feed?.close();
      setLive(false);
    };
  }, [chat, handle, load, onPatch, source]);

  const changes = useMemo<Changes>(
    () => ({
      version: (key) => versions.current.get(key) ?? 0,
      subscribe: (fn) => {
        listeners.current.add(fn);
        return () => {
          listeners.current.delete(fn);
        };
      },
    }),
    [],
  );

  const act = useCallback(
    async (action: PageAction) => {
      if (source === null) return { ok: false, error: "no_source" };
      const answer = await source.act(chat, action);
      const touched = action.type.split(".")[0]!;
      const kind = touched === "machine" || action.type === "job.allow" ? "machines" : touched === "group" ? "settings" : touched === "steer" || touched === "stop" || touched === "report" ? "jobs" : touched === "checkin" ? "checkins" : touched === "routine" ? "routines" : touched;
      bump(kind);
      if ("job" in action) bump(`job:${action.job}`);
      void load();
      return answer;
    },
    [bump, chat, load, source],
  );

  const jobPatch = useCallback((id: string) => jobs.current.get(id) ?? null, []);
  return { phase, overview, live, changes, act, jobPatch, tiles };
}

/** Re-renders when any of `keys` changes live. */
function useVersion(changes: Changes, keys: readonly string[]): number {
  const [, force] = useState(0);
  useEffect(() => changes.subscribe(() => force((n) => n + 1)), [changes]);
  return keys.reduce((sum, k) => sum + changes.version(k), 0);
}

/** One list page (routines, check-ins, ...), re-read whenever it changes live. */
export function useTexList<K extends ListKind>(
  source: TexPageSource | null,
  chat: string,
  kind: K,
  changes: Changes,
): { read: Read<ListPage<K>> | null; more: () => Promise<void> } {
  const [read, setRead] = useState<Read<ListPage<K>> | null>(null);
  const version = useVersion(changes, [kind]);
  useEffect(() => {
    let stale = false;
    if (source === null) return;
    void source.list(chat, kind).then((r) => {
      if (!stale) setRead(r);
    });
    return () => {
      stale = true;
    };
  }, [chat, kind, source, version]);
  const more = useCallback(async () => {
    if (source === null || read?.kind !== "ok" || !read.value.cursor) return;
    const next = await source.list(chat, kind, read.value.cursor);
    if (next.kind !== "ok") return;
    setRead({ kind: "ok", value: { ...next.value, items: [...read.value.items, ...next.value.items] } });
  }, [chat, kind, read, source]);
  return { read, more };
}

/** One job's page, re-read when it changes live; a patch that carries the job is used as is. */
export function useTexJob(
  source: TexPageSource | null,
  chat: string,
  id: string,
  state: Pick<TexPageState, "changes" | "jobPatch">,
): Read<JobDetail> | null {
  const [read, setRead] = useState<Read<JobDetail> | null>(null);
  const version = useVersion(state.changes, [`job:${id}`]);
  const patched = state.jobPatch(id);
  useEffect(() => {
    let stale = false;
    if (source === null) return;
    if (patched) {
      setRead({ kind: "ok", value: patched });
      return;
    }
    void source.job(chat, id).then((r) => {
      if (!stale) setRead(r);
    });
    return () => {
      stale = true;
    };
    // `patched` is read through `version`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, id, source, version]);
  return read;
}

/**
 * The person's machines as this chat sees them, re-read whenever they change
 * live or an action touches them. `null` until the first answer; `notYours`
 * is also what a gateway without machines answers, and reads as "no machines
 * here", never as an error.
 */
/** `again` reads once more each time it changes, for a screen waiting on a computer (a sign-in under way). */
export function useTexMachines(source: TexPageSource | null, chat: string, changes: Changes, again = 0): Read<MachinesPage> | null {
  const [read, setRead] = useState<Read<MachinesPage> | null>(null);
  const version = useVersion(changes, ["machines"]);
  useEffect(() => {
    let stale = false;
    if (source === null) return;
    void source.machines(chat).then((r) => {
      if (!stale) setRead(r);
    });
    return () => {
      stale = true;
    };
  }, [again, chat, source, version]);
  return read;
}
