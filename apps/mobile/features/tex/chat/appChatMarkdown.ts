/**
 * Tex's words as blocks, for the chat page.
 *
 * Pure, no React. A message from Tex is Markdown, but it is read by the same
 * safe parser a shared note is (`features/share/markdown.ts`): no HTML is ever
 * interpreted, every link is vetted, and nothing is fetched. This file only
 * maps that parser's blocks onto the few shapes the chat draws, and it keeps
 * the chat's own rules on top:
 *
 *  - Only an `https:` link is tappable, or a link to one of the person's notes.
 *    A bare domain (`supa.media`) stays words, as it does in `appChatText.ts`.
 *  - A link to a note (`/note/@slug/…` or `/p/@slug/…`) opens inside the app,
 *    so it becomes a `note` inline with the console's own address for it.
 *  - A paragraph that is only one note link is a `notecard`: a row the person
 *    can press, rather than a sentence with a link in it.
 *  - Anything the chat does not draw (quotes, code blocks, tables, rules,
 *    pictures) falls back to words, so nothing a message says disappears.
 */

import { parseNote, type Block, type Inline } from "../../share/markdown";
import { canonicalHrefFor, noteAddressFromLink } from "../../console/noteLink";
import { httpsHref, textPieces } from "./appChatText";

/** Emphasis carried by a run of words. A link or note inside bold keeps it. */
interface Marks {
  strong?: boolean;
  em?: boolean;
}

export type ChatInline =
  | ({ kind: "text"; text: string } & Marks)
  | { kind: "code"; text: string }
  | ({ kind: "link"; text: string; href: string } & Marks)
  /**
   * A link to one of the person's notes. `href` is the console address the app
   * opens; `url` is the link as the message wrote it, which is what a browser
   * gets if the caller has no note screen to open.
   */
  | ({ kind: "note"; text: string; href: string; path: string; url: string } & Marks);

export type ChatBlock =
  | { kind: "paragraph"; content: ChatInline[] }
  /** Drawn as a bold line: the chat has no headings, only words that weigh more. */
  | { kind: "heading"; content: ChatInline[] }
  | { kind: "bullet"; items: ChatInline[][] }
  | { kind: "ordered"; items: ChatInline[][] }
  | { kind: "notecard"; href: string; path: string; title: string; folder: string; url: string };

/**
 * A note link's console address and path, or `null` when the link is not one.
 *
 * The gateway writes `https://<host>/note/@slug/<path>` for a note and
 * `/p/@slug/<path>` for a page (`packages/tex/gateway/agent/noteLinks.js`).
 * A page is the same note under its other route, so `/p/` is rewritten to
 * `/note/` and read by the one parser. A relative path is accepted as well,
 * for a link written without its host.
 *
 * Path traversal is refused by that parser after decoding, so `%2e%2e` gives
 * `null` here, and the link stays a plain `https:` link.
 */
