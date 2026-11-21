/**
 * Tex in a note's comments (`docs/decisions/texting-assistant/...`, D1 section 3): a run the person asks from a
 * highlight or with ⌘L, answered by Tex as the person, with their own access, and never written anywhere but the
 * note's run log.
 *
 *  - `POST /tex/note-run` → a streamed `application/x-ndjson` answer: `{type:"step", id, label, state, ms?, source?}` as
 *    the run works, then `{type:"answer", text}`, `{type:"edit", replace}` when Tex suggests a new text for the anchor,
 *    and `{type:"done", runId, sources}`. A run that does not answer ends in one `{type:"error", message}` line.
 *    Refusals before the stream are JSON `{error}`: 400 for a body, 403 for a workspace the person is not in, 404 for a
 *    note they cannot read, 503 while the `noteRun` step is not wired.
 *  - `GET /tex/note-runs?workspace=&path=` (noteId may be sent, and is ignored) → `{ runs: [{ runId, who, ask, out, sources, at, private }] }`, the
 *    note's runs newest first, for a person who can read the note. A run someone else made shows only the note's own
 *    source; the asker's own runs show every source, and `private` says when one of them is not this note.
 *
 * Who may: only the console's own client (`context_console`) for the owner of a personal workspace, as
 * `appChatRoute.js` checks it. The workspace named in the body is one the person is a live member of (`session.workspaces`,
 * the control plane's set), or refused; the note is read through the person's own dispatch, so every refusal the tools
 * give is the one this answers. The run never writes the note or the person's 1:1 chat.
 *
 * Every answer, a refusal included, carries the gateway's open CORS header. Nothing logged but the event, the outcome
 * and the time: never the ask, the answer, a path or a source.
 */

import { ledgerFor } from "./ledger.js";
import { ownDispatch } from "./reflect.js";
import { grantedToolsFor } from "./sixTools.js";
import { DEFAULT_TIME_ZONE } from "./localNow.js";
import { texConfigOf, texStep } from "./texConfig.js";
import { personalNameFor } from "../../../../apps/mcp/src/context/identity.js";
import { createControlPlane } from "../../../../apps/mcp/src/controlPlane.js";
import { appendNoteRun, listNoteRuns } from "./noteRunLog.js";

export const NOTE_RUN_PATH = "/tex/note-run";
export const NOTE_RUNS_READ_PATH = "/tex/note-runs";
/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
const MAX_BODY_BYTES = 200_000;
const MAX_ID = 128;
const MAX_PATH = 512;
const MAX_ASK = 4_000;
const MAX_ANCHOR_TEXT = 20_000;
const MAX_ANCHOR_CONTEXT = 400;
const MAX_HISTORY = 20;
const MAX_HISTORY_BODY = 4_000;
const MAX_WHO = 200;
const MAX_PENDING = 20_000;
/** What a log entry keeps of the words, the calls, and the sources; the same caps the log holds (`texChat/noteRuns.js`). */
const LOG_WORDS = 300;
const LOG_CALLS = 40;
const LOG_SOURCES = 50;
const ID_TEXT = /^[A-Za-z0-9_.:-]{1,128}$/;
const LIMIT_MESSAGE = "That's today's limit for Tex. Try again tomorrow.";
const UNREACHABLE_MESSAGE = "Tex can't take that just now. Try again in a moment.";
const NOT_READABLE_MESSAGE = "That note can't be read with your access. Open a note you can see, then ask again.";
const NOT_WIRED_MESSAGE = "Tex in notes isn't on yet. Ask Tex from its chat for now, then try here again later.";
/** The phrase for who a note is shared with, by the visibility its read gave (`read_note`'s `visibility:` line). */
const AUDIENCE = Object.freeze({ private: "only you", team: "the team it is shared with" });
const AUDIENCE_OTHER = "the people this note is shared with";

const json = (body, status = 200) => Response.json(body, { status });
const refuse = (status, error) => json({ error }, status);

