/**
 * What the texting assistant may write: the person's notes, and never who can
 * see them.
 *
 * The owner decided on 2026-10-08 ("Edit directly") that a texting turn edits
 * notes itself instead of only proposing, because a proposal has no screen to
 * be reviewed on from a phone (`docs/decisions/texting-assistant.md`). Before
 * that, the only write a text could make was a routine file (2026-10-07,
 * `docs/decisions/routines.md`); routines are still written through the same
 * `write_note`, and a path under `routines/` must still be a routine.
 *
 * So a texting turn on a grant that can write is offered `write_note`,
 * `archive_note` and `move_note` with narrower schemas, and a dispatcher in
 * front of the client's refuses anything the narrower schema leaves out
 * before the client's dispatcher sees it:
 *
 *  - no visibility, no team publish, no share link, no picture upload: an
 *    edit changes what a note says, never who can read it. A note the agent
 *    just read can tell it to publish something, and a personal context takes
 *    email from strangers into `0-inbox/`;
 *  - no move between contexts, for the same reason: carrying a note into a
 *    workspace other people read is publishing it;
 *  - no plumbing: `privacy.md` and anything under a dot folder are refused
 *    here as well as by the gateway, because `privacy.md` *is* the access
 *    control.
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

const ROUTINE_HELP =
  "Routines are notes the assistant runs on a schedule as this person, then texts them what it found. " +
  "A routine lives at routines/<how-often>/<name>.md. The folder says how often: every-5-minutes, hourly, " +
  "every-3-hours, daily, weekly, every-2-weeks, monthly. Optional lines at the top, between --- lines: " +
  "at: 7:30 am, on: weekdays (or Fridays, or a day of the month for monthly), send: text | note | both, " +
  "to: @handle (default: the writer), until: <when to stop>, paused: yes. " +
  "The body is plain instructions for the assistant, written as the person asked. " +
  "After saving, tell them where it is in words (routines › daily › Morning brief) and that deleting it stops it.";

const CONTEXT_ARG = {
  type: "string",
  description: 'Optional "@name" of another workspace they belong to. Omit for their own.',
};

/** The agent's `write_note`: any note's text, never its visibility. */
const WRITE_NOTE = {
  name: "write_note",
  title: "Write note",
  description:
    "Create a note or change one. To change one, read_note it first, keep everything they did not ask " +
    "to change, and pass its etag as expected_etag. Changes are saved straight away and kept in the " +
    "note's history. Afterwards, tell them which note you changed, in words. " +
    "This cannot change who can see a note. " +
    ROUTINE_HELP,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "e.g. 1-projects/garden/plan.md" },
      content: { type: "string", description: "The whole note." },
      expected_etag: { type: "string", description: "From read_note, when changing a note that exists." },
      summary: { type: "string", description: "One short sentence saying what changed, for the activity list." },
      context: CONTEXT_ARG,
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** The agent's `archive_note`: out of the way, recoverably. */
const ARCHIVE_NOTE = {
  name: "archive_note",
  title: "Archive note",
  description:
    "Move a note to the archive, where it can be recovered. There is no delete. " +
    "Archiving a routine stops it.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      expected_etag: { type: "string" },
      context: CONTEXT_ARG,
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** The agent's `move_note`: within the one context it is in. */
const MOVE_NOTE = {
  name: "move_note",
  title: "Move note",
  description:
    "Move or rename one note inside their own workspace. Links to it follow it. It cannot move a note " +
    "into another workspace.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", description: "The note's path now" },
      destination: { type: "string", description: "Its new path, ending in .md" },
      expected_source_etag: { type: "string" },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** Each tool, its allowed arguments, and the arguments that name a note. */
const TEXTING_WRITES = new Map([
  [WRITE_NOTE.name, { tool: WRITE_NOTE, paths: ["path"] }],
  [ARCHIVE_NOTE.name, { tool: ARCHIVE_NOTE, paths: ["path"] }],
  [MOVE_NOTE.name, { tool: MOVE_NOTE, paths: ["source", "destination"] }],
]);

/**
 * The write tools this turn may add to its list: only those the connection
 * itself was offered (so a read-only grant gets none), and only on a texting
 * turn. Decided by the caller from the grant, never from the request body.
 */
export function textingWriteTools(offered, { texting }) {
  if (!texting) return [];
  const names = new Set(offered.map((tool) => tool.name));
  return [...TEXTING_WRITES.values()].filter(({ tool }) => names.has(tool.name)).map(({ tool }) => tool);
}

/** Whether `path` is a file the agent may write or archive. */
export function isRoutineFilePath(path) {
  return isWritableNotePath(path) && routineFromPath(path)?.kind === "routine";
}

/**
 * Whether the agent may name `path` at all: a note, exactly as written, that
 * is not plumbing. A path the normalizer would change is not one to guess at,
 * and `..` never names a note.
 */
export function isWritableNotePath(path) {
  if (typeof path !== "string" || normalizePath(path) !== path) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return path.endsWith(".md") && !isPlumbing(path);
}

/** Why `path` is refused, or null when it may be written. */
function refusalFor(path, args) {
  if (!isWritableNotePath(path)) return "That path can't be written: use a note path ending in .md, outside hidden folders and privacy.md.";
  const inRoutines = path === "routines" || path.startsWith("routines/");
  if (inRoutines && routineFromPath(path)?.kind !== "routine") {
    return "Only a routine file can be written under routines/: routines/<how-often>/<name>.md, with a folder like daily or weekly.";
  }
  // A routine runs as the person who wrote it, in their own context.
  if (inRoutines && args.context !== undefined) return "Routines are written in their own workspace: leave out context.";
  return null;
}

/**
 * Wrap the client's dispatcher so the texting write tools only ever pass the
 * arguments their narrower schemas name, on note paths. Every other tool
 * passes through untouched.
 */
export function textingAwareCallTool(callTool, writeToolNames) {
  const allowed = new Set(writeToolNames);
  return (name, args) => {
    const spec = TEXTING_WRITES.get(name);
    if (spec === undefined || !allowed.has(name)) return callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const accepted = Object.keys(spec.tool.inputSchema.properties);
    if (Object.keys(given).some((key) => !accepted.includes(key))) {
      return toolError(`Only ${accepted.join(", ")} may be passed here.`);
    }
    for (const key of spec.paths) {
      const refusal = refusalFor(given[key], given);
      if (refusal) return toolError(refusal);
    }
    return callTool(name, given);
  };
}
