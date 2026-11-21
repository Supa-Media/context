/**
 * The wire between a note's comments and the gateway's headless note run, and
 * the log's read of `GET /tex/note-runs`. Pure apart from `fetch`: no React, no
 * editor state, so every rule here is pinned by `__tests__/texNoteRun.test.ts`.
 *
 * ## Fields are named, never spread
 *
 * A stream line and a log row carry more than the page should draw. Each field
 * kept here is read by name, so a field the server adds later stays off the
 * page until somebody decides it belongs there.
 *
 * ## Failures are values, never throws
 *
 * A run the person started cannot throw into the editor. Every failure reaches
 * the thread as an `error` event with a sentence a person can read, and a run
 * that ends without `done` or `error` is said to have stopped.
 */

import type { GrantRefresh } from "../../../../agent/consoleGrantCache";
import { texInNoteHost, type NoteRunEvent, type NoteRunRequest, type NoteRunRow, type TexInNoteHost } from "./contract";
import type { Extension } from "@codemirror/state";

/** The mint the console gives: a token for one workspace, refreshed once when the gateway refused it. */
export type NoteRunMint = (refresh: GrantRefresh) => Promise<string>;

export const UNREACHABLE_RUN = "Couldn't reach Tex. Check your connection.";
export const STOPPED_RUN = "Tex stopped before finishing.";
export const UNREADABLE_LINE = "Tex sent something this app can't read.";
export const READ_FAILED = "Tex's log for this note can't be read.";
const FORBIDDEN_RUN = "You can't ask Tex about this note.";
const FORBIDDEN_READ = "You can't read Tex's log for this note.";