/** Every answer carries the gateway's open CORS header (as `appChatRoute.js`): the console is another origin. */
function cors(response) {
  const out = new Response(response.body, response);
  out.headers.set("Access-Control-Allow-Origin", "*");
  return out;
}

/** Only the console's own client, for the owner of a personal workspace. */
function ownerOf(session) {
  return session?.actorClientId === CONSOLE_CLIENT_ID && session.workspaceKind === "personal" && session.role === "owner";
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, max, min = 0) => typeof value === "string" && value.length >= min && value.length <= max;

/**
 * The validated body, or the reason it is refused. Nothing in it is trusted past this point: every field is the shape
 * and size the route's contract names (D1 section 3).
 */
export function parseRunBody(body) {
  if (!isObject(body)) return { error: "The body is not an object. Send a JSON object with workspace, path, thread, anchor, ask, history and pending." };
  const { workspace, noteId, path, thread, anchor, ask, history, pending } = body;
  if (!text(workspace, MAX_ID, 1)) return { error: "workspace is missing. Send the note's workspace id or @name, then try again." };
  // The client's note id is optional and never trusted: the log's key is derived from the note as read (`logKeyOf`).
  if (noteId !== undefined && (!text(noteId, MAX_ID) || (noteId !== "" && !ID_TEXT.test(noteId)))) return { error: "noteId is not a note's id. Send it empty, then try again." };
  if (!text(path, MAX_PATH, 1)) return { error: `path is missing or too long. Send the note's path, up to ${MAX_PATH} characters, then try again.` };
  if (!text(thread, MAX_ID, 1)) return { error: "thread is missing. Send the comment thread's id, then try again." };
  if (!isObject(anchor) || !text(anchor.text, MAX_ANCHOR_TEXT) || !text(anchor.before, MAX_ANCHOR_CONTEXT) || !text(anchor.after, MAX_ANCHOR_CONTEXT)) {
    return { error: `anchor is not right. Send { text (up to ${MAX_ANCHOR_TEXT}), before and after (up to ${MAX_ANCHOR_CONTEXT}) }, then try again.` };
  }
  const words = typeof ask === "string" ? ask.trim() : "";
  if (words === "" || words.length > MAX_ASK) return { error: `The ask is empty or too long. Ask Tex in 1 to ${MAX_ASK} characters, then try again.` };
  if (!Array.isArray(history) || history.length > MAX_HISTORY) return { error: `history is too long. Send up to ${MAX_HISTORY} texts, then try again.` };
  for (const item of history) {
    if (!isObject(item) || !text(item.who, MAX_WHO) || !text(item.body, MAX_HISTORY_BODY)) {
      return { error: `A history text is not right. Send each as { who, body (up to ${MAX_HISTORY_BODY}) }, then try again.` };
    }
  }
  if (pending !== null && !text(pending, MAX_PENDING)) return { error: `pending is too long. Send null or up to ${MAX_PENDING} characters, then try again.` };
  return {
    workspace,
    noteId,
    path,
    thread,
    anchor: { text: anchor.text, before: anchor.before, after: anchor.after },
    ask: words,
    history: history.map((item) => ({ who: item.who, body: item.body })),
    pending,
  };
}

/**
 * The workspace the body names, if the person is a live member of it: an id or an `@name` the control plane's set holds.
 * `context` is what the read names: nothing for the person's own workspace, `@name` for another.
 */
export function targetOf(session, workspace) {
  const covered = (session?.workspaces ?? []).find(
    (entry) => typeof entry?.workspaceId === "string" && (entry.workspaceId === workspace || (typeof entry.slug === "string" && entry.slug !== "" && `@${entry.slug}` === workspace)),
  );
  if (covered === undefined) return null;
  if (covered.workspaceId === session.workspaceId) return { workspaceId: covered.workspaceId, context: undefined };
  if (typeof covered.slug !== "string" || covered.slug === "") return null;
  return { workspaceId: covered.workspaceId, context: `@${covered.slug}` };
}

