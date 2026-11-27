/**
 * A NOTE'S APP LINK: `<APP_ORIGIN>/note/@<slug>/<path>`.
 *
 * The link that opens a note in the Context app, for anyone who can already
 * see it, built by `packages/shared/src/noteAppLink.cjs` for the gateway and Tex alike. Tex's texted reads and writes have carried it
 * since 2026-10-18 (`packages/tex/gateway/agent/noteLinks.js`); an MCP client's `write` and `fetch` carry it since 2026-11-27, when
 * Dev noticed an agent that had just created a note could not hand him a link
 * to it, and a guessed URL opens nothing.
 *
 * It grants nothing: opening it is a sign-in and the console's own permission
 * check (`apps/mobile/app/note/[...address].tsx`). It is never a share link;
 * those are minted on purpose with `manage` action `share_link`.
 *
 * No link when the deployment has no https `APP_ORIGIN`, when the workspace's
 * name is not known, or when the call did not succeed.
 */

import noteAppLink from "../../../../packages/shared/src/noteAppLink.cjs";

export const { appOriginOf, noteLinkUrl } = noteAppLink;

const WRITTEN = /^written: (.+?) \(etag /;
const READ = /^(etag: [^\n]*\npath: ([^\n]+))/;

/** What an MCP client is told beside the link, so it passes the link on rather than writing its own. */
export const APP_LINK_HINT = "(opens the note in the Context app for anyone who can already see it; give this to the person)";

/**
 * A `write_note` or `read_note` result with the note's app link in it: after
 * the written line's block for a write, after the `path:` line for a read.
 * Anything else, a failed call or a mail read included, comes back as it was.
 */
export function withAppLink(name, args, result, { origin, slug }) {
  if (origin === null || typeof slug !== "string" || slug === "") return result;
  if (result?.isError || (name !== "write_note" && name !== "read_note")) return result;
  if (name === "read_note" && args?.mail !== undefined) return result;
  const first = result?.content?.[0];
  if (typeof first?.text !== "string") return result;
  let text = null;
  if (name === "write_note") {
    const match = WRITTEN.exec(first.text);
    if (match) text = `${first.text}\nlink: ${noteLinkUrl(origin, slug, match[1])} ${APP_LINK_HINT}`;
  } else {
    const match = READ.exec(first.text);
    if (match) text = `${match[1]}\nlink: ${noteLinkUrl(origin, slug, match[2])}${first.text.slice(match[1].length)}`;
  }
  return text === null ? result : { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}
