/**
 * THE PAGES A CHAT ALREADY OPENED, HANDED TO A JOB IT STARTS (Dev2, 2026-11-12).
 *
 * In the Nov Babies chat the front door opened popkaraoke32.com, mskims.co,
 * japasny.com and karaokecitynyc.com, then started a job whose brief named the
 * venues and their street addresses but none of those web addresses. A job
 * can't see what the chat's earlier turns read, so it guessed: popkaraoke.com
 * (a parked domain), muses35.com, mskimslounge.com, japasnyc.com and
 * santotacounion.com. So when a job starts, the addresses this chat's answers
 * opened (`sources.js`, kept with each answer, the same list a later text may
 * open again: `turnWeb.js` `pagesOpenedBefore`) go after its brief, written by
 * code, never by the model.
 *
 * Addresses only, never a page's words, so a job reads nothing it did not open
 * itself. Undoing it fails `apps/mcp/test/jobPages.test.mjs`.
 */

/** At most this many addresses, newest first, and this many characters in all: the brief stays under the job's cap. */
export const MAX_JOB_PAGES = 20;
const MAX_PAGES_CHARS = 1_900;
const MAX_ADDRESS = 200;

/** The chat's opened web addresses, newest kept, each once, `https://` only. */
export function chatPages(addresses) {
  const seen = new Set();
  const out = [];
  for (const address of [...(Array.isArray(addresses) ? addresses : [])].reverse()) {
    if (typeof address !== "string" || !address.startsWith("https://") || address.length > MAX_ADDRESS || /\s/.test(address)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
    if (out.length === MAX_JOB_PAGES) break;
  }
  return out.reverse();
}

/** What goes after a job's brief: the addresses, and to open those rather than guess one. "" when there are none. */
export function pagesSection(addresses) {
  const pages = chatPages(addresses);
  if (pages.length === 0) return "";
  const head = "\n\nPages this chat already opened (open a place's site by its exact address here; never guess a web address):";
  // Newest first while they fit, then back in the order they were opened.
  const kept = [];
  let size = head.length;
  for (const page of [...pages].reverse()) {
    if (size + page.length + 3 > MAX_PAGES_CHARS) break;
    kept.unshift(page);
    size += page.length + 3;
  }
  return kept.length === 0 ? "" : `${head}${kept.map((page) => `\n- ${page}`).join("")}`;
}
