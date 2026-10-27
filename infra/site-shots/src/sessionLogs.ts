/**
 * Why a Tex browser run failed, from Browserbase's own session logs, without
 * keeping anything the page or the person said.
 *
 * Browserbase records each session's CDP traffic (network, console, page
 * loads) whether or not we ask for it; `recordSession: false` turns off only
 * the video-like replay. When a run on Browserbase fails, this reads that log
 * once (`GET /v1/sessions/{id}/logs`) and boils it down to a digest of fixed
 * shapes, which goes to this Worker's log as `site_shots_browse_failed`:
 *
 * - CDP method names and how often each came (the protocol's words, not the page's)
 * - failed responses as `{ host, status, n }`: the host only, never a path or a
 *   query, which can carry a search, an email address or a note's name
 * - `net::ERR_*` codes for requests that never answered
 * - how many console errors and uncaught exceptions, never their text
 * - the hosts the tabs went to
 *
 * Nothing here returns to the gateway or the model. The session id is logged
 * with it so whoever is debugging can open that session in Browserbase's own
 * dashboard, behind Browserbase's sign-in: its live view while the browser is
 * still up (it ends five idle minutes after the run, ./idle.ts) and the full
 * log. That is the read-only live view for debugging; the debugger link itself
 * is never asked for, since whoever holds it drives the browser (./view.ts).
 */

import type { BrowserbaseEnv } from "./browserbase";

const API = "https://api.browserbase.com/v1";

/** How long a failed run waits for its log before giving up; it never delays an answer (see `later`). */
export const LOGS_TIMEOUT_MS = 5_000;
/** The most of each list a digest carries, so a noisy page cannot flood the log. */
export const DIGEST_LIMIT = 12;

export interface LogDigest {
  events: number;
  methods: Record<string, number>;
  failed: Array<{ host: string; status: number; n: number }>;
  unreachable: Record<string, number>;
  consoleErrors: number;
  exceptions: number;
  hosts: string[];
}

type Raw = Record<string, unknown>;

const METHOD = /^[A-Z][A-Za-z]{1,40}\.[a-z][A-Za-z]{1,60}$/;
const NET_ERROR = /^net::ERR_[A-Z_]{1,60}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;

/** A URL's host, and only for the web: a `data:` or `blob:` URL can hold the page itself. */
export function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return HOST.test(parsed.hostname) ? parsed.hostname : null;
  } catch {
    return null;
  }
}

/** An event's parameters, wherever this entry keeps them. */
function paramsOf(entry: Raw): Raw {
  for (const side of [entry.request, entry.response] as unknown[]) {
    if (!side || typeof side !== "object") continue;
    const s = side as Raw;
    for (const candidate of [s.params, s.result]) if (candidate && typeof candidate === "object") return candidate as Raw;
    if (typeof s.rawBody === "string") {
      try {
        const parsed = JSON.parse(s.rawBody) as Raw;
        const inner = parsed?.params ?? parsed?.result ?? parsed;
        if (inner && typeof inner === "object") return inner as Raw;
      } catch {
        // Not JSON: nothing to read.
      }
    }
  }
  return {};
}

function top(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, DIGEST_LIMIT));
}

/** The digest of a session's log entries. Every string in it matches a fixed pattern. */
export function digestLogs(entries: unknown): LogDigest {
  const list = Array.isArray(entries) ? (entries as unknown[]) : [];
  const methods = new Map<string, number>();
  const failed = new Map<string, { host: string; status: number; n: number }>();
  const unreachable = new Map<string, number>();
  const hosts: string[] = [];
  let consoleErrors = 0;
  let exceptions = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Raw;
    const method = typeof entry.method === "string" && METHOD.test(entry.method) ? entry.method : null;
    if (method === null) continue;
    methods.set(method, (methods.get(method) ?? 0) + 1);
    const params = paramsOf(entry);
    if (method === "Network.responseReceived") {
      const response = (params.response ?? {}) as Raw;
      const status = typeof response.status === "number" ? response.status : 0;
      const host = hostOf(response.url);
      if (status >= 400 && status < 600 && host) {
        const key = `${host} ${status}`;
        const seen = failed.get(key) ?? { host, status, n: 0 };
        seen.n += 1;
        failed.set(key, seen);
      }
    } else if (method === "Network.loadingFailed") {
      const code = typeof params.errorText === "string" && NET_ERROR.test(params.errorText) ? params.errorText : "other";
      unreachable.set(code, (unreachable.get(code) ?? 0) + 1);
    } else if (method === "Runtime.consoleAPICalled") {
      if (params.type === "error" || params.type === "assert") consoleErrors += 1;
    } else if (method === "Runtime.exceptionThrown" || method === "Log.entryAdded" && (params.entry as Raw | undefined)?.level === "error") {
      exceptions += 1;
    } else if (method === "Page.frameNavigated") {
      const frame = (params.frame ?? {}) as Raw;
      const host = hostOf(frame.url);
      if (!frame.parentId && host && !hosts.includes(host) && hosts.length < DIGEST_LIMIT) hosts.push(host);
    }
  }
  return {
    events: list.length,
    methods: top(methods),
    failed: [...failed.values()].sort((a, b) => b.n - a.n).slice(0, DIGEST_LIMIT),
    unreachable: top(unreachable),
    consoleErrors,
    exceptions,
    hosts,
  };
}

/** This session's log, digested; null when Browserbase could not give it in time. */
export async function sessionLogDigest(env: BrowserbaseEnv, sessionId: string, fetcher: typeof fetch = fetch, timeoutMs = LOGS_TIMEOUT_MS): Promise<LogDigest | null> {
  try {
    const response = await fetcher(`${API}/sessions/${encodeURIComponent(sessionId)}/logs`, {
      method: "GET",
      headers: { "X-BB-API-Key": env.BROWSERBASE_API_KEY ?? "" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return digestLogs(await response.json());
  } catch {
    return null;
  }
}

export interface FailedRun {
  session: string;
  /** What failed: a step, the connection, or the run as a whole. */
  stage: "steps" | "connect" | "run";
  steps: string[];
  /** Each step's kind and, for one that failed, its reason: fixed words, never the page's (./browse.ts). */
  ran?: Array<{ do: string; ok: boolean; reason?: string }>;
  ms: number;
}

/** Logs a failed run with its session's digest. Never throws. */
export async function reportFailedRun(env: BrowserbaseEnv, run: FailedRun, fetcher: typeof fetch = fetch, log: (line: string) => void = console.log): Promise<void> {
  const logs = await sessionLogDigest(env, run.session, fetcher);
  log(JSON.stringify({ event: "site_shots_browse_failed", provider: "browserbase", ...run, logs }));
}