export function noteLinkOf(href: string): { href: string; path: string } | null {
  const match = /^(?:https:\/\/[^/?#]*)?\/(note|p)\/([\s\S]*)$/i.exec(href);
  if (match === null) return null;
  const address = noteAddressFromLink(`/note/${match[2]}`);
  if (address === null) return null;
  return { href: canonicalHrefFor(address), path: address.path };
}

/** A message's blocks. Pure: the same text always gives the same blocks. */
export function chatBlocks(text: string): ChatBlock[] {
  // A leading newline keeps a message that opens with `---` from being read as
  // a note's frontmatter and swallowed.
  const { blocks } = parseNote(`\n${text}`);
  return blocks.flatMap(blockOf);
}

function blockOf(block: Block): ChatBlock[] {
  switch (block.kind) {
    case "heading":
      return [{ kind: "heading", content: inlinesOf(block.content) }];
    case "paragraph":
      return [paragraphOf(inlinesOf(block.content))];
    case "bullet":
      return [{ kind: "bullet", items: block.items.map(inlinesOf) }];
    case "ordered":
      return [{ kind: "ordered", items: block.items.map(inlinesOf) }];
    case "quote":
      return [paragraphOf(inlinesOf(block.content))];
    case "code":
      return [paragraphOf([{ kind: "text", text: block.text }])];
    case "table": {
      // A table is drawn as one line of words per row, cells joined by a dot.
      const rows = [block.header, ...block.rows];
      return rows.map((cells) =>
        paragraphOf(cells.flatMap((cell, index) => (index === 0 ? inlinesOf(cell) : [{ kind: "text" as const, text: " · " }, ...inlinesOf(cell)]))),
      );
    }
    case "images":
      // Nothing is fetched. A picture in a message is its alt text, or its name.
      return [paragraphOf([{ kind: "text", text: block.images.map((image) => (image.alt.trim() !== "" ? image.alt : image.target)).join(" ") }])];
    case "rule":
      return [];
  }
}

/** A paragraph of only one note link is a card; anything else is a paragraph. */
function paragraphOf(content: ChatInline[]): ChatBlock {
  const words = content.filter((run) => !(run.kind === "text" && run.text.trim() === ""));
  const [only] = words;
  if (words.length === 1 && only !== undefined && only.kind === "note") {
    return { kind: "notecard", href: only.href, path: only.path, title: only.text, folder: folderOf(only.path), url: only.url };
  }
  return { kind: "paragraph", content };
}

/** The inline runs of the safe parser, with words and links split and vetted. */
function inlinesOf(parts: readonly Inline[]): ChatInline[] {
  const out: ChatInline[] = [];
  for (const part of parts) {
    switch (part.kind) {
      case "text":
        out.push(...wordsOf(part.text, {}));
        break;
      case "strong":
        out.push(...wordsOf(part.text, { strong: true }));
        break;
      case "em":
        out.push(...wordsOf(part.text, { em: true }));
        break;
      case "code":
        out.push({ kind: "code", text: part.text });
        break;
      case "link":
      case "button":
        out.push(...linkOf(part.text, part.href, {}));
        break;
      // Not drawn by the chat: their words, without the mark.
      case "strike":
      case "mark":
      case "underline":
      case "kbd":
        out.push(...wordsOf(part.text, {}));
        break;
      case "emoji":
        out.push({ kind: "text", text: part.text });
        break;
    }
  }
  return out;
}

/** Words with any bare `https:` link in them made tappable. */
function wordsOf(text: string, marks: Marks): ChatInline[] {
  const out: ChatInline[] = [];
  for (const piece of textPieces(text)) {
    if (piece.kind === "text") out.push({ kind: "text", text: piece.value, ...marks });
    else out.push(...linkOf(piece.value, piece.href, marks));
  }
  return out;
}

/**
 * One link as a chat inline: a note, an `https:` link, or words.
 *
 * A bare domain the parser turned into a link (`href` is `https://` plus the
 * text itself) is words here, because a link the person did not write as a
 * link is not one the chat offers.
 */
function linkOf(label: string, href: string, marks: Marks): ChatInline[] {
  const note = noteLinkOf(href);
  if (note !== null) {
    // A bare link has no label of its own: it is shown as the note's name.
    const bare = label.trim() === "" || label === href;
    const shown = bare ? titleOf(note.path) : label;
    return [{ kind: "note", text: shown, href: note.href, path: note.path, url: href, ...marks }];
  }
  const bareDomain = href === `https://${label}`;
  if (bareDomain || httpsHref(href) === null) return [{ kind: "text", text: label, ...marks }];
  return [{ kind: "link", text: label, href, ...marks }];
}

/** A note's name from its path: the last segment, without its extension, dashes as spaces. */
function titleOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const stem = last.replace(/\.page\.md$/i, "").replace(/\.md$/i, "").replace(/-/g, " ");
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

/** The folder a note sits in, `""` at the root. */
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * A message as the words a person reads, without its Markdown: what Copy puts on
 * the clipboard and what a reply's quote shows (the mock's `plain`). A link keeps
 * its words, a list item its bullet or number, a note card its title.
 */
export function chatPlainText(text: string): string {
  const words = (content: ChatInline[]) => content.map((inline) => inline.text).join("");
  return chatBlocks(text)
    .flatMap((block): string[] => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return [words(block.content)];
        case "bullet":
          return block.items.map((item) => `• ${words(item)}`);
        case "ordered":
          return block.items.map((item, index) => `${index + 1}. ${words(item)}`);
        case "notecard":
          return [block.title];
      }
    })
    .join("\n");
}
