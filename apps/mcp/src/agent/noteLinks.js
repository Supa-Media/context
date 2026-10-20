/**
 * A TEXTED WRITE ANSWERS WITH THE NOTE'S LINK (the owner, 2026-10-18).
 *
 * Dev asked for the landing page to show Tex replying to a link "with the
 * note", and then for it to be true: when Tex saves or changes a note, the
 * text says where it went and links to it, so the person can open it and
 * edit it.
 *
 * The prompt lets Tex state only a link it read in a tool result, so the link
 * has to be in one. This adds it to `write_note`'s own result on a texted
 * turn, built here rather than by the model: `<APP_ORIGIN>/note/@<slug>/<path>`,
 * the readable link format the app's `/note/…` route redirects to the
 * console's canonical address (`apps/mobile/features/console/noteLink.ts`).
 *
 * It grants nothing. Opening it is a sign-in and the console's own
 * permission check, like the team link the share sheet copies, and a text is
 * only ever answered in a one-to-one chat with the person whose turn wrote
 * the note (group chats never reach a personal context).
 *
 * A TEXTED READ ANSWERS WITH IT TOO (the owner, 2026-10-20).
 *
 * Tex answered "Give me the link" with "I don't have a web link for it" for an
 * SOP it had just summarised from a shared workspace: the read gave it no link
 * to state, so the ground rule against guessed links held it back. Dev asked
 * that a texted answer taken from a note link to it when the whole note would
 * help, and that an asked-for link is always given. So `read_note` answers
 * with the same link, in its header after `path:`, in whichever context the
 * call named, a shared one included. It is the app link for people who can
 * already see the note, never a share link: one of those is minted only when
 * they ask for a link to send someone else.
 *
 * No link when the deployment has no https `APP_ORIGIN`, when the context's
 * name is not known, or when the call did not succeed: a guessed link opens
 * nothing, and that is worse than none.
 */

const WRITTEN = /^written: (.+?) \(etag /;
const READ = /^(etag: [^\n]*\npath: ([^\n]+))/;

/** What a texted turn is told about the links its reads and writes carry, whatever its setup says. */
export const NOTE_LINK_LINE =
  "A note you read or write by text comes back with a link: line, which opens it in the Context app for anyone who can already see it. " +
  "When your answer comes from one note and the whole note would help them (steps, a long list, a document), send that link on its own line after the answer. " +
  "When they ask for a note's link, send it; if you have none yet, read the note to get it. Never say you don't have a link to a note you can read. " +
  "Make a share link only when they ask for one to send to someone else.";

/** The deployment's https origin, without a trailing slash, or null. */
export function appOriginOf(env) {
  const origin = typeof env?.APP_ORIGIN === "string" ? env.APP_ORIGIN.replace(/\/$/, "") : "";
  return /^https:\/\/[^/]+$/.test(origin) ? origin : null;
}

/** `<origin>/note/@slug/<path>`, every segment encoded and the `@` left readable. */
export function noteLinkUrl(origin, slug, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${origin}/note/@${encodeURIComponent(slug)}/${encoded}`;
}

/** The context a call named (`context: "@name"`), else the turn's own. */
function slugFor(args, contexts) {
  const named = typeof args?.context === "string" ? args.context.trim().replace(/^@/, "") : "";
  if (named !== "") return named;
  const own = (contexts || []).find((entry) => entry?.current)?.name;
  return typeof own === "string" && own !== "" ? own : null;
}

/** The first text block with the link put in, or null when the call has none to give. */
function linked(name, args, text, origin, slug) {
  if (name === "write_note") {
    const match = WRITTEN.exec(text);
    return match && `${text}\nlink: ${noteLinkUrl(origin, slug, match[1])} (text this on its own line so they can open the note)`;
  }
  // A mail read answers with a note's mail, not the note.
  if (name === "read_note" && args?.mail === undefined) {
    const match = READ.exec(text);
    return match && `${match[1]}\nlink: ${noteLinkUrl(origin, slug, match[2])}${text.slice(match[1].length)}`;
  }
  return null;
}

/**
 * Wrap a dispatcher so a successful `write_note` or `read_note` answers with
 * the note's link as well. Everything else, a failed call included, passes
 * through untouched.
 */
export function withNoteLinks(callTool, { origin, contexts }) {
  if (origin === null) return callTool;
  return async (name, args) => {
    const result = await callTool(name, args);
    if ((name !== "write_note" && name !== "read_note") || result?.isError) return result;
    const first = result?.content?.[0];
    const slug = slugFor(args, contexts);
    if (typeof first?.text !== "string" || slug === null) return result;
    const text = linked(name, args, first.text, origin, slug);
    if (!text) return result;
    return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
  };
}
