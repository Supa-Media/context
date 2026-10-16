/**
 * Which workspaces the person can reach, told to every turn, and where a new
 * note goes (the owner, 2026-10-14, relaying a friend: "it has a hard time
 * differentiating which workspace to write to. For some reason it was writing
 * v2l notes into my personal workspace").
 *
 * A call with no `context:` goes to the connection's own workspace, which for
 * a text is the person's personal one. Search already reaches every workspace
 * (`tools/search.js`), but a turn that writes a new note for a project had
 * nothing telling it the project's workspace exists, so the note landed in the
 * default. The names come from the session (`contextsFor`), the same list
 * `orient` and `scope_info` give: names and roles, never a note.
 */

/** A person in more workspaces than this gets the first ones and a pointer to scope_info. */
export const MAX_LISTED_WORKSPACES = 20;

function describe(entry) {
  const what = entry.kind === "personal" ? (entry.role === "owner" ? "their personal workspace" : "someone's personal workspace") : "shared";
  const reach = entry.canWrite ? "" : ", read only";
  return `${entry.name} (${what}${reach}${entry.current ? ", the default" : ""})`;
}

/**
 * The system prompt's paragraph, or "" when the person reaches one workspace
 * only, where there is no choice to get wrong.
 */
export function workspacesPrompt(contexts) {
  const list = Array.isArray(contexts) ? contexts.filter((entry) => typeof entry?.name === "string") : [];
  if (list.length < 2) return "";
  const shown = list.slice(0, MAX_LISTED_WORKSPACES).map(describe).join("; ");
  const more = list.length > MAX_LISTED_WORKSPACES ? ` and ${list.length - MAX_LISTED_WORKSPACES} more (orient lists them all)` : "";
  const fallback = list.find((entry) => entry.current)?.name;
  return (
    `\n\nThey can reach these workspaces: ${shown}${more}. ` +
    `A tool call with no context: goes to ${fallback ?? "the default"}. ` +
    "Before writing a note, decide which workspace it belongs in: a note about a project, team, client or group goes where " +
    "that project's notes already are. Search first, and when the notes you find start with @name/, write beside them with " +
    'context: "@name". When they name a workspace, use it. Use the default only for notes about them alone, or when nothing ' +
    "points elsewhere; if two workspaces fit, ask which in one short question. Tell them which workspace you wrote in."
  );
}
