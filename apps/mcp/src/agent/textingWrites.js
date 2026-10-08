/**
 * What the texting assistant may write: the same tools, with the same fields,
 * that an MCP client on this connection is offered, minus the key export.
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
 * website publishing and image addresses included. What is still withheld is
 * in the two lists below, and the dispatcher still refuses plumbing paths and
 * malformed routines. A note the agent reads can carry instructions, and a
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

import { routineFromPath } from "../../../../packages/shared/src/routines.cjs";
import { normalizePath } from "../notes/paths.js";
import { isPlumbing } from "../privacy/engine.js";
import { toolError } from "../tools/results.js";

/**
 * Tools a text is never offered, with the reason. One, on purpose: the owner
 * decided on 2026-10-08 ("our inhouse assistant should have just as much tool
 * access as any other mcp", then "yes go" to public links, website publishing
 * and image addresses) that a text has everything an MCP client has. The key
 * export stays out because non-negotiable #1 does: with any write tool it
 * puts the key that opens every encrypted note into the bucket beside them,
 * in plain text.
 */
export const WITHHELD_TOOLS = new Map([
  ["export_encryption_keys", "returns the workspace data key in the clear; with a write it lands in the bucket"],
]);

/** Fields of an offered tool a text never passes, with the reason. None. */
export const WITHHELD_FIELDS = new Map();

const ROUTINE_HELP =
  " Routines are notes the assistant runs on a schedule as this person, then texts them what it found. " +
  "A routine lives at routines/<how-often>/<name>.md. The folder says how often: every-5-minutes, hourly, " +
  "every-3-hours, daily, weekly, every-2-weeks, monthly. Optional lines at the top, between --- lines: " +
  "at: 7:30 am, on: weekdays (or Fridays, or a day of the month for monthly), send: text | note | both, " +
  "to: @handle (default: the writer), until: <when to stop>, paused: yes. " +
  "The body is plain instructions for the assistant, written as the person asked. " +
  "After saving, tell them where it is in words (routines › daily › Morning brief) and that deleting it stops it.";

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
    ...(tool.name === "write_note" ? { description: `${tool.description}${ROUTINE_HELP}` } : {}),
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
    const inRoutines = path.startsWith("routines/");
    if (inRoutines && path.endsWith(".md") && routineFromPath(path)?.kind !== "routine") {
      return "Only a routine file can be written under routines/: routines/<how-often>/<name>.md, with a folder like daily or weekly.";
    }
    // A routine runs as the person who wrote it, in their own context.
    if (inRoutines && name === "write_note" && args.context !== undefined) {
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
export function textingAwareCallTool(callTool, writeTools) {
  const accepted = new Map(writeTools.map((tool) => [tool.name, Object.keys(tool.inputSchema?.properties ?? {})]));
  return (name, args) => {
    const fields = accepted.get(name);
    if (fields === undefined) return callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const extra = Object.keys(given).filter((key) => !fields.includes(key));
    if (extra.length > 0) return toolError(`${extra.join(", ")} can't be passed from a text.`);
    const refusal = refusalFor(name, given);
    if (refusal) return toolError(refusal);
    return callTool(name, given);
  };
}