/** The text of a tool result, as the note reads have it (`texPage/notes.js` reads the same way). */
function textOf(result) {
  return (Array.isArray(result?.content) ? result.content : []).map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/**
 * The note as the person can read it: `{ note, audience }`, or null when `read_note` refuses it, cannot find it, or
 * says it moved. The header lines are the tool's own (`etag`, `path`, `visibility`).
 */
export async function readNoteAs(dispatch, path, context) {
  let result;
  try {
    result = await dispatch("read_note", { path, ...(context === undefined ? {} : { context }) });
  } catch {
    return null;
  }
  if (result?.isError === true) return null;
  const whole = textOf(result);
  const split = whole.indexOf("\n\n");
  const header = split === -1 ? whole : whole.slice(0, split);
  if (/^moved_from:/m.test(header)) return null;
  const visibility = /^visibility: (.+)$/m.exec(header)?.[1]?.trim() ?? null;
  const audience = visibility !== null && Object.hasOwn(AUDIENCE, visibility) ? AUDIENCE[visibility] : AUDIENCE_OTHER;
  const etag = /^etag: (.+)$/m.exec(header)?.[1]?.trim() ?? null;
  // A placed etag is `@workspace/noteId:version` (`apps/mcp/src/tools/etagPlace.js`); a bare one names no note.
  const placed = typeof etag === "string" ? /^@[a-z0-9][a-z0-9-]*\/([A-Za-z0-9_-]+):/.exec(etag) : null;
  return { note: split === -1 ? "" : whole.slice(split + 2), audience, noteId: placed?.[1] ?? null };
}

/**
 * The key a note's run log is kept under: the note's own id, as its placed etag names it, or a hash of its path for a
 * note without one. Never the id the client sent: a key it chose could write runs into a note it cannot read.
 */
export async function logKeyOf(note, path) {
  if (typeof note?.noteId === "string" && ID_TEXT.test(note.noteId)) return note.noteId;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)));
  return `p${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The node that runs a note's ask, or null while it is not wired (the config has no `noteRun`, or it is off). */
function nodeOf(env, deps) {
  if (typeof deps.noteRunNode === "function") return deps.noteRunNode(env);
  try {
    const step = texStep("noteRun", texConfigOf(env));
    return step?.on === true ? step : null;
  } catch {
    return null;
  }
}

/** The path a source names, whether it is a path or an object that carries one; null when it names none. */
function sourcePathOf(source) {
  if (typeof source === "string") return source;
  return typeof source?.path === "string" ? source.path : null;
}

/** Whether a source is the note itself. */
const isNote = (path) => (source) => sourcePathOf(source) === path;

function randomRunId() {
  return `nr_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One step line, with only the fields the contract names. */
function stepLine(step) {
  return {
    type: "step",
    id: step.id,
    label: step.label,
    state: step.state,
    ...(Number.isFinite(step.ms) ? { ms: step.ms } : {}),
    ...(typeof step.source === "string" ? { source: step.source } : {}),
  };
}

/** The route's dependencies. Tests replace them; the Worker takes the defaults. */
function dependencies(env, deps) {
  return {
    controlPlane: deps.controlPlane ?? createControlPlane(env),
    dispatchFor: deps.dispatchFor ?? ((store, session) => ownDispatch(store, session, env)),
    offeredFor: deps.offeredFor ?? ((session, store) => grantedToolsFor(session, store, { texts: true })),
    ledgerOf: deps.ledgerOf ?? ((owner) => ledgerFor(env, owner)),
    now: deps.now ?? Date.now,
    runId: deps.runId ?? randomRunId,
    runNoteRun: deps.runNoteRun ?? null,
  };
}

