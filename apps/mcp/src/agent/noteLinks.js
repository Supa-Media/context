/**
 * What a refused visibility change ends with (Training 2026-11-19): the model reads it, so a refusal is never taken for a
 * change made. The sixTools resolver appends it to its own refusals (`sixTools.js`); a set_visibility or
 * set_folder_visibility result that is an error gets it here.
 */
export const NOTHING_CHANGED = "Refused: no access was given beyond what this says, so don't tell anyone they can open it.";
const VISIBILITY_TOOLS = new Set(["set_visibility", "set_folder_visibility"]);

/** A refusal's text with the NOTHING_CHANGED sentence after it, on its own sentence (a full stop added where it has none). */
export function withNothingChanged(text) {
  const refusal = text.replace(/\s+$/, "");
  return `${/[.!?]$/.test(refusal) ? refusal : `${refusal}.`} ${NOTHING_CHANGED}`;
}

/** A failed visibility change's text, with the NOTHING_CHANGED sentence last; any other result as it came. */
function nothingChanged(name, result) {
  const first = result?.content?.[0];
  if (result?.isError !== true || !VISIBILITY_TOOLS.has(name) || typeof first?.text !== "string") return result;
  return { ...result, content: [{ ...first, text: withNothingChanged(first.text) }, ...result.content.slice(1)] };
}

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

import { isPagePath } from "../pages.js";
import { isTexOwnNote, noteWrite } from "./pageNotice.js";

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

/**
 * `<origin>/note/@slug/<path>`, every segment encoded and the `@` left
 * readable; a page's is `<origin>/p/@slug/<path>`, which opens the page
 * viewer rather than the app (owner, 2026-11-10: a page should open
 * "seamlessly"; `infra/router/src/pageViewer.ts`). The viewer grants nothing
 * either: it reads with the browser's own sign-in, and hands anything it can't
 * open to the `/note/…` link.
 */
export function noteLinkUrl(origin, slug, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const route = /\.page\.md$/i.test(path) ? "p" : "note";
  return `${origin}/${route}/@${encodeURIComponent(slug)}/${encoded}`;
}

/** A path that opens with a workspace's name: the `@name/path` sugar the router reads (`tools/pathAddress.js`). */
const PATH_NAMED = /^@([a-z0-9][a-z0-9-]*)\//i;

/**
 * The context a call named (`context: "@name"`, or a `path`/`id` that opens with `@name/`), else the turn's own.
 * A read of `@v2l/projects/x.md` named its workspace only in the path, and its link said the turn's own
 * workspace, which Tex then believed and texted (2026-11-16).
 */