/** The route for a path under the MCP endpoint's origin. The grant names the workspace, so no path is kept from the endpoint. */
function routeOf(mcpEndpoint: string, path: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}${path}`;
}

/** `POST` target for a note run, derived from the MCP endpoint the console shows. */
export function noteRunEndpoint(mcpEndpoint: string): string | null {
  return routeOf(mcpEndpoint, "/tex/note-run");
}

/** `GET` target for the note's log, derived from the MCP endpoint the console shows. */
export function noteRunsEndpoint(mcpEndpoint: string): string | null {
  return routeOf(mcpEndpoint, "/tex/note-runs");
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const NONEMPTY = /\S/;

/** The sentence for a refused request, from the server's own `error` when it is short enough to show. */
export function refusalSentence(status: number, body: unknown, forbidden: string = FORBIDDEN_RUN): string {
  const message = objectOf(body)?.error;
  if (typeof message === "string" && NONEMPTY.test(message) && message.length < 200) return message;
  if (status === 400) return "Tex couldn't read this request.";
  if (status === 401 || status === 403) return forbidden;
  if (status === 429) return "Tex is busy. Try again in a minute.";
  if (status === 503) return "Tex isn't available right now.";
  return "Tex didn't answer. Try again.";
}

/**
 * Lines of an NDJSON body, parsed. A blank line is skipped. A line that is not
 * JSON ends the read with one `error` object (`UNREADABLE_LINE`), so nothing
 * after it is shown as if the stream were whole.
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      rest += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      if (chunk.done) {
        parts.push(rest);
        rest = "";
      }
      for (const part of parts) {
        const text = part.trim();
        if (text === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          yield { type: "error", message: UNREADABLE_LINE };
          return;
        }
        yield value;
      }
      if (chunk.done) return;
    }
  } finally {
    // Frees the connection when the reader stops early; a finished stream ignores it.
    reader.cancel().catch(() => undefined);
  }
}

/**
 * One stream line as an event, or `null` when this build does not draw it.
 * Known types with a missing or mistyped field are dropped whole; an unknown
 * type is dropped, so a newer gateway's extra events do not break the run.
 */
export function parseEvent(raw: unknown): NoteRunEvent | null {
  const record = objectOf(raw);
  if (record === null) return null;
  switch (record.type) {
    case "step": {
      const { id, label, state } = record;
      if (typeof id !== "string" || typeof label !== "string" || (state !== "running" && state !== "done")) return null;
      const event: Extract<NoteRunEvent, { type: "step" }> = { type: "step", id, label, state };
      if (typeof record.ms === "number" && Number.isFinite(record.ms)) event.ms = record.ms;
      if (typeof record.source === "string") event.source = record.source;
      return event;
    }
    case "answer":
      return typeof record.text === "string" ? { type: "answer", text: record.text } : null;
    case "edit":
      return typeof record.replace === "string" ? { type: "edit", replace: record.replace } : null;
    case "done": {
      if (typeof record.runId !== "string") return null;
      const sources = Array.isArray(record.sources) ? record.sources.filter((s): s is string => typeof s === "string") : [];
      return { type: "done", runId: record.runId, sources };
    }
    case "error":
      return typeof record.message === "string" ? { type: "error", message: record.message } : null;
    default:
      return null;
  }
}

/** Sends a request with the grant, and once more with a fresh one when the gateway refused the token. */
async function withGrant(mint: NoteRunMint, send: (token: string) => Promise<Response>): Promise<Response> {
  const token = await mint(false);
  const first = await send(token);
  if (first.status !== 401 && first.status !== 403) return first;
  return send(await mint({ rejected: token }));
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export interface NoteRunOptions {
  route: string;
  mint: NoteRunMint;
  request: NoteRunRequest;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * Run Tex on a note and yield what it does, in order. Ends after `done` or
 * `error`, never throws, and stops silently when `signal` aborts.
 */
export async function* runNoteRun(options: NoteRunOptions): AsyncGenerator<NoteRunEvent> {
  const { route, mint, request, signal } = options;
  const fetchImpl: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);
  if (signal.aborted) return;
  let response: Response;
  try {
    response = await withGrant(mint, (token) =>
      fetchImpl(route, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      }),
    );
  } catch {
    if (signal.aborted) return;
    yield { type: "error", message: UNREACHABLE_RUN };
    return;
  }
  if (!response.ok) {
    const body = await jsonOf(response);
    if (signal.aborted) return;
    yield { type: "error", message: refusalSentence(response.status, body) };
    return;
  }
  if (response.body === null) {
    yield { type: "error", message: STOPPED_RUN };
    return;
  }
  let finished = false;
  try {
    for await (const raw of readNdjson(response.body)) {
      if (signal.aborted) return;
      const event = parseEvent(raw);
      if (event === null) continue;
      yield event;
      if (event.type === "done" || event.type === "error") {
        finished = true;
        break;
      }
    }
  } catch {
    if (signal.aborted) return;
    yield { type: "error", message: UNREACHABLE_RUN };
    return;
  }
  if (finished || signal.aborted) return;
  yield { type: "error", message: STOPPED_RUN };
}

/** One row of the log, every field by name. `null` when a required one is missing or mistyped. */
export function noteRunRowFrom(raw: unknown): NoteRunRow | null {
  const record = objectOf(raw);
  if (record === null) return null;
  const { runId, who, ask, out, at } = record;
  if (typeof runId !== "string" || runId === "" || typeof who !== "string" || typeof ask !== "string") return null;
  if (typeof out !== "string" || typeof at !== "string") return null;
  const sources = Array.isArray(record.sources) ? record.sources.filter((s): s is string => typeof s === "string") : [];
  // Anything but an explicit `false` is drawn as private: the line that says so is the safer one to be wrong on.
  return { runId, who, ask, out, sources, at, private: record.private !== false };
}

export interface NoteRunsOptions {
  /** The `noteRunsEndpoint` route. */
  route: string;
  mint: NoteRunMint;
  workspace: string;
  noteId: string;
  /** The note's path; the route resolves the note from it when `noteId` is "". */
  path?: string;
  fetchImpl?: typeof fetch;
}

/** The note's log: its rows, or a sentence for why they could not be read. Never throws. */
export async function fetchNoteRuns(options: NoteRunsOptions): Promise<NoteRunRow[] | { error: string; off?: true }> {
  const fetchImpl: typeof fetch = (input, init) => (options.fetchImpl ?? globalThis.fetch)(input, init);
  const url = `${options.route}?workspace=${encodeURIComponent(options.workspace)}&noteId=${encodeURIComponent(options.noteId)}${options.path === undefined ? "" : `&path=${encodeURIComponent(options.path)}`}`;
  let response: Response;
  try {
    response = await withGrant(options.mint, (token) =>
      fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }),
    );
  } catch {
    return { error: UNREACHABLE_RUN };
  }
  if (!response.ok) {
    const sentence = refusalSentence(response.status, await jsonOf(response), FORBIDDEN_READ);
    // A gateway without the route (404) or with Tex in notes switched off
    // (503) means Tex is not offered in notes at all: the editor hides its
    // button rather than offering a run that can only fail.
    return response.status === 404 || response.status === 503 ? { error: sentence, off: true } : { error: sentence };
  }
  const list = objectOf(await jsonOf(response))?.runs;
  if (!Array.isArray(list)) return { error: READ_FAILED };
  const rows: NoteRunRow[] = [];
  for (const raw of list) {
    const row = noteRunRowFrom(raw);
    // One unreadable row fails the read: a half-read log is not shown as the whole of it.
    if (row === null) return { error: READ_FAILED };
    rows.push(row);
  }
  return rows;
}

/** The empty log's sentence, with the shortcut named for the platform. */
export function emptyLogSentence(mac: boolean): string {
  const key = mac ? "⌘L" : "Ctrl+L";
  return `Highlight text and choose Ask Tex, or press ${key} at your cursor. Runs here stay with the note and never land in your Tex chat.`;
}

/**
 * A host that forwards to whichever host `read` names now. The editor installs
 * it once, so a host that arrives or changes later is seen without a rebuild;
 * with no host, every method answers as an absent Tex would.
 */
export function forwardingHost(read: () => TexInNoteHost | null | undefined): TexInNoteHost {
  return {
    async *run(request, signal) {
      const host = read();
      if (host === null || host === undefined) {
        yield { type: "error", message: "Tex isn't available right now." };
        return;
      }
      yield* host.run(request, signal);
    },
    async runs() {
      const host = read();
      return host ? host.runs() : { error: "Tex isn't available right now." };
    },
    note: () => read()?.note() ?? null,
    people: () => read()?.people() ?? [],
    onRunDone: (runId) => read()?.onRunDone?.(runId),
    onRunning: (running) => read()?.onRunning?.(running),
  };
}

/**
 * The facet value for the editor: the Tex button is drawn only when a host is
 * there now. The editor reconfigures it when that answer flips, not per render.
 */
export function texInNoteExtension(read: () => TexInNoteHost | null | undefined): Extension {
  return texInNoteHost.of(read() ? forwardingHost(read) : null);
}
