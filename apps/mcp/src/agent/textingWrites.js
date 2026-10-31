/**
 * What the texting assistant may write: the same tools, with the same fields,
 * that an MCP client on this connection is offered.
 *
 * The owner decided on 2026-10-08 ("Edit directly") that a text edits notes
 * itself instead of only proposing, and then, the same day, that the
 * assistant must have every tool and field the MCP has ("shouldn't we be
 * listing all the tools and fields that an agent can use?") after it told
 * them it could not move notes between workspaces when `move_note` can. So
 * the list is derived from what `toolsForSession` returned, never copied by
 * hand: a new MCP tool or field reaches the texting assistant without a
 * change here, and the test `every MCP write tool and field is offered to a
 * text or withheld by name` fails when a withheld name goes stale.
 *
 * Then the owner removed the last limits ("our inhouse assistant should have
 * just as much tool access as any other mcp"; "yes go"): public links,
 * website publishing and image addresses included. The two lists below are
 * empty, and the dispatcher still refuses plumbing paths and malformed
 * routines. A note the agent reads can carry instructions, and a
 * personal context takes email from strangers into `0-inbox/`; that is the
 * accepted cost, recorded in docs/decisions/texting-assistant.md.
 *
 * Every other decision (whether this person may write that note at all, in
 * which context, with which etag) is the client's dispatcher's, unchanged.
 *
 * The routine's own run (`context_routines`) is never offered these: a
 * routine that could rewrite itself, or another one, would be instructions
 * that grow their own reach.
 */

import { homeRoutineWords, routineFromPath, routineRootOf } from "../../../../packages/shared/src/routines.cjs";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { normalizePath } from "../notes/paths.js";
import { isPlumbing } from "../privacy/engine.js";
import { toolError } from "../tools/results.js";
import { routineWhen } from "./routineWhen.js";
import { NOTE_SOURCE_PREFIX } from "./sources.js";

/**
 * Tools a text is never offered, with the reason. None: the owner decided on
 * 2026-10-08 ("our inhouse assistant should have just as much tool access as
 * any other mcp") that a text has everything an MCP client has. The one name
 * that was here, the key export, was then removed from the MCP itself (the
 * owner chose "Remove it" the same day), so no client is offered it. A name
 * added here must still be a tool the MCP has: the drift test fails on a
 * stale one.
 */
export const WITHHELD_TOOLS = new Map();

/** Fields of an offered tool a text never passes, with the reason. None. */
export const WITHHELD_FIELDS = new Map();

const ROUTINE_HELP =
  " Routines are notes the assistant runs on a schedule as this person, then texts them what it found. " +
  "Write a new routine or reminder at tex/routines/<how-often>/<name>.md, in Tex's own tex/ folder. " +
  "The folder says how often: hourly, " +
  "every-3-hours, daily, weekly, every-2-weeks, monthly, or once for a one-off reminder (tex/routines/once/). " +
  // The owner, 2026-10-23: an every-5-minutes "retry Planning Center" check texted the same line over and over.
  "Never make one that runs more often than hourly; to retry something, use hourly with until:. " +
  "Older routines at routines/<how-often>/<name>.md still run where they are: edit them in place, and move one only when asked. " +
  "A one-off needs its date and time: at: 2026-10-15 9:00 am; it texts once, then is marked done: and stays as a record. " +
  "Other optional lines at the top, between --- lines: " +
  "at: 7:30 am, on: weekdays (or Fridays, or a day of the month for monthly), send: text | note | both, " +
  // A review, 2026-10-26: "through this week" read on the next Monday made a daily reminder say "This is the last one."
  "until: <when to stop, as a date like until: 2026-11-01 end of day, or something that will happen; never this week, today or tomorrow, which mean another day by the time it runs>, paused: yes. " +
  // The owner, 2026-10-18: routines are personal. One texts only the person who wrote it. Since 2026-10-27 a shared workspace runs
  // only a chat routine, set up from its group chat, which answers into that chat (`groupRoutines.js`).
  "A routine texts only the person who wrote it, and runs in their own personal workspace; in a shared one only a routine set up from its group chat runs, and it answers in that chat. " +
  "The body is plain instructions for the assistant, written as the person asked; " +
  "a reminder's body is the reminder itself, with any link they gave (\"Call Apple about the app review: <link>\"). " +
  // The owner, 2026-10-23: "stop the check please wth", after Tex sent a pause for approval.
  "When they ask to stop, pause, cancel or delete a routine, archive it yourself at once; never send it for approval. " +
  "One routine per thing: when they change a reminder (\"every 3 hours until I do it\"), edit or archive the old one, never add a second. " +
  // The owner, 2026-10-14: a reply that restated the whole reminder read like a chatbot; a friend says "Will do."
  "After saving, answer the way a friend would: \"Will do.\" or \"Sure.\" Name the time only when you picked it, " +
  "and say where the note is or how to stop it only when they ask.";

