/**
 * Turning selected words into a link: what the Link sheet offers, and the
 * Markdown each choice writes.
 *
 * ## Why this exists
 *
 * The accessory bar's link key used to throw the selection away and write
 * `[[]]` (A2). The owner selected some words, pressed it and lost them, and
 * asked for what every editor does instead: select, press the key, and link
 * those words to a web page, a note, or a name. That is three kinds of link
 * and one field — paste an address, or type to find a note — so the sheet is
 * one list whose rows come from here.
 *
 * ## Why a module with no editor in it
 *
 * The sheet is native React Native on iOS and must not import CodeMirror
 * (`editorBundle.test.ts`), while the text is rewritten inside the editor. The
 * two halves meet in a `LinkTarget`, which crosses the web view bridge as
 * data, and in `linkMarkdown`, which both the guest and the tests call. So
 * what a pick writes is decided once, as a function of two strings.
 */

import { noteChoices } from "./noteChoices";
import { webUrl } from "./webUrl";

/**
 * What a row of the sheet links to. `note` covers both a note that exists and
 * one that does not yet: either way it is written as a wikilink, and a
 * wikilink to a name nobody has written is how a note gets asked for here.
 */
export type LinkTarget = { kind: "url"; url: string } | { kind: "note"; target: string };

/**
 * The web page `typed` names, or `null`.
 *
 * `webUrl` is the one judge of "is this an address" in the app — the same
 * function a click on a link consults — so what the sheet offers to link is
 * exactly what the editor will later offer to open. Only `http(s)`: a bare
 * `name@example.com` is `mailto:` to `webUrl`, and in this field it is far
 * more likely somebody typing a note's name.
 */
export function webPageAddress(typed: string): string | null {
  const url = webUrl(typed);
  return url !== null && /^https?:/i.test(url) ? url : null;
}

/**
 * Whether selected text can be the words of a link.
 *
 * Neither link form survives a line break or a square bracket in its words:
 * `parseLinks` (`packages/shared/src/links.ts`) reads `[^\]\n]` for both, so
 * such a link would be written and then never recognised — a link that looks
 * like one to the person and is plain text to every reader after them. The key
 * falls back to inserting `[[]]` beside the selection instead of offering a
 * choice that cannot work.
 */
export function linkableLabel(text: string): boolean {
  return text.trim() !== "" && !/[\n\r[\]]/.test(text);
}

/**
 * The name a typed phrase links to, when no note answers to it: the phrase,
 * trimmed, with the characters a wikilink target cannot hold taken out
 * (`]` ends it, `|` starts its words, `[` opens another). `null` when nothing
 * is left.
 */
export function freeTextTarget(typed: string): string | null {
  const target = typed.replace(/[[\]|\n\r]/g, "").replace(/\s+/g, " ").trim();
  return target === "" ? null : target;
}

/**
 * An address as an inline link's destination. The four characters that
 * would end or confuse `(…)` are percent-encoded, which is the same address.
 */
function destination(url: string): string {
  return url.replace(/[()<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The Markdown for `label` linked to `target`.
 *
 * Whitespace at either end of the selection stays outside the link — a
 * double-tap on a phone often takes the space after a word, and
 * `[plan ](…)` underlines a space. A note whose target is the words
 * themselves is written `[[words]]` rather than `[[words|words]]`.
 */
export function linkMarkdown(label: string, target: LinkTarget): string {
  const lead = /^\s*/.exec(label)?.[0] ?? "";
  const trail = /\s*$/.exec(label.slice(lead.length))?.[0] ?? "";
  const words = label.slice(lead.length, label.length - trail.length);
  const link =
    target.kind === "url"
      ? `[${words}](${destination(target.url)})`
      : target.target === words
        ? `[[${words}]]`
        : `[[${target.target}|${words}]]`;
  return `${lead}${link}${trail}`;
}

/**
 * A `LinkTarget` read off the web view bridge, or `null`.
 *
 * This payload becomes an edit, so it is checked rather than assumed — the
 * rule `decodeCommand` states for every command. An address must be one
 * `webPageAddress` itself would have produced, so nothing the sheet could not
 * have offered (`javascript:`, credentials in front of a host) is written into
 * a note; a note target must be a string a wikilink can hold.
 */
export function decodeLinkTarget(value: unknown): LinkTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const link = value as { kind?: unknown; url?: unknown; target?: unknown };
  if (link.kind === "url") {
    return typeof link.url === "string" && webPageAddress(link.url) === link.url
      ? { kind: "url", url: link.url }
      : null;
  }
  if (link.kind === "note") {
    return typeof link.target === "string" && link.target.trim() !== "" && !/[[\]|\n\r]/.test(link.target)
      ? { kind: "note", target: link.target }
      : null;
  }
  return null;
}

/** One row of the Link sheet. */
export interface LinkRow {
  readonly key: string;
  readonly icon: "globe" | "file" | "plus";
  readonly title: string;
  readonly detail: string;
  readonly link: LinkTarget;
}

/** How many notes the sheet lists: what fits above a phone's keyboard. */
export const SHEET_NOTE_ROWS = 5;

/**
 * The sheet's rows for what is in the field.
 *
 * - An address: one row, "Link to this web page". Nothing else — a URL is
 *   not a note's name, and a list of notes that happen to contain "https"
 *   would push the one row that matters off a phone screen.
 * - Anything else: the notes `[[` would offer for the same letters
 *   (`noteChoices`, with the same rooted target), then `Link to "<typed>"`,
 *   a wikilink to the phrase itself — a note that may not exist yet.
 * - Nothing typed: no rows. The sheet shows its hint instead.
 */
export function linkRows(
  typed: string,
  paths: readonly string[],
  self: string | null,
): LinkRow[] {
  const query = typed.trim();
  if (query === "") return [];

  const url = webPageAddress(query);
  if (url !== null) {
    return [{ key: "web", icon: "globe", title: "Link to this web page", detail: url, link: { kind: "url", url } }];
  }

  const rows: LinkRow[] = noteChoices(query, paths, self)
    .slice(0, SHEET_NOTE_ROWS)
    .map((choice) => ({
      key: `note:${choice.insert}`,
      icon: "file",
      title: choice.label,
      detail: choice.folder === "" ? "Top level" : choice.folder,
      link: { kind: "note", target: choice.insert },
    }));

  const free = freeTextTarget(query);
  if (free !== null) {
    const named = rows.some((row) => row.title.toLowerCase() === free.toLowerCase());
    rows.push({
      key: "free",
      icon: "plus",
      title: `Link to "${free}"`,
      // "May": the note list is what this surface has loaded, not the bucket.
      detail: named ? "Links by name" : "A note that may not exist yet",
      link: { kind: "note", target: free },
    });
  }
  return rows;
}
