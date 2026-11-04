/**
 * Links on a line that cannot attach their previews (Sendblue): each link's
 * picture sent by us, then the words with every link left tappable.
 *
 * The owner, 2026-11-03: "whenever there's a link and it's SendBlue
 * specifically, … we keep the link plain text tappable, but then we send a
 * preview image separately … for every single link". Sendblue attaches no
 * rich-link data and has no field for it, so Messages shows each link as a
 * grey "Tap to Load Preview" box (`pagePicture.ts`). Kept to the Sendblue
 * lines (`line.ts`, `groupLine.ts`), so another provider that attaches
 * previews itself (Linq's `link` part, WhatsApp's own) sends links as before.
 *
 * Two things make the grey box: a text that is only a link, and a text that
 * ends with one, which Messages splits off into a box of its own (the owner's
 * screenshot of a group's progress line, 2026-11-03). A link with words on both sides stays an
 * ordinary tappable link. So a text that ends with a bare link gets a full
 * stop after it (it was "(tap the link)" until the owner asked, 2026-11-03,
 * for "just a period"), one already ending in punctuation is left as it is,
 * and one that starts with a link gets "Link:" before it.
 *
 * A picture is never the only way to the link, and never holds the words
 * back: one that cannot be found, hosted or sent is skipped.
 */

import { noteLinkOf } from "./appCards";
import type { Fetch } from "./clients";
import type { Picture } from "./line";
import type { NoteCardDrawer } from "./noteCards";
import { pagePicture } from "./pagePicture";

/** Pictures sent ahead of one text; a long answer citing many pages sends the first few. */
export const MAX_LINK_PICTURES = 3;
/** What follows a link that would otherwise end its text: a full stop (the owner, 2026-11-03, replacing "(tap the link)": "can you just end it with a period"). */
export const TAP_HINT = ".";
/** What goes before a link that would otherwise start its text. */
export const LEAD_IN = "Link:";

const LINK = /https?:\/\/[^\s<>"]+/gi;
/** Punctuation that ends a sentence, not an address. */
const TRAILING = /[.,;:!?'"’”]+$/;

/** An address without the sentence's punctuation after it, and a `)` it did not open. */
function cleanLink(raw: string): string {
  let link = raw.replace(TRAILING, "");
  while (link.endsWith(")") && (link.match(/\(/g)?.length ?? 0) < (link.match(/\)/g)?.length ?? 0)) link = link.slice(0, -1).replace(TRAILING, "");
  return link;
}

/** The distinct links in a text, in order, at most `MAX_LINK_PICTURES`. Pure. */
export function linksIn(text: string): string[] {
  const links: string[] = [];
  for (const raw of text.match(LINK) ?? []) {
    const link = cleanLink(raw);
    if (link.length > "https://".length && !links.includes(link)) links.push(link);
    if (links.length >= MAX_LINK_PICTURES) break;
  }
  return links;
}

/**
 * The text with no link at either end, where Messages draws a box of its own
 * (`noteCards.ts` keeps a note's link off both ends for the same reason):
 * "…steps: <link>" becomes "…steps: <link>.", "<link> has it"
 * becomes "Link: <link> has it", and a lone link both. Anything else is
 * unchanged. Pure.
 */
export function tappable(text: string): string {
  let out = text.trim();
  if (out === "") return text;
  const last = /(https?:\/\/[^\s<>"]+)$/i.exec(out);
  if (last) {
    const raw = last[1]!;
    const link = cleanLink(raw);
    if (link.length > "https://".length && raw === link) out = `${out}${TAP_HINT}`;
  }
  if (/^https?:\/\/\S/i.test(out)) out = `${LEAD_IN} ${out}`;
  return out === text.trim() ? text : out;
}

/** A hosted picture address for one link, or null. Never throws. */
export type LinkPicture = (link: string) => Promise<string | null>;

/**
 * Finds and hosts a link's picture: a note's own drawn card for a link to a
 * note (its page shows only Context's general card), the page's `og:image`
 * for anything else. Null without a host to serve it from.
 */
export function linkPictureFinder(
  fetcher: Fetch,
  host: ((picture: Picture) => Promise<string>) | undefined,
  drawNote: NoteCardDrawer | undefined,
): LinkPicture {
  return async (link) => {
    if (!host) return null;
    try {
      const note = noteLinkOf(link);
      const picture = note ? (drawNote ? await drawNote(note) : null) : await pagePicture(fetcher, link);
      return picture ? await host(picture) : null;
    } catch {
      return null;
    }
  };
}

/**
 * One text on a Sendblue line: each link's picture first, in the text's
 * order, then the words with their links tappable. Resolves to what
 * `sendWords` resolves to. Only `sendWords` may throw.
 */
export async function sendWithLinkPictures<T>(
  text: string,
  find: LinkPicture | undefined,
  sendPicture: (address: string) => Promise<unknown>,
  sendWords: (text: string) => Promise<T>,
): Promise<T> {
  const links = linksIn(text);
  if (links.length === 0) return await sendWords(text);
  const addresses = find ? await Promise.all(links.map((link) => find(link).catch(() => null))) : [];
  let sent = 0;
  for (const address of addresses) {
    if (!address) continue;
    try {
      await sendPicture(address);
      sent += 1;
    } catch {
      // The words still go: the picture is never the only way to the link.
    }
  }
  console.log(JSON.stringify({ event: "sendblue_link_pictures", links: links.length, found: addresses.filter(Boolean).length, sent }));
  return await sendWords(tappable(text));
}