/**
 * The routine help goes at the end of the description's first paragraph: a
 * texting assistant's `write` shows only that paragraph for a save (`sixTools.js`),
 * and routines are what a text asks for most of what write_note does.
 */
function withRoutineHelp(description) {
  const text = typeof description === "string" ? description : "";
  const end = text.search(/\r?\n\s*\r?\n/);
  return end === -1 ? `${text}${ROUTINE_HELP}` : `${text.slice(0, end)}${ROUTINE_HELP}${text.slice(end)}`;
}

/** Argument names that hold a path in the bucket, at any depth. */
const PATH_KEYS = new Set(["path", "source", "destination", "note", "responses"]);

/** The MCP definition with the withheld fields taken out, and nothing else changed. */
function mirrored(tool) {
  const withheld = WITHHELD_FIELDS.get(tool.name);
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  const properties = Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(([key]) => !withheld?.has(key)),
  );
  const required = Array.isArray(schema.required) ? schema.required.filter((key) => !withheld?.has(key)) : undefined;
  return {
    ...tool,
    ...(tool.name === "write_note" ? { description: withRoutineHelp(tool.description) } : {}),
    inputSchema: { ...schema, properties, ...(required ? { required } : {}) },
  };
}

/**
 * The write tools this turn adds to its list: every write tool the
 * connection itself was offered (so a read-only grant gets none), minus the
 * withheld ones, and only on a texting turn. Decided by the caller from the
 * grant, never from the request body.
 */
export function textingWriteTools(offered, { texting }) {
  if (!texting) return [];
  return offered
    .filter((tool) => tool.annotations?.readOnlyHint !== true && !WITHHELD_TOOLS.has(tool.name))
    .map(mirrored);
}

/** Whether `path` is a file the agent may write or archive. */
export function isRoutineFilePath(path) {
  return isWritablePath(path) && path.endsWith(".md") && routineFromPath(path)?.kind === "routine";
}

/**
 * Whether the agent may name `path` at all: exactly as written, and not
 * plumbing. A path the normalizer would change is not one to guess at, `..`
 * never names a note, and `privacy.md` is the access control itself.
 */
export function isWritablePath(path) {
  if (typeof path !== "string" || path.length === 0 || normalizePath(path) !== path) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return !isPlumbing(path);
}

/** Every path-like string in `args`, at any depth (e.g. move_notes' moves). */
function pathsIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) pathsIn(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (PATH_KEYS.has(key) && typeof inner === "string") found.push(inner);
      else pathsIn(inner, found);
    }
  }
  return found;
}

/** Why `args` are refused, or null when they may go to the client's dispatcher. */
function refusalFor(name, args) {
  for (const path of pathsIn(args)) {
    if (!isWritablePath(path)) return "That path can't be used: hidden folders and privacy.md are not editable here.";
    // Either root: `tex/routines/` (where new ones go) or `routines/` (where
    // they lived first, and still run). Case-insensitive, like the format.
    const root = routineRootOf(path);
    const inRoutines = root !== null;
    if (inRoutines && path.endsWith(".md") && routineFromPath(path)?.kind !== "routine") {
      return `Only a routine file can be written under ${root}: ${root}<how-often>/<name>.md, with a folder like daily or weekly.`;
    }
    if (inRoutines && name === "write_note" && args.expected_etag === undefined && routineFromPath(path)?.cadence?.unit === "minute") {
      return "Routines can't run more often than hourly from a text: they would text over and over. Use hourly, with until: for when to stop.";
    }
    // A routine runs as the person who wrote it, in their own context.
    // A group chat's own routine is the exception: it is in the chat's home, reached by name (`groupRoutines.js`).
    if (inRoutines && name === "write_note" && args.context !== undefined && homeRoutineWords(path) === null) {
      return "Routines are written in their own workspace: leave out context.";
    }
  }
  return null;
}

