/**
 * The notes with mail the reader may see, for the Mail page and the rail's new-mail dot, through the gateway's
 * `/files/mail` with the console grant (`apps/mcp/src/live/mailNotesRoute.js`). One answer per workspace is shared by
 * every caller and asked again every `MAIL_REFRESH_MS`, or at once when the page opens.
 *
 * What the reader has seen is remembered on this device only, as the newest message's time per note: a per-viewer
 * convenience, never shared and never relied on (it can come back empty).
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../placeholderData";
import { SINCE, type MailNoteRow, type Seen } from "./model";
import type { MailRead } from "./receipts";

/** How often an open console asks again for the mail. */
export const MAIL_REFRESH_MS = 2 * 60_000;
const TIMEOUT_MS = 15_000;
const SEEN_KEY = "context.mailSeen";

/** The gateway's `/files/mail` address beside the MCP endpoint, or null for one this build cannot reach. */
export function mailNotesUrl(mcpEndpoint: string): string | null {
  try {
    const parsed = new URL(mcpEndpoint);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return `${parsed.origin}/files/mail`;
  } catch {
    return null;
  }
}

/** Each sender's signed app, the strings only. */
function appsOf(raw: unknown): Record<string, string> {
  const apps: Record<string, string> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return apps;
  for (const [name, app] of Object.entries(raw as Record<string, unknown>)) if (typeof app === "string") apps[name] = app;
  return apps;
}

/** One conversation's receipts as `/files/mail` `{read}` answers them, or null for a body this build cannot read. */
export function mailReadsAnswer(body: unknown): MailRead[] | null {
  if (!body || typeof body !== "object") return null;
  const { kind, reads } = body as Record<string, unknown>;
  if (kind !== "mailReads" || !Array.isArray(reads)) return null;
  const out: MailRead[] = [];
  for (const read of reads) {
    if (!read || typeof read !== "object") continue;
    const { name, by, clientName, at } = read as Record<string, unknown>;
    if ((by !== "person" && by !== "ai") || typeof at !== "string") continue;
    out.push({ name: typeof name === "string" ? name : null, by, clientName: typeof clientName === "string" ? clientName : null, at });
  }
  return out;
}

/** The answer's rows, or null for a body this build cannot read. */
export function mailNotesAnswer(body: unknown): { notes: MailNoteRow[]; complete: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const { kind, notes, complete } = body as Record<string, unknown>;
  if (kind !== "mailNotes" || !Array.isArray(notes)) return null;
  const rows: MailNoteRow[] = [];
  for (const note of notes) {
    if (!note || typeof note !== "object") return null;
    const { path, count, joined, apps, last } = note as Record<string, unknown>;
    if (typeof path !== "string" || typeof count !== "number") return null;
    const said = last && typeof last === "object" ? (last as Record<string, unknown>) : null;
    rows.push({
      path,
      count,
      joined: Array.isArray(joined) ? joined.filter((name): name is string => typeof name === "string") : [],
      apps: appsOf(apps),
      last:
        said !== null && typeof said.at === "string" && typeof said.from === "string"
          ? { at: said.at, from: said.from, to: typeof said.to === "string" ? said.to : null, used: typeof said.used === "number" ? said.used : null, text: typeof said.text === "string" ? said.text : "" }
          : null,
    });
  }
  return { notes: rows, complete: complete === true };
}

/** The Mail page's notes: one ask of `/files/mail` with the console grant. */
export async function mailNotesThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{ notes: MailNoteRow[]; complete: boolean } | typeof NOT_SERVED | null> {
  const answer = await askMailGatewayFor({ ...options, body: {} });
  if (answer?.status === 409 && (answer.body as { error?: unknown } | null)?.error === "not_object") return NOT_SERVED;
  return answer?.status === 200 ? mailNotesAnswer(answer.body) : null;
}

