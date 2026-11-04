import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchFrame } from "./texPageLive";
import { readJobDetail, readSection } from "./texPageRead";
import type { Read, TexPageSource } from "./texPageSource";
import type { MachinesPage } from "./texMachineTypes";
import type { JobDetail, ListKind, ListPage, Overview, PageAction } from "./texPageTypes";

/** How often the page re-reads while its socket is down and it is visible. */
export const FALLBACK_POLL_MS = 30_000;

export type Phase = "loading" | "ready" | "failed" | "notYours";

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
}

const LIST_KINDS = new Set(["routines", "checkins", "about", "settings", "advisor", "mailcheck", "jobs", "thinking", "machines"]);

const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** The overview for one chat, kept live by the socket, and a re-read on a timer while the socket is down. */
export function useTexPage(source: TexPageSource | null, chat: string): TexPageState {
  const [phase, setPhase] = useState<Phase>("loading");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [live, setLive] = useState(false);
  const versions = useRef(new Map<string, number>());
  const listeners = useRef(new Set<() => void>());
  const jobs = useRef(new Map<string, JobDetail>());
  const epoch = useRef(0);

  const bump = useCallback((key: string) => {
    versions.current.set(key, (versions.current.get(key) ?? 0) + 1);
    for (const fn of listeners.current) fn();
  }, []);

  const load = useCallback(async () => {
    if (source === null) return;
    const mine = epoch.current;
    const read = await source.overview(chat);
    if (mine !== epoch.current) return;
    if (read.kind === "ok") {
      setOverview(read.value);
      setPhase("ready");
    } else if (read.kind === "notYours") {
      setOverview(null);
      setPhase("notYours");
    } else {
      setPhase((was) => (was === "ready" ? was : "failed"));
    }
  }, [chat, source]);

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
      setOverview((was) => (was === null ? was : (readSection(was, patch.section, patch.value) ?? was)));
      if (patch.section === "thinking") bump("thinking");
      if (patch.section === "earlier") bump("jobs");
    },
    [bump, load],
  );

  useEffect(() => {
    epoch.current += 1;
    setPhase("loading");
    setOverview(null);
    jobs.current.clear();
    if (source === null) return;
    void load();
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
      clearInterval(timer);
      feed?.close();
      setLive(false);
    };
  }, [chat, load, onPatch, source]);

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
  return { phase, overview, live, changes, act, jobPatch };
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
export function useTexMachines(source: TexPageSource | null, chat: string, changes: Changes): Read<MachinesPage> | null {
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
  }, [chat, source, version]);
  return read;
}