/**
 * Wrap the client's dispatcher so the texting write tools only pass the
 * fields their mirrored schemas name, on paths outside plumbing. Every other
 * tool passes through untouched.
 */
export function textingAwareCallTool(callTool, writeTools, { timeZone = null, now = Date.now } = {}) {
  const accepted = new Map(writeTools.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})]));
  return (name, args) => {
    const fields = accepted.get(name);
    if (fields === undefined) return callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const extra = Object.keys(given).filter((key) => !fields.includes(key));
    if (extra.length > 0) return toolError(`${extra.join(", ")} can't be passed from a text.`);
    const refusal = refusalFor(name, given);
    if (refusal) return toolError(refusal);
    const done = name === "write_note" && given.expected_etag === undefined && isRoutineFilePath(given.path)
      ? Promise.resolve(callTool(name, given)).then((result) => withOtherRoutines(callTool, given.path, result))
      : Promise.resolve(callTool(name, given));
    return done.then((result) => withRunTime(withWrittenNotes(result, given), given, timeZone, now()));
  };
}

/** A routine written: when it first texts them, or why it won't (`routineWhen.js`). */
function withRunTime(result, args, timeZone, now) {
  if (!result || typeof result !== "object" || result.isError === true || result.held === true) return result;
  if (!isRoutineFilePath(args.path)) return result;
  const when = routineWhen(args.path, args.content, timeZone, now);
  if (when === null) return result;
  return { ...result, content: [...(result.content ?? []), { type: "text", text: when.text }] };
}

/**
 * A write that went through names the notes it touched, as `note:<path>`
 * sources the conversation keeps (`sources.js`), so the next text knows what
 * this one wrote rather than doubting it.
 */
function withWrittenNotes(result, args) {
  if (!result || typeof result !== "object" || result.isError === true || result.held === true) return result;
  const where = typeof args.context === "string" && args.context.startsWith("@") ? `${args.context}/` : "";
  const notes = [...new Set(pathsIn(args))].map((path) => `${NOTE_SOURCE_PREFIX}${where}${path}`);
  if (notes.length === 0) return result;
  return { ...result, sources: [...(Array.isArray(result.sources) ? result.sources : []), ...notes] };
}

/** How many of their other routines a new one's result names. */
const OTHER_ROUTINES_SHOWN = 20;

/**
 * A new routine's result names the others they have, so one that says the
 * same thing is changed or archived rather than left beside it (the owner,
 * 2026-10-23: "remind me tomorrow" then "every 3 hours until I do it" left a
 * one-off and an every-3-hours routine that both texted at 9:00, because the
 * second turn no longer knew the first one's path). Best effort: a listing
 * that fails leaves the result as it was.
 */
async function withOtherRoutines(callTool, path, result) {
  if (result?.isError === true) return result;
  try {
    const others = [];
    // A chat's home routine is beside the chat's other routines, in its home (`groupRoutines.js`).
    const home = homeRoutineWords(path) === null ? null : routineRootOf(path);
    const lists = home === null ? [{ prefix: "tex/routines/" }, { prefix: "routines/" }] : [{ prefix: home, context: PINNED_CONTEXT_NAME }];
    for (const where of lists) {
      const listed = await callTool("list_notes", where);
      const text = listed?.isError === true ? "" : String(listed?.content?.[0]?.text ?? "");
      for (const line of text.split("\n")) {
        const key = line.replace(/\s+\(\d+ bytes\)$/, "").trim();
        if (key !== path && isRoutineFilePath(key)) others.push(key);
      }
    }
    if (others.length === 0) return result;
    const shown = others.slice(0, OTHER_ROUTINES_SHOWN).join(", ");
    const note =
      `Their other routines: ${shown}. If one of these is about the same thing as the one you just wrote, ` +
      "archive it now, or they will be texted twice.";
    return { ...result, content: [...(result?.content ?? []), { type: "text", text: note }] };
  } catch {
    return result;
  }
}