/** The gateway's word that this workspace's mail is not gathered in one place yet (`not_object`): asking again soon will not change it. */
export const NOT_SERVED = "not_served" as const;

/** One ask of `/files/mail` with the console grant, its 200 answer's body or null: refused once, re-minted once, never a loop. */
export async function askMailGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<unknown | null> {
  const answer = await askMailGatewayFor(options);
  return answer?.status === 200 ? answer.body : null;
}

/** As `askMailGateway`, with the status: `{status, body}` of the last answer, or null where none came. */
async function askMailGatewayFor(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  body: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: unknown } | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const send = async (token: string) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(options.body),
        ...(abort === null ? {} : { signal: abort.signal }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return null;
    } finally {
      clearTimeout(deadline);
    }
  };
  let token: string;
  try {
    token = await options.token(false);
  } catch {
    return null;
  }
  let answer = await send(token);
  if (answer?.status === 401) {
    try {
      token = await options.token({ rejected: token });
    } catch {
      return null;
    }
    answer = await send(token);
  }
  return answer;
}

/**
 * `unavailable`: no answer yet. `retrying` when the ask failed on the way (a deploy, a slow answer, the network), which
 * is asked again soon (`RETRY_MS`); not when the gateway said this workspace's mail is not gathered (`NOT_SERVED`).
 */
export type MailState = { readonly status: "loading" } | { readonly status: "unavailable"; readonly retrying: boolean } | { readonly status: "ready"; readonly notes: readonly MailNoteRow[]; readonly complete: boolean };

/** One workspace's answer, shared by every caller. */
interface Entry {
  state: MailState;
  at: number;
  /** Failed asks in a row with no answer yet, for the next retry's wait. */
  failures: number;
  retry: ReturnType<typeof setTimeout> | null;
  asking: Promise<void> | null;
  listeners: Set<() => void>;
}
const entries = new Map<string, Entry>();
const LOADING: MailState = { status: "loading" };

function entryOf(workspaceId: string): Entry {
  let entry = entries.get(workspaceId);
  if (entry === undefined) {
    entry = { state: LOADING, at: 0, failures: 0, retry: null, asking: null, listeners: new Set() };
    entries.set(workspaceId, entry);
  }
  return entry;
}

/** Forgets every answer (tests, and signing out). */
export function forgetMail(): void {
  for (const entry of entries.values()) if (entry.retry !== null) clearTimeout(entry.retry);
  entries.clear();
  seenStores.clear();
}

/** Where the notes come from in place of the gateway: a fixture's. */
export type MailLoad = () => Promise<{ notes: MailNoteRow[]; complete: boolean } | typeof NOT_SERVED | null>;

/**
 * How long to wait before asking again after a failed ask that left no answer to show, by failures in a row. Two
 * minutes (`MAIL_REFRESH_MS`) was the only wait, so one failed ask while a deploy rolled out left the page saying mail
 * could not be gathered for minutes after the gateway was back (Dev, 2026-11-27: "all the sudden agentmail stopped
 * working?", then "it came back all the sudden").
 */
export const RETRY_MS = [5_000, 15_000, 30_000, 60_000] as const;

/** The state after one ask: the answer, else what was shown, else unavailable (retrying unless not served). */
export function nextMailState(
  was: MailState,
  answer: { notes: MailNoteRow[]; complete: boolean } | typeof NOT_SERVED | null,
): MailState {
  if (answer !== null && answer !== NOT_SERVED) return { status: "ready", ...answer };
  if (was.status === "ready") return was;
  return { status: "unavailable", retrying: answer === null };
}

