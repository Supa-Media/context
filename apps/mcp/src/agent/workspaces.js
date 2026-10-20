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
 * When to offer a shared workspace (the owner, 2026-10-20: "once multiple
 * people are involved, suggest, hey, this is probably something that can be
 * in another workspace. Even if it's just one other person"). Many people
 * reach Context only through Tex, so a shared workspace that Tex never offers
 * is one they never make, and their work with others stays in a personal
 * workspace nobody else can open.
 *
 * Said whether they reach one workspace or several: someone with only their
 * personal one is exactly who has never been offered one. The offer is the
 * held create itself, people included (`tools/irreversible.js`), so the
 * gateway's own ask is the question and one yes makes it and invites them;
 * nothing is created or sent before that yes.
 */
const SUGGEST_SHARED =
  "When something they bring up is done with at least one other person (a business, a ministry, a nonprofit, a team, " +
  "a side project) and no shared workspace of theirs covers it, offer one, once: they could work on it there together. " +
  "Not for family, friends or a one-off plan; if they say no, remember that. To offer it, find the person's email or " +
  "@handle in their notes or contacts (or ask for it), then call manage create_workspace with slug, name and " +
  "invite: [{ who }]. It waits for their yes and Context asks them, so say in one sentence why and nothing more. " +
  'Never create a workspace or invite anyone without that yes. Add people later with manage action invite and context: "@name".';

/**
 * The system prompt's paragraphs: where a note goes when the person reaches
 * several workspaces, and when to offer a shared one, which is said either way.
 */
export function workspacesPrompt(contexts) {
  const list = Array.isArray(contexts) ? contexts.filter((entry) => typeof entry?.name === "string") : [];
  const suggest = `\n\n${SUGGEST_SHARED}`;
  if (list.length < 2) return list.length === 0 ? "" : suggest;
  const shown = list.slice(0, MAX_LISTED_WORKSPACES).map(describe).join("; ");
  const more = list.length > MAX_LISTED_WORKSPACES ? ` and ${list.length - MAX_LISTED_WORKSPACES} more (orient lists them all)` : "";
  const fallback = list.find((entry) => entry.current)?.name;
  return (
    `\n\nThey can reach these workspaces: ${shown}${more}. ` +
    `A tool call with no context: goes to ${fallback ?? "the default"}. ` +
    "Before writing a note, decide which workspace it belongs in: a note about a project, team, client or group goes where " +
    "that project's notes already are. Search first, and when the notes you find start with @name/, write beside them with " +
    'context: "@name". When they name a workspace, use it. Use the default only for notes about them alone, or when nothing ' +
    "points elsewhere; if two workspaces fit, ask which in one short question. Tell them which workspace you wrote in." +
    suggest
  );
}
