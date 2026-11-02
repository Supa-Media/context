import { parseInline, type Inline } from "../../../../share/markdown";
import { wikiTargetText } from "../../../files/livePreview/wikiTarget";

/**
 * One line of the map's card as runs a `<Text>` can draw: bold, italic, code,
 * struck and highlighted words, and links. The card used to draw a block's
 * source as it was typed, so `**Status:**` kept its asterisks and `[[V2L Org
 * Chart]]` its brackets (Dev2, 2026-10-28: "in map notes preview, links don't
 * show up properly"). Now it reads as the note does in the editor.
 *
 * Emphasis, code and web links come from the shared viewer's inline parser
 * (`share/markdown.ts`), so the card and a shared note agree on what is
 * markup. That parser draws a wiki link as its words only, because a share
 * reader cannot follow it; here the target is kept, so the card can open it.
 */

export type PeekStyle = "plain" | "strong" | "em" | "code" | "strike" | "mark";

/** A wiki link's target as written (`V2L Org Chart`, `#Adoption`), or a vetted web address. */
export type PeekLink = { kind: "note"; target: string } | { kind: "url"; href: string };

export type PeekRun = { text: string; style: PeekStyle; link?: PeekLink };

// Private-use characters stand in for each wiki link while the shared parser
// runs, so `**see [[X]]**` is still bold around a link. Any already in the
// note are dropped first: they draw as nothing, and must not forge a link.
const OPEN = "";
const CLOSE = "";
const STAND_IN = /(\d+)/g;
const WIKI = /!?\[\[([^[\]\n]+)\]\]/g;

export function peekRuns(source: string): PeekRun[] {
  const links: string[] = [];
  const marked = source
    .replace(/[]/g, "")
    .replace(WIKI, (whole) => `${OPEN}${links.push(whole) - 1}${CLOSE}`);
  const out: PeekRun[] = [];
  const push = (run: PeekRun) => {
    if (run.text === "") return;
    const last = out[out.length - 1];
    if (last && !last.link && !run.link && last.style === run.style) last.text += run.text;
    else out.push(run);
  };
  const literal = (text: string) => text.replace(STAND_IN, (_, i: string) => links[Number(i)] ?? "");
  const words = (text: string) => text.replace(STAND_IN, (_, i: string) => wikiLabel(links[Number(i)] ?? ""));

  for (const inline of parseInline(marked)) {
    const style = styleOf(inline);
    if (style === "code") {
      // Inside a code span nothing is markup, a wiki link included.
      push({ text: literal(inline.text), style });
    } else if ((inline.kind === "link" || inline.kind === "button") && !inline.href.startsWith("/")) {
      // A site path (`/about`) means a page of a published website, not a place this card can go.
      push({ text: words(inline.text), style, link: { kind: "url", href: inline.href } });
    } else {
      splitWiki("text" in inline ? inline.text : "", style, links, push);
    }
  }
  return out;
}

function styleOf(inline: Inline): PeekStyle {
  switch (inline.kind) {
    case "strong":
    case "em":
    case "code":
    case "strike":
    case "mark":
      return inline.kind;
    case "kbd":
      return "code";
    default:
      return "plain";
  }
}

function splitWiki(text: string, style: PeekStyle, links: readonly string[], push: (run: PeekRun) => void) {
  let from = 0;
  for (const m of text.matchAll(STAND_IN)) {
    push({ text: text.slice(from, m.index), style });
    const whole = links[Number(m[1])] ?? "";
    // An embed (`![[picture.png]]`) is a picture in the note; the card names it.
    if (whole.startsWith("!")) push({ text: wikiLabel(whole), style });
    else push({ text: wikiLabel(whole), style, link: { kind: "note", target: wikiTarget(whole) } });
    from = m.index + m[0].length;
  }
  push({ text: text.slice(from), style });
}

const inner = (whole: string) => whole.replace(/^!?\[\[/, "").replace(/\]\]$/, "");

function wikiTarget(whole: string): string {
  const body = inner(whole);
  const bar = body.indexOf("|");
  return (bar === -1 ? body : body.slice(0, bar)).trim();
}

/** As the editor draws it (`reveal.ts`): the alias, or the note's name and its anchor. */
function wikiLabel(whole: string): string {
  const body = inner(whole);
  const bar = body.indexOf("|");
  const alias = bar === -1 ? "" : body.slice(bar + 1);
  if (alias.trim() !== "") return alias;
  return wikiTargetText(bar === -1 ? body : body.slice(0, bar));
}