function slugFor(args, contexts) {
  const named = typeof args?.context === "string" ? args.context.trim().replace(/^@/, "") : "";
  if (named !== "") return named;
  for (const field of ["path", "id", "note"]) {
    const match = typeof args?.[field] === "string" ? PATH_NAMED.exec(args[field].trim()) : null;
    if (match) return match[1];
  }
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

/** The note tools whose refusals can name a path or a folder to use instead. */
const NAMES_PLACES = new Set(["write_note", "read_note", "move_note", "archive_note", "set_visibility"]);

/**
 * A refused note call says which workspace refused it (owner, 2026-11-17): a write that named no workspace was
 * refused in the turn's own with "Projects is already here … Use Projects/…", and Tex took that folder's name into
 * another workspace. The message is the tool's own words; only the workspace is put in front.
 */
function inWorkspace(name, args, contexts, result) {
  if (!NAMES_PLACES.has(name)) return result;
  const first = result?.content?.[0];
  const slug = slugFor(args, contexts);
  if (typeof first?.text !== "string" || slug === null || first.text.startsWith("In @")) return result;
  return { ...result, content: [{ ...first, text: `In @${slug}: ${first.text}` }, ...result.content.slice(1)] };
}

/**
 * A TEXTED TURN'S FLOOR: THE SAVED NOTE'S LINK ON ITS OWN LINE (owner's report, 2026-11-19).
 *
 * Tex saved an offboarding checklist, then texted "Here it is" with no link. The `link:` line above
 * is the model's to pass on, and it sometimes drops it. So the turn keeps `saved`, the deliverable
 * notes it made, and `withSavedLink` (run on the reply that gets texted, `texEntryPoint/sendTheReply.js`)
 * adds the last one's link when the reply does not already link it.
 *
 * A deliverable is a write_note that made a note this turn (or a page, created or changed), and it is
 * not a comment, a mail, a site or a share (a share's own result carries the link to send), nor one of
 * Tex's own notes and records (`isTexOwnNote`: memory, to-dos, routines, the inbox). An update to a plain
 * note that already existed does not count: it is often a fact kept in a topic note, not the answer. A
 * later archive or move of a saved note takes it back out, since its plain copy is no longer there
 * (a page written, then the plain copy archived by the page's own steps). `remember` never counts.
 */

/** The write_note's path (from its `written:` line) when the save counts as a deliverable, else null. */
function deliverablePath(name, args, result) {
  const written = noteWrite(name, args, result);
  const path = WRITTEN.exec(result?.content?.[0]?.text ?? "")?.[1];
  if (written === null || !path || ["comment", "mail", "site", "share"].some((key) => args?.[key] != null)) return null;
  if (isTexOwnNote(path)) return null;
  return written.created === true || isPagePath(path) ? path : null;
}

/** The path a saved call's key: no leading slash, case-insensitive. */
const keyOf = (path) => String(path ?? "").trim().replace(/^\/+/, "").toLowerCase();

/** The path an archive or move took out of its place, or undefined for any other call. */
function leftBehind(name, args) {
  if (name === "archive_note") return args?.path;
  if (name === "move_note") return args?.source;
  return undefined;
}

/** Add `entry` to `saved` at the end, replacing one for the same note. */
function remember(saved, entry) {
  const at = saved.findIndex((item) => item.slug.toLowerCase() === entry.slug.toLowerCase() && keyOf(item.path) === keyOf(entry.path));
  if (at !== -1) saved.splice(at, 1);
  saved.push(entry);
}

/** Take every saved note at `path` back out. */
function forget(saved, path) {
  const key = keyOf(path);
  if (key === "") return;
  for (let at = saved.length - 1; at >= 0; at--) if (keyOf(saved[at].path) === key) saved.splice(at, 1);
}

/**
 * Wrap a dispatcher so a successful `write_note` or `read_note` answers with
 * the note's link as well, and `saved` (the turn's own array) keeps the
 * deliverable notes it saved (`withSavedLink`). Everything else, a failed call
 * included, passes through untouched.
 */
export function withNoteLinks(callTool, { origin, contexts, saved = null }) {
  // No origin means no links, but a refused visibility change still says nothing changed.
  if (origin === null) return async (name, args) => nothingChanged(name, await callTool(name, args));
  return async (name, args) => {
    const result = await callTool(name, args);
    if (result?.isError) return nothingChanged(name, inWorkspace(name, args, contexts, result));
    const gone = saved !== null ? leftBehind(name, args) : undefined;
    if (gone !== undefined) forget(saved, gone);
    if (name !== "write_note" && name !== "read_note") return result;
    const first = result?.content?.[0];
    const slug = slugFor(args, contexts);
    if (typeof first?.text !== "string" || slug === null) return result;
    const text = linked(name, args, first.text, origin, slug);
    if (!text) return result;
    const path = saved !== null && name === "write_note" ? deliverablePath(name, args, result) : null;
    if (path !== null) remember(saved, { slug, path, url: noteLinkUrl(origin, slug, path) });
    return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
  };
}

/**
 * The reply with the last saved note's link on its own line, when it does not already link one
 * of them (`withNoteLinks`). Unchanged for no origin, no saved note, or a blank reply. A link
 * matches by its exact url or by the note it points at (slug and path, case-insensitive, so the
 * `/p/` and `/note/` shapes and encoded variants count). Only one link is ever appended.
 */
export function withSavedLink(answer, saved, origin) {
  if (origin === null || !Array.isArray(saved) || saved.length === 0 || typeof answer !== "string" || answer.trim() === "") return answer;
  if (saved.some((entry) => answer.includes(entry.url))) return answer;
  const linkedAlready = sentNoteLinks(answer, origin, { limit: 20 }).some((link) =>
    saved.some((entry) => entry.slug.toLowerCase() === link.slug.toLowerCase() && keyOf(entry.path) === keyOf(link.path)),
  );
  if (linkedAlready) return answer;
  return `${answer.replace(/\s+$/, "")}\n${saved[saved.length - 1].url}`;
}

/**
 * A NOTE LINK THEY TEXT IS THE NOTE (owner's report, 2026-10-21).
 *
 * Dev pasted the context.lc link of yesterday's meeting note after Tex said
 * it had no notes from the call, and Tex answered about the link's preview
 * picture ("just a hashtag icon", "the Context banner") before it read the
 * note. So a link of this deployment's own to a note, in any shape it opens
 * (`/note/@slug/<path>`, `/p/@slug/<page>`, `/console/@slug?note=<path>`), is named to the
 * turn as the note it points at, to be read with the turn's own tools. It
 * grants nothing: the read goes through the dispatcher and `canSee` like any
 * other, so a link to a note they cannot see reads as one that is not there.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_SENT_LINKS = 3;

/** The notes a text links to, as `{ slug, path }`, read off this deployment's own addresses only. */
export function sentNoteLinks(text, origin, { limit = MAX_SENT_LINKS } = {}) {
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
      if ((segments[0] === "note" || segments[0] === "p") && segments[1]?.startsWith("@")) {
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
    if (found.length === limit) break;
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
