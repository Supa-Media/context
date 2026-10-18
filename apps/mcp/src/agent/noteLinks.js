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
 * No link when the deployment has no https `APP_ORIGIN`, when the context's
 * name is not known, or when the write did not succeed: a guessed link opens
 * nothing, and that is worse than none.
 */

const WRITTEN = /^written: (.+?) \(etag /;

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

/**
 * Wrap a dispatcher so a successful `write_note` answers with its link as well.
 * Everything else, a failed write included, passes through untouched.
 */
export function withNoteLinks(callTool, { origin, contexts }) {
  if (origin === null) return callTool;
  return async (name, args) => {
    const result = await callTool(name, args);
    if (name !== "write_note" || result?.isError) return result;
    const first = result?.content?.[0];
    const match = typeof first?.text === "string" ? WRITTEN.exec(first.text) : null;
    const slug = slugFor(args, contexts);
    if (match === null || slug === null) return result;
    const line = `\nlink: ${noteLinkUrl(origin, slug, match[1])} (text this on its own line so they can open the note)`;
    return { ...result, content: [{ ...first, text: first.text + line }, ...result.content.slice(1)] };
  };
}
