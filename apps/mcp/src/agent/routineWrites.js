/**
 * The one place the texting assistant writes: routine files.
 *
 * Everywhere else the agent's writes are proposals (`turn.js`, "Writes are
 * proposals"), and that stays true. The owner decided on 2026-10-07 that
 * texting "every morning tell me..." makes the routine file and says where it
 * is (`docs/decisions/routines.md`), so a texting turn on a grant that can
 * write is offered `write_note` and `archive_note` with a narrower schema and
 * a narrower dispatcher: a path under `routines/` that names a schedule
 * folder, in the person's own context, with nothing but text. Anything else
 * the model names is refused here, before the client's dispatcher sees it.
 *
 * The routine's own run (`context_routines`) is never offered these: a
 * routine that could rewrite itself, or another one, would be instructions
 * that grow their own reach.
 */

import { routineFromPath } from "../../../../packages/shared/src/routines.cjs";
import { normalizePath } from "../notes/paths.js";
import { toolError } from "../tools/results.js";

const ROUTINE_HELP =
  "Routines are notes the assistant runs on a schedule as this person, then texts them what it found. " +
  "A routine lives at routines/<how-often>/<name>.md. The folder says how often: every-5-minutes, hourly, " +
  "every-3-hours, daily, weekly, every-2-weeks, monthly. Optional lines at the top, between --- lines: " +
  "at: 7:30 am, on: weekdays (or Fridays, or a day of the month for monthly), send: text | note | both, " +
  "to: @handle (default: the writer), until: <when to stop>, paused: yes. " +
  "The body is plain instructions for the assistant, written as the person asked. " +
  "After saving, tell them where it is in words (routines › daily › Morning brief) and that deleting it stops it.";

/** The agent's `write_note`: a routine file and nothing else. */
const WRITE_ROUTINE = {
  name: "write_note",
  title: "Write routine",
  description:
    `Create or change a routine file. Only paths under routines/ are accepted. ${ROUTINE_HELP} ` +
    "To change one, read_note it first and pass its etag as expected_etag.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "e.g. routines/daily/morning-brief.md" },
      content: { type: "string", description: "The whole file." },
      expected_etag: { type: "string", description: "From read_note, when changing an existing routine." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

/** The agent's `archive_note`: stop a routine, recoverably. */
const ARCHIVE_ROUTINE = {
  name: "archive_note",
  title: "Stop routine",
  description:
    "Stop a routine by moving its file to the archive, where it can be recovered. Only paths under routines/ are accepted.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

const ROUTINE_TOOLS = new Map([
  [WRITE_ROUTINE.name, { tool: WRITE_ROUTINE, args: ["path", "content", "expected_etag"] }],
  [ARCHIVE_ROUTINE.name, { tool: ARCHIVE_ROUTINE, args: ["path"] }],
]);

/**
 * The routine tools this turn may add to its list: only those the connection
 * itself was offered (so a read-only grant gets none), and only on a texting
 * turn. Decided by the caller from the grant, never from the request body.
 */
export function routineTools(offered, { texting }) {
  if (!texting) return [];
  const names = new Set(offered.map((tool) => tool.name));
  return [...ROUTINE_TOOLS.values()].filter(({ tool }) => names.has(tool.name)).map(({ tool }) => tool);
}

/** Whether `path` is a file the agent may write or archive. */
export function isRoutineFilePath(path) {
  // Exactly as written: a path the normalizer would change is not one to
  // guess at, and `..` never names a schedule folder.
  if (typeof path !== "string" || normalizePath(path) !== path) return false;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
  return routineFromPath(path)?.kind === "routine";
}

/**
 * Wrap the client's dispatcher so the routine tools only ever touch routine
 * files. Every other tool passes through untouched.
 */
export function routineAwareCallTool(callTool, routineToolNames) {
  const allowed = new Set(routineToolNames);
  return (name, args) => {
    const spec = ROUTINE_TOOLS.get(name);
    if (spec === undefined || !allowed.has(name)) return callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (Object.keys(given).some((key) => !spec.args.includes(key))) {
      return toolError(`Only ${spec.args.join(", ")} may be passed here.`);
    }
    if (!isRoutineFilePath(given.path)) {
      return toolError(
        "Only a routine file can be written here: routines/<how-often>/<name>.md, with a folder like daily or weekly.",
      );
    }
    return callTool(name, given);
  };
}
