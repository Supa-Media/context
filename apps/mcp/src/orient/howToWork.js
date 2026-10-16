/**
 * "How to work here": the standing rules `orient` gives every connection, in
 * about ten lines, instead of the long contract and write-surface boilerplate
 * it used to repeat. Plain on purpose: it is read by the agent before its
 * first answer.
 */

export const HOW_TO_WORK = [
  "- Call orient first in a session, and search before you ask the person something their notes may already answer.",
  "- To work on a note, fetch its path and keep the etag it returns. Pass that etag back as expected_etag when you write, so a concurrent edit is caught rather than overwritten.",
  "- Write back what you learn: write with action remember for a durable fact about the person, as you learn it, and write with action save_session before you end a session.",
  "- Pass context: \"@name\" on any call to work in another workspace. A path never names a workspace other than the one the call addresses.",
  "- Update the note that already covers a topic. Never start a near-duplicate of it.",
  "- Follow their conventions, not a template. The front page says how this workspace is organized and where things go; where it is silent, ask rather than inventing a filing system for somebody else's notes.",
  "- Do not invent folders. File into the built-in folders listed above. Where you cannot write a folder, queue the note with write action propose.",
  "- Each folder's description is the first line of its `about.md`. Read a folder's `about.md` before you work in that folder, and write or update its `about.md` with write when you learn what the folder is for.",
  "- Ask the person before anything that lets more people see something (manage visibility, share_link, website publish), and before every send.",
  "- Anti-patterns: inventing folders; staging content where you cannot write it; guessing at notes you cannot see, or reading a note that is missing as proof nothing is there; asking again what the notes already say.",
  "- The front page above is its first paragraph. fetch index.md for the rest, and orient about \"access\" for what you may write where.",
].join("\n");

/**
 * The same text in the older tools' names, for a caller that is offered those
 * and not the six: the texting assistant, whose list is built each turn from
 * the full (v1) list (`tools/advertised.js`). Telling it to call `write` would
 * send it after a tool it does not have.
 */
const OLDER_NAMES = [
  ["and search before", "and search_notes before"],
  ["fetch its path", "read it with read_note"],
  ["write with action remember", "remember"],
  ["write with action save_session", "save_context"],
  ["use write with action save_session", "use save_context"],
  ["queue the note with write action propose", "queue the note with propose_note"],
  ["`about.md` with write when", "`about.md` with write_note when"],
  ["(manage visibility, share_link, website publish), and before every send", "(set_visibility, create_link, publishing the website), and before calling anything outside Context"],
  ['fetch index.md for the rest, and orient about "access"', "read_note index.md for the rest, and scope_info"],
  ["Use fetch with `proposals:` to read them, and manage with action review_proposal", "Use list_proposals and read_proposal to read them, and review_proposal"],
];

/** `text` in the older names when the caller is offered the older tools. */
export function inToolNames(text, { v2 }) {
  if (v2) return text;
  return OLDER_NAMES.reduce((out, [from, to]) => out.split(from).join(to), text);
}