/** `POST /tex/note-run` (`APP_ROUTES`): the run's answer, streamed. Every answer carries the CORS header. */
export async function handleNoteRun(request, store, session, _path, env, ctx = null, deps = {}) {
  try {
    return cors(await serveRun(request, store, session, env, ctx, deps));
  } catch (error) {
    console.log(JSON.stringify({ event: "note_run", outcome: "unreachable", error: String(error?.name ?? "error").slice(0, 40) }));
    return cors(refuse(503, UNREACHABLE_MESSAGE));
  }
}

async function serveRun(request, store, session, env, ctx, deps) {
  if (!ownerOf(session)) return refuse(403, "forbidden");
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return refuse(413, "The request is too large. Send a shorter note thread, then try again.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return refuse(413, "The request is too large. Send a shorter note thread, then try again.");
  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refuse(400, "The request is not JSON. Send a JSON object, then try again.");
  }
  const parsed = parseRunBody(raw);
  if (parsed.error) return refuse(400, parsed.error);
  const target = targetOf(session, parsed.workspace);
  if (target === null) return refuse(403, "forbidden");
  const node = nodeOf(env, deps);
  if (node === null) return refuse(503, NOT_WIRED_MESSAGE);

  const wired = dependencies(env, deps);
  const dispatch = wired.dispatchFor(store, session);
  const readStarted = Date.now();
  const note = await readNoteAs(dispatch, parsed.path, target.context);
  const noteReadMs = Date.now() - readStarted;
  if (note === null) return refuse(404, NOT_READABLE_MESSAGE);

  const ledger = wired.ledgerOf({ person: session.workspaceId }) ?? null;
  const offered = await wired.offeredFor(session, store);
  const runNoteRun = wired.runNoteRun ?? (await import("./noteRun.js")).runNoteRun;
  const runId = wired.runId();
  const started = wired.now();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  // Lines are written in order and never awaited by the run: a reader that is slow, or gone, does not hold the model.
  let chain = Promise.resolve();
  const send = (line) => {
    chain = chain.then(() => writer.write(encoder.encode(`${JSON.stringify(line)}\n`))).catch(() => {});
  };

  const drive = async () => {
    let result;
    try {
      result = await runNoteRun({
        env,
        controlPlane: wired.controlPlane,
        session,
        dispatch,
        offered,
        ledger,
        workspace: target.context ?? null, // the note's workspace: every read goes there unless the model names another
        path: parsed.path,
        noteText: note.note,
        anchor: parsed.anchor,
        ask: parsed.ask,
        history: parsed.history,
        pending: parsed.pending,
        audience: note.audience,
        node,
        thread: parsed.thread,
        now: started,
        timeZone: DEFAULT_TIME_ZONE,
        onStep: (step) => send(stepLine(step)),
        noteReadMs,
      });
    } catch (error) {
      console.log(JSON.stringify({ event: "note_run", outcome: "failed", error: String(error?.name ?? "error").slice(0, 40) }));
      result = { outcome: "failed" };
    }
    const outcome = result?.outcome ?? "failed";
    const ms = Number.isFinite(result?.ms) ? result.ms : wired.now() - started;
    console.log(JSON.stringify({ event: "note_run", outcome, ms }));
    if (outcome === "answered") {
      const answer = typeof result.answer === "string" ? result.answer : "";
      const sources = Array.isArray(result.sources) ? result.sources : [];
      send({ type: "answer", text: answer });
      if (typeof result.replace === "string") send({ type: "edit", replace: result.replace });
      send({ type: "done", runId, sources });
      await chain;
      await appendNoteRun(env, target.workspaceId, await logKeyOf(note, parsed.path), {
        runId,
        who: personalNameFor(session) ?? "someone",
        userId: typeof session.actorUserId === "string" ? session.actorUserId : null,
        ask: parsed.ask.slice(0, LOG_WORDS),
        out: answer.slice(0, LOG_WORDS),
        replaced: typeof result.replace === "string",
        sources: sources.slice(0, LOG_SOURCES),
        at: started,
        model: typeof result.model === "string" ? result.model : null,
        ms,
        calls: Array.isArray(result.calls) ? result.calls.slice(0, LOG_CALLS) : [],
        usage: result.usage ?? {},
      });
    } else {
      send({ type: "error", message: outcome === "daily_limit" ? LIMIT_MESSAGE : UNREACHABLE_MESSAGE });
    }
    await chain;
    await writer.close().catch(() => {});
  };

  const work = drive().catch(() => writer.abort().catch(() => {}));
  ctx?.waitUntil?.(work);
  return new Response(readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

/** `GET /tex/note-runs` (`APP_ROUTES`): the note's runs for a person who can read it. */
export async function handleNoteRuns(request, store, session, _path, env, _ctx = null, deps = {}) {
  try {
    return cors(await serveRuns(request, store, session, env, deps));
  } catch (error) {
    console.log(JSON.stringify({ event: "note_runs", outcome: "unreachable", error: String(error?.name ?? "error").slice(0, 40) }));
    return cors(refuse(503, UNREACHABLE_MESSAGE));
  }
}

async function serveRuns(request, store, session, env, deps) {
  if (!ownerOf(session)) return refuse(403, "forbidden");
  if (request.method !== "GET") return new Response(null, { status: 405 });
  const params = new URL(request.url).searchParams;
  const workspace = params.get("workspace") ?? "";
  const noteId = params.get("noteId") ?? "";
  const path = params.get("path") ?? "";
  if (!text(workspace, MAX_ID, 1) || !text(noteId, MAX_ID) || !text(path, MAX_PATH, 1)) {
    return refuse(400, "workspace or path is missing. Send both to name the note, then try again.");
  }
  const target = targetOf(session, workspace);
  if (target === null) return refuse(403, "forbidden");
  const wired = dependencies(env, deps);
  const note = await readNoteAs(wired.dispatchFor(store, session), path, target.context);
  if (note === null) return refuse(404, NOT_READABLE_MESSAGE);
  const listed = await (deps.listRuns ?? listNoteRuns)(env, target.workspaceId, await logKeyOf(note, path));
  if (listed === null) return refuse(503, UNREACHABLE_MESSAGE);
  const own = (run) => typeof run.userId === "string" && run.userId === session.actorUserId;
  const runs = listed.map((run) => {
    const mine = own(run);
    const sources = mine ? run.sources : (run.sources ?? []).filter(isNote(path));
    return {
      runId: run.runId,
      who: run.who,
      ask: run.ask,
      out: run.out,
      sources,
      at: run.at,
      private: mine && (run.sources ?? []).some((source) => !isNote(path)(source)),
    };
  });
  return json({ runs });
}

/**
 * `tex_dev`'s sandbox op `note_runs` (`packages/lab/gateway/texDev/tool.js`): a note's runs in full, calls, usage, model and
 * time included, for a person who can read the note. The same reads as `GET /tex/note-runs`, and nothing is written.
 * `tex_dev` is gated to whoever edits the pinned workspace (`editsPinnedContext`), so the console-only check does not apply.
 */
export async function noteRunsFull({ env, store, session, args }, deps = {}) {
  const { workspace, noteId, path } = args ?? {};
  if (!text(workspace, MAX_ID, 1) || !text(path, MAX_PATH, 1)) {
    return { error: "workspace or path is missing. Pass note_runs { workspace, path }, then try again." };
  }
  const target = targetOf(session, workspace);
  if (target === null) return { error: "This connection has no access to that workspace; call orient to see the ones it reaches." };
  const dispatch = deps.dispatchFor ? deps.dispatchFor(store, session) : ownDispatch(store, session, env);
  const note = await readNoteAs(dispatch, path, target.context);
  if (note === null) return { error: NOT_READABLE_MESSAGE };
  const runs = await (deps.listRuns ?? listNoteRuns)(env, target.workspaceId, await logKeyOf(note, path));
  if (runs === null) return { error: UNREACHABLE_MESSAGE };
  return { workspace, noteId, path, runs };
}
