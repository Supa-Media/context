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

/** The answer's rows, or null for a body this build cannot read. */
export function mailNotesAnswer(body: unknown): { notes: MailNoteRow[]; complete: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const { kind, notes, complete } = body as Record<string, unknown>;
  if (kind !== "mailNotes" || !Array.isArray(notes)) return null;
  const rows: MailNoteRow[] = [];
  for (const note of notes) {
    if (!note || typeof note !== "object") return null;
    const { path, count, joined, last } = note as Record<string, unknown>;
    if (typeof path !== "string" || typeof count !== "number") return null;
    const said = last && typeof last === "object" ? (last as Record<string, unknown>) : null;
    rows.push({
      path,
      count,
      joined: Array.isArray(joined) ? joined.filter((name): name is string => typeof name === "string") : [],
      last:
        said !== null && typeof said.at === "string" && typeof said.from === "string"
          ? { at: said.at, from: said.from, to: typeof said.to === "string" ? said.to : null, used: typeof said.used === "number" ? said.used : null, text: typeof said.text === "string" ? said.text : "" }
          : null,
    });
  }
  return { notes: rows, complete: complete === true };
}

/** One ask with the console grant: refused once, re-minted once, never a loop. */
export async function mailNotesThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<{ notes: MailNoteRow[]; complete: boolean } | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const send = async (token: string) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
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
  return answer?.status === 200 ? mailNotesAnswer(answer.body) : null;
}

export type MailState = { readonly status: "loading" } | { readonly status: "unavailable" } | { readonly status: "ready"; readonly notes: readonly MailNoteRow[]; readonly complete: boolean };

/** One workspace's answer, shared by every caller. */
interface Entry {
  state: MailState;
  at: number;
  asking: Promise<void> | null;
  listeners: Set<() => void>;
}
const entries = new Map<string, Entry>();
const LOADING: MailState = { status: "loading" };

function entryOf(workspaceId: string): Entry {
  let entry = entries.get(workspaceId);
  if (entry === undefined) {
    entry = { state: LOADING, at: 0, asking: null, listeners: new Set() };
    entries.set(workspaceId, entry);
  }
  return entry;
}

/** Forgets every answer (tests, and signing out). */
export function forgetMail(): void {
  entries.clear();
  seenStores.clear();
}

/** Where the notes come from in place of the gateway: a fixture's. */
export type MailLoad = () => Promise<{ notes: MailNoteRow[]; complete: boolean } | null>;

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
        .then((answer) => {
          entry.state = answer === null ? (entry.state.status === "ready" ? entry.state : { status: "unavailable" }) : { status: "ready", ...answer };
        })
        .finally(() => {
          entry.at = Date.now();
          entry.asking = null;
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
