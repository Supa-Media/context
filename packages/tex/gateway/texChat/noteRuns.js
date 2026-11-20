/**
 * A note's run log: the runs Tex made on one note (`agent/noteRunRoute.js`), kept in the note's own TexChat object,
 * named `noteruns:<workspaceId>:<noteId>`, so no chat's storage holds it. Its own routes, answered before any chat
 * routing (`texChat.js`): `POST /note/runs` appends one run, `GET /note/runs` lists them, newest first.
 *
 * Why one storage key per run: a single value is capped by the object store, and a run's calls can be long. Keeping
 * the newest 50 and dropping anything older than 90 days happens on every append, so the object holds no more.
 *
 * What is kept is what the route hands over: the asker's words and the answer, cut to 300 characters each, the calls
 * (at most 40) and the usage. The route decides who may read what; this file only stores and answers.
 */

export const NOTE_RUNS_PATH = "/note/runs";
/** The header the route names the object with; the object refuses a name that is not a note's, or not its own. */
export const NOTE_RUNS_NAME_HEADER = "x-note-runs-name";
export const NOTE_RUNS_PREFIX = "noteruns:";
/** The most runs one note keeps, and how long one is kept. */
export const MAX_RUNS = 50;
export const RUN_DAYS = 90;
/** What one run keeps of the words, the calls and the sources. */
const WORDS = 300;
const MAX_CALLS = 40;
const MAX_SOURCES = 50;
const DAY_MS = 86_400_000;
const RUN_ID = /^nr_[0-9a-f]{16}$/;
const NAME_KEY = "name";
const RUN_KEY = "run:";

const json = (body, status = 200) => Response.json(body, { status });

/** A name this object may answer for: a note's run log, and nothing else. */
export function isNoteRunsName(name) {
  return typeof name === "string" && name.startsWith(NOTE_RUNS_PREFIX) && name.length <= 300;
}

/** The storage key of one run: its time first (zero-padded), so the keys sort oldest first. */
const keyOf = (at, runId) => `${RUN_KEY}${String(at).padStart(15, "0")}:${runId}`;

/** The time a stored key carries (`keyOf`). */
const atOf = (key) => Number(key.slice(RUN_KEY.length, RUN_KEY.length + 15));

/**
 * The entry as it is kept, or null when it is not a run. Words, calls and sources are cut here, so the stored run
 * can never be larger than the caps, whatever the caller sent.
 */
export function runEntry(value, now) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) return null;
  const at = Number.isSafeInteger(value.at) && value.at >= 0 ? value.at : now;
  return {
    runId: value.runId,
    who: typeof value.who === "string" ? value.who.slice(0, 200) : "someone",
    userId: typeof value.userId === "string" ? value.userId : null,
    ask: typeof value.ask === "string" ? value.ask.slice(0, WORDS) : "",
    out: typeof value.out === "string" ? value.out.slice(0, WORDS) : "",
    replaced: value.replaced === true,
    sources: Array.isArray(value.sources) ? value.sources.slice(0, MAX_SOURCES) : [],
    at,
    model: typeof value.model === "string" ? value.model : null,
    ms: Number.isFinite(value.ms) ? value.ms : null,
    calls: Array.isArray(value.calls) ? value.calls.slice(0, MAX_CALLS) : [],
    usage: value.usage !== null && typeof value.usage === "object" ? value.usage : {},
  };
}

/** The runs stored under the object's keys, oldest key first, with the ones past the caps dropped from storage. */
async function prune(storage, now) {
  const keys = [...(await storage.list({ prefix: RUN_KEY })).keys()];
  const cutoff = now - RUN_DAYS * DAY_MS;
  const stale = keys.filter((key) => atOf(key) < cutoff);
  const kept = keys.filter((key) => atOf(key) >= cutoff);
  const extra = kept.slice(0, Math.max(0, kept.length - MAX_RUNS));
  for (const key of [...stale, ...extra]) await storage.delete(key);
  return kept.slice(extra.length);
}

/** Appends one run and keeps the log to its caps. Returns the run as stored. */
export async function appendRun(storage, value, now) {
  const entry = runEntry(value, now);
  if (entry === null) return null;
  await storage.put(keyOf(entry.at, entry.runId), entry);
  await prune(storage, now);
  return entry;
}

/** The note's runs, newest first, within the caps and the 90 days. */
export async function listRuns(storage, now) {
  const kept = await prune(storage, now);
  const runs = [];
  for (const key of kept.reverse()) {
    const run = await storage.get(key);
    if (run !== undefined) runs.push(run);
  }
  return runs;
}

/**
 * The object's answer to `/note/runs`. The name header is checked first: the object is one note's, and a call that
 * names another (or nothing a note's log is named) is refused before any storage is read or written.
 */
export async function serveNoteRuns(request, storage, { now = Date.now } = {}) {
  const name = request.headers.get(NOTE_RUNS_NAME_HEADER);
  if (!isNoteRunsName(name)) return json({ error: "bad_name" }, 400);
  const stored = await storage.get(NAME_KEY);
  if (stored !== undefined && stored !== name) return json({ error: "name_mismatch" }, 409);
  if (request.method === "POST") {
    const body = await request.json().catch(() => null);
    if (runEntry(body, now()) === null) return json({ error: "bad_run" }, 400);
    if (stored === undefined) await storage.put(NAME_KEY, name);
    await appendRun(storage, body, now());
    return json({ ok: true });
  }
  if (request.method === "GET") return json({ runs: await listRuns(storage, now()) });
  return new Response(null, { status: 405 });
}
