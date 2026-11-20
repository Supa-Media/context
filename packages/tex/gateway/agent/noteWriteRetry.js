/**
 * A NOTE SAVE THAT RAN LONG IS FOLLOWED THROUGH, NEVER CALLED FAILED (2026-10-24).
 *
 * Between about 17:50 and 20:09 UTC the texting assistant told one person,
 * three conversations running, "the write timed out" and "your notes stopped
 * saving", and a long finance note never got its corrected numbers. The
 * slowness was the merge's diff (`packages/collaboration/src/textDiff.js`),
 * but the wording was this loop's: a call past its limit was answered
 * "That call took too long … Don't retry it", while the save itself went on
 * running, and could land a moment later. So a timeout was reported as a
 * failure that nobody had seen, and the model was told not to try again.
 *
 * A plain `write_note` (a path and its whole new content) that runs past its
 * limit now gets, inside what is left of the turn's time:
 *
 *   1. Its own limit again (at most 25 s) for the same save, still running.
 *   2. A read of the note: if it already holds the content, the save landed.
 *   3. One retry of the same write. A full-content write is safe to repeat:
 *      the merge answers a repeat of text the note already holds as
 *      unchanged, and a plain write that lost to its own first attempt reads
 *      back as the content and counts as saved.
 *
 * What the model reads at the end is what happened: saved, a real refusal
 * (a conflict, a privacy refusal: the write's own answer), or "not
 * confirmed yet", which is not a failure and must not be told as one.
 */

/** Settle `work` within `ms`, or throw `ToolTimeout`. */
export async function withinTime(work, ms) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ToolTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ToolTimeout extends Error {}

export const NOTE_WRITE_TOOL = "write_note";

/** At most this much more for the save already running. */
const MORE_TIME_MS = 25_000;
/** A read-back is one note; this is generous. */
const READ_BACK_MS = 8_000;
/** Below this, there is no room for a retry to finish, so none is started. */
const MIN_RETRY_MS = 5_000;

/** What the model reads when a save could not be confirmed either way. */
export const SAVE_NOT_CONFIRMED =
  "That save is taking longer than usual and has not confirmed yet. It may still land. " +
  "Don't tell them it failed or that their notes are down. Say it's still saving, and read the note before you say whether it saved.";

/** Whether this call is a plain whole-content save, the one kind safe to repeat. */
export function isPlainNoteWrite(name, args) {
  return (
    name === NOTE_WRITE_TOOL &&
    args !== null &&
    typeof args === "object" &&
    typeof args.path === "string" &&
    typeof args.content === "string" &&
    args.site === undefined &&
    args.upload === undefined &&
    args.comment === undefined &&
    args.mail === undefined
  );
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
}

/** A note read's text holds the content, as stored. */
function holds(read, content) {
  if (read?.isError === true) return false;
  const wanted = content.trim();
  return wanted.length > 0 && resultText(read).includes(wanted);
}

function savedAfterAll(path) {
  return {
    content: [{ type: "text", text: `Saved ${path}. It took longer than usual; reading it back shows the new content.` }],
  };
}

/**
 * Run one plain `write_note` and follow a slow one through.
 *
 * @param {object} input
 * @param {() => Promise<object>} input.run - starts the write; called again for the retry
 * @param {(name: string, args: object) => Promise<object>} input.callTool - for the read-back
 * @param {object} input.args - the write's arguments
 * @param {number} input.ms - the call's own limit
 * @param {() => number} input.remaining - ms left of the turn's tool time
 * @returns {Promise<object>} a tool result; throws only what the write itself threw
 */
export async function settleNoteWrite({ run, callTool, args, ms, remaining }) {
  const first = run();
  try {
    return await withinTime(first, ms);
  } catch (error) {
    if (!(error instanceof ToolTimeout)) throw error;
  }
  // 1. The save is still running: give it more of what is left.
  const more = Math.min(MORE_TIME_MS, ms, remaining() - READ_BACK_MS);
  if (more > 0) {
    try {
      return await withinTime(first, more);
    } catch (error) {
      if (!(error instanceof ToolTimeout)) throw error;
    }
  }
  // 2. It may have landed without answering in time.
  if (await landed(callTool, args)) return savedAfterAll(args.path);
  // 3. Once more, if there is room for it to finish.
  const room = remaining() - READ_BACK_MS;
  if (room < MIN_RETRY_MS) return notConfirmed();
  let again;
  try {
    again = await withinTime(run(), Math.min(ms, room));
  } catch (error) {
    if (!(error instanceof ToolTimeout)) throw error;
    return (await landed(callTool, args)) ? savedAfterAll(args.path) : notConfirmed();
  }
  // A retry that lost to the first attempt says "conflict"; the note says whether it is theirs.
  if (again?.isError === true && (await landed(callTool, args))) return savedAfterAll(args.path);
  return again;
}

async function landed(callTool, args) {
  try {
    const read = await withinTime(
      Promise.resolve(callTool("read_note", { path: args.path, ...(args.context === undefined ? {} : { context: args.context }) })),
      READ_BACK_MS,
    );
    return holds(read, args.content);
  } catch {
    return false;
  }
}

function notConfirmed() {
  return { content: [{ type: "text", text: SAVE_NOT_CONFIRMED }], isError: true };
}
