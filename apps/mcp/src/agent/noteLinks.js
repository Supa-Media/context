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
 * A GROUP CHAT'S TURN ANSWERS WITH IT TOO (2026-10-21).
 *
 * Dev2 asked Tex in a group for "a share link for the read me" and was told
 * none could be made there. A group turn reads only the one workspace every
 * person in the chat is a member of, at its team tier, so the app link to a
 * note it read opens for each of them and for nobody else. A share link is
 * still the owner's, minted one to one.
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
  // A context may be listed by its address ("@band"); the link names it once.
  const own = (contexts || []).find((entry) => entry?.current)?.name;
  const slug = typeof own === "string" ? own.trim().replace(/^@/, "") : "";
  return slug !== "" ? slug : null;
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

/**
 * A NOTE LINK THEY TEXT IS THE NOTE (owner's report, 2026-10-21).
 *
 * Dev pasted the context.lc link of yesterday's meeting note after Tex said
 * it had no notes from the call, and Tex answered about the link's preview
 * picture ("just a hashtag icon", "the Context banner") before it read the
 * note. So a link of this deployment's own to a note, in either shape the app
 * opens (`/note/@slug/<path>`, `/console/@slug?note=<path>`), is named to the
 * turn as the note it points at, to be read with the turn's own tools. It
 * grants nothing: the read goes through the dispatcher and `canSee` like any
 * other, so a link to a note they cannot see reads as one that is not there.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_SENT_LINKS = 3;

/** The notes a text links to, as `{ slug, path }`, read off this deployment's own addresses only. */
export function sentNoteLinks(text, origin) {
  if (origin === null || typeof text !== "string") return [];
  const host = new URL(origin).host;
  const found = [];
  for (const [address] of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    let url;
    try {
      url = new URL(address.replace(/[).,;!?]+$/, ""));
    } catch {
      continue;
    }
    if (url.host !== host) continue;
    const segments = url.pathname.split("/").filter(Boolean);
    let slug = null;
    let path = null;
    try {
      if (segments[0] === "note" && segments[1]?.startsWith("@")) {
        slug = decodeURIComponent(segments[1].slice(1));
        path = segments.slice(2).map(decodeURIComponent).join("/");
      } else if (segments[0] === "console" && segments[1]?.startsWith("@") && url.searchParams.has("note")) {
        slug = decodeURIComponent(segments[1].slice(1));
        path = (url.searchParams.get("note") ?? "").split("#")[0];
      }
    } catch {
      continue;
    }
    if (!slug || !SLUG.test(slug) || !path || path.length > 512 || path.split("/").some((part) => part === "" || part === "." || part === "..")) continue;
    if (!found.some((link) => link.slug === slug && link.path === path)) found.push({ slug, path });
    if (found.length === MAX_SENT_LINKS) break;
  }
  return found;
}

/** What the turn is told about the note links in their text, or "". */
export function sentNoteLinksLine(text, origin) {
  const links = sentNoteLinks(text, origin);
  if (links.length === 0) return "";
  const named = links.map(({ slug, path }) => `fetch id "${path}" with context "@${slug}"`).join("; ");
  return (
    `Their text links to ${links.length === 1 ? "a note" : "notes"} in Context, not a web page: ${named}. ` +
    "Read it that way before you answer, never in the browser, and answer from what it says. " +
    "A picture that came with the link is only its preview card: don't mention it."
  );
}