/** The workspace's notes with mail, asked when `active` and again every `MAIL_REFRESH_MS`; `refresh` asks now. */
export function useMailNotes(workspaceId: string | null, active: boolean, load?: MailLoad): { state: MailState; refresh: () => void } {
  const grant = useConsoleGrant();
  const mint = useRef(grant);
  mint.current = grant;
  const ask = useCallback(
    (force: boolean) => {
      if (workspaceId === null) return;
      const entry = entryOf(workspaceId);
      if (entry.asking !== null || (!force && Date.now() - entry.at < MAIL_REFRESH_MS)) return;
      const url = mailNotesUrl(MCP_ENDPOINT);
      if (url === null && load === undefined) return;
      const token = async (refresh: false | { rejected: string }) => (await mint.current({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken;
      entry.asking = (load !== undefined ? load() : mailNotesThroughGateway({ url: url!, token }))
        .catch(() => null)
        .then((answer) => {
          entry.state = nextMailState(entry.state, answer);
          entry.failures = entry.state.status === "unavailable" && entry.state.retrying ? entry.failures + 1 : 0;
        })
        .finally(() => {
          entry.at = Date.now();
          entry.asking = null;
          if (entry.retry !== null) clearTimeout(entry.retry);
          entry.retry = null;
          // Nothing to show yet and the ask failed on the way: ask again soon rather than at the next refresh.
          if (entry.failures > 0) {
            entry.retry = setTimeout(() => {
              entry.retry = null;
              if (entry.listeners.size > 0) ask(true);
            }, RETRY_MS[Math.min(entry.failures, RETRY_MS.length) - 1]);
          }
          for (const listener of [...entry.listeners]) listener();
        });
    },
    [workspaceId, load],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      if (workspaceId === null) return () => {};
      const entry = entryOf(workspaceId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [workspaceId],
  );
  const read = useCallback(() => (workspaceId === null ? LOADING : entryOf(workspaceId).state), [workspaceId]);
  const state = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (!active) return;
    ask(false);
    const timer = setInterval(() => ask(false), MAIL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, ask]);
  return { state, refresh: useCallback(() => ask(true), [ask]) };
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

function readSeen(workspaceId: string): Map<string, string> {
  try {
    const raw = storage()?.getItem(`${SEEN_KEY}\u001f${workspaceId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
  } catch {
    return new Map();
  }
}

const seenStores = new Map<string, { seen: Map<string, string>; listeners: Set<() => void> }>();

function seenStore(workspaceId: string) {
  let store = seenStores.get(workspaceId);
  if (store === undefined) {
    const seen = readSeen(workspaceId);
    // The first look on this device: what was already there is not news, only what comes after it.
    if (!seen.has(SINCE)) {
      seen.set(SINCE, new Date().toISOString());
      try {
        storage()?.setItem(`${SEEN_KEY}\u001f${workspaceId}`, JSON.stringify(Object.fromEntries(seen)));
      } catch {
        // Kept for this visit only.
      }
    }
    store = { seen, listeners: new Set() };
    seenStores.set(workspaceId, store);
  }
  return store;
}

const NONE_SEEN: Seen = new Map();

/** What the reader has seen of each note's mail on this device, shared by the page and the rail, and a way to mark one read. */
export function useMailSeen(workspaceId: string | null): { seen: Seen; markSeen: (path: string, at: string) => void } {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (workspaceId === null) return () => {};
      const store = seenStore(workspaceId);
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    [workspaceId],
  );
  const read = useCallback(() => (workspaceId === null ? NONE_SEEN : seenStore(workspaceId).seen), [workspaceId]);
  const seen = useSyncExternalStore(subscribe, read, read);
  const markSeen = useCallback(
    (path: string, at: string) => {
      if (workspaceId === null) return;
      const store = seenStore(workspaceId);
      if ((store.seen.get(path) ?? "") >= at) return;
      store.seen = new Map(store.seen).set(path, at);
      try {
        storage()?.setItem(`${SEEN_KEY}\u001f${workspaceId}`, JSON.stringify(Object.fromEntries(store.seen)));
      } catch {
        // A private window: the dot simply stays until the next look.
      }
      for (const listener of [...store.listeners]) listener();
    },
    [workspaceId],
  );
  return { seen, markSeen };
}
