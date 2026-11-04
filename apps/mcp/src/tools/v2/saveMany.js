/**
 * `write` action `save_many`: up to `SAVE_MANY_MAX` notes saved in one call.
 *
 * Asked for by the owner on 2026-11-03 ("bulk writes"), after a benchmark that
 * wrote 100 notes one call at a time. It is not a second way to write a note:
 * each note is handed back to `callToolForSession` as the `write` call an app
 * would have made for it, so routing, the scope gate, argument validation,
 * the egress gate, the note cap, audit and activity see one ordinary save per
 * note and decide it exactly as they would have. Nothing here decides access.
 *
 * Each note stands on its own: one refused (a conflict, a folder it may not
 * write) is reported beside the ones that saved, never rolls them back. The
 * answer is an error only when every note failed. Saves run a few at a time,
 * not all at once, so a hundred notes do not open a hundred requests to the
 * workspace's storage together.
 */

import { toolError } from "../results.js";
import { outcomeOf } from "../../mcp/outcome.js";

/** The most notes one call saves: `move_many`'s limit, so the two bulk actions agree. */
export const SAVE_MANY_MAX = 100;

/** Saves in flight at once. */
export const SAVE_MANY_CONCURRENCY = 8;

/**
 * How long one call keeps starting saves. A note not started by then is answered "not saved, send it again" rather
 * than left to a connection that closes first: on 2026-11-03 a 100-note call in production answered 503 after 90
 * notes had saved, so the caller could not tell which had.
 */
export const SAVE_MANY_BUDGET_MS = 15_000;

/** The carrying tool's name: never dispatched itself (`callToolForSession` fans it out). */
export const SAVE_MANY_TOOL = "write_notes";

/** The note fields one entry may carry; anything else is refused rather than dropped. */
const ENTRY_FIELDS = new Set(["path", "content", "expected_etag"]);

/** The refusal for a malformed list, or null. */
function listRefusal(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return "save_many needs args.notes: a list of { path, content, expected_etag? }";
  if (notes.length > SAVE_MANY_MAX) return `save_many saves at most ${SAVE_MANY_MAX} notes at a time; split the list`;
  const seen = new Set();
  for (const [index, note] of notes.entries()) {
    if (!note || typeof note !== "object" || Array.isArray(note)) return `notes[${index}] has to be an object`;
    const extra = Object.keys(note).find((key) => !ENTRY_FIELDS.has(key));
    if (extra !== undefined) return `notes[${index}] takes only path, content and expected_etag, not ${JSON.stringify(extra.slice(0, 40))}`;
    if (typeof note.path !== "string" || note.path.trim() === "") return `notes[${index}] needs a path`;
    if (typeof note.content !== "string") return `notes[${index}] needs content`;
    if (note.expected_etag !== undefined && typeof note.expected_etag !== "string") return `notes[${index}].expected_etag has to be a string`;
    // Two saves of one note in one call would race each other; which one won would be luck.
    if (seen.has(note.path)) return `${note.path} is in the list twice; save it once`;
    seen.add(note.path);
  }
  return null;
}

/**
 * One save's answer as one line: `outcome: {...}` read off it the way `mcp/outcome.js` reads any write's answer, with
 * the note's own path, and the refusal's first line where it was refused, so a client never parses the prose.
 */
function lineOf(path, result) {
  const outcome = outcomeOf("write", result) ?? { applied: false, error: "FAILED" };
  const line = { ...outcome, path };
  if (outcome.applied === false) {
    const text = typeof result?.content?.[0]?.text === "string" ? result.content[0].text : "";
    line.message = (text.split("\n").find((part) => part.trim() !== "") ?? "").slice(0, 200);
  }
  return `outcome: ${JSON.stringify(line)}`;
}

/**
 * Save every note in `args.notes`, each through `saveOne` (an ordinary `write`
 * call's arguments → its answer), and answer with one line per note.
 *
 * @param {{notes?: unknown, context?: string, person_said?: string, mailbox?: string}} args
 * @param {(writeArguments: object) => Promise<object>} saveOne
 */
export async function saveMany(args, saveOne, { budgetMs = SAVE_MANY_BUDGET_MS, now = Date.now } = {}) {
  const notes = args?.notes;
  const refused = listRefusal(notes);
  if (refused) return toolError(refused);
  const addressing = {};
  for (const key of ["context", "person_said", "mailbox"]) if (args[key] !== undefined) addressing[key] = args[key];

  const results = new Array(notes.length);
  const started = now();
  let next = 0;
  const worker = async () => {
    while (next < notes.length) {
      // Out of time: the rest are left unstarted and said so, never half-done.
      if (now() - started >= budgetMs) return;
      const index = next;
      next += 1;
      const { path, content, expected_etag: etag } = notes[index];
      try {
        results[index] = await saveOne({ ...addressing, path, content, ...(etag === undefined ? {} : { expected_etag: etag }) });
      } catch (error) {
        // One save that threw is that note's failure, said in the same place as any other; the rest still answer.
        results[index] = toolError(`could not save that note right now (${String(error?.message ?? error).slice(0, 120)})`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(SAVE_MANY_CONCURRENCY, notes.length) }, worker));

  const saved = results.filter((result) => result !== undefined && !result.isError).length;
  const lines = notes.map((note, index) =>
    results[index] === undefined
      ? `outcome: ${JSON.stringify({ applied: false, error: "NOT_STARTED", path: note.path, message: "not saved: this call ran out of time before it; send it again" })}`
      : lineOf(note.path, results[index])
  );
  const text = `${saved} of ${notes.length} notes saved\n${lines.join("\n")}`;
  // The whole call's own outcome line (`mcp/outcome.js` takes it as given): the per-note lines above say which.
  const outcome = { applied: saved > 0, saved, failed: notes.length - saved };
  return saved === 0 ? { content: [{ type: "text", text }], isError: true, ownOutcome: outcome } : { content: [{ type: "text", text }], ownOutcome: outcome };
}
