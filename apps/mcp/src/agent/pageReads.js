/**
 * WHICH LINKS A TURN REALLY READ (self-review 7ad738, the Tex Devs group,
 * 2026-10-31; theme read-claims-contradict).
 *
 * Sent an X post a second time, Tex called open_page, got back X's sign-in
 * wall, and described the post anyway. `readClaims.js` sent back a summary of
 * a link only when nothing on the web had been read, and an open_page call
 * that returned a wall counted as reading. Here a page counts as read only
 * when its result (`computer.js` `pageText`, `browse.js` `readingText`) carries
 * a body worth the name at that page's own address: not "(no text)", not a
 * few lines, not a sign-in or script wall, and not a redirect to somewhere
 * else, which is where a wall usually lives.
 */

import { THIN_PAGE_CHARS } from "./publishedText.js";

/** A short page saying it can't be read: a sign-in, a script or a robot wall, an error. */
const WALL =
  /\b(?:sign in|log in|sign up|create (?:an|your) account|javascript is (?:not available|disabled)|enable javascript|turn on javascript|something went wrong|try again later|access denied|forbidden|are you a robot|verify you are (?:a )?human|captcha|rate limit|page (?:not found|doesn['’]t exist|isn['’]t available)|this (?:post|tweet|page|account) (?:is unavailable|doesn['’]t exist))\b/i;
/** Below this, a page with a wall's words is taken for the wall. */
const WALL_PAGE_CHARS = 1_500;

/** An address as one page: "https://www.twitter.com/a/status/1?s=20" and "https://x.com/a/status/1/" match. */
export function pageKey(address) {
  try {
    const url = new URL(String(address ?? "").trim());
    const host = url.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, "").replace(/^twitter\.com$/, "x.com");
    return `${host}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return null;
  }
}

/** The links written in a text. */
export function linksIn(text) {
  return [...String(text ?? "").matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((match) => match[0].replace(/[.,;:!?]+$/, ""));
}

/** Whether a page's body is worth the name: a wall, an empty or a thin page is not. */
export function usableBody(body) {
  const text = String(body ?? "").trim();
  if (text === "" || text === "(no text)" || text.length < THIN_PAGE_CHARS) return false;
  return !(text.length < WALL_PAGE_CHARS && WALL.test(text));
}

/** The pages a web tool result really read, as `pageKey`s: one per part with a usable body. */
export function pagesRead(text) {
  const read = new Set();
  for (const part of String(text ?? "").split(/\n-{3}\n/)) {
    const address = part.match(/^Address: (\S+)/m);
    if (address === null) continue;
    const after = part.slice(address.index + address[0].length);
    const body = after.split(/\n(?:Links you can open:|Pictures on the page|Logo \(a logo|Almost no text came back|Something is drawn over this page|What you can press or type into)/)[0];
    const key = pageKey(address[1]);
    if (key !== null && usableBody(body.replace(/\n\[cut[^\n]*$/, ""))) read.add(key);
  }
  return read;
}
