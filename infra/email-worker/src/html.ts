/**
 * HTML → text for mail sent to a personal workspace's address: the shared
 * scanner every email path uses (`packages/shared/src/htmlText.cjs`, which
 * says why it is a character scanner and never a regex or a DOM, and how it
 * caps its output).
 *
 * By default a link becomes its words and nothing else. Ingestion asks for
 * `{ links: true }` (the owner, 2026-11-16): each link's http(s) address
 * follows its words in brackets, so a "Click here to view the report" keeps
 * the address behind it. The address is the sender's, untrusted like the rest
 * of the email; mailto, unsubscribe and already-visible addresses are left
 * out, each address is kept once, and the count is capped.
 */
import { htmlToText as sharedHtmlToText } from "../../../packages/shared/src/htmlText.cjs";

export function htmlToText(html: string, maxChars: number, onStep?: () => void, options?: { links?: boolean }): string {
  return sharedHtmlToText(html, maxChars, onStep, options);
}

/** Ingestion's converter: the text with each link's address kept. */
export function htmlToTextWithLinks(html: string, maxChars: number): string {
  return sharedHtmlToText(html, maxChars, undefined, { links: true });
}
