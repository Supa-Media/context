/**
 * Code notes: the files that give a website its own look.
 *
 * Every file in a site is a Markdown note, so `privacy.md`, history, live
 * editing, comments and every agent tool work on all of it. A code note is
 * one whose name says what language it holds, and it holds exactly one fenced
 * block in that language; the prose around the block is notes for people and
 * agents, never published:
 *
 * - `layout.html.md` — the frame around every page, with `{ content }`.
 * - `<name>.html.md` — a layout a page names with `layout: <name>`, or, when
 *   no page names it, an all-HTML page at `/<name>`.
 * - `<name>.css.md` — a stylesheet, applied to every page in name order.
 * - `<name>.js.md` — a script; never an address.
 *
 * Layouts and stylesheets live at the top of `website/`. A site with no code
 * notes is drawn exactly as before.
 */

// The names are read where routes are compiled, which node also loads on its
// own (scripts/devlog-copy.mjs), so they live there; this module adds the rest.
export {
  WEBSITE_FRAME_FILE,
  WEBSITE_LAYOUT_NAME,
  websiteCodeLanguage,
  websiteCodeName,
  type WebsiteCodeLanguage,
  type WebsiteCodeRole,
} from "../websiteRoutes";
import type { WebsiteCodeLanguage } from "../websiteRoutes";

const LANGUAGE_WORDS: Record<WebsiteCodeLanguage, ReadonlySet<string>> = {
  html: new Set(["html"]),
  css: new Set(["css"]),
  js: new Set(["js", "javascript"]),
};

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^\n]*$/;

export type CodeBlockResult = { code: string } | { problem: string };

/**
 * The one fenced block in `language` a code note holds.
 *
 * Blocks in other languages may sit in the prose as examples; two blocks in
 * the note's own language, or none, is a problem rather than a guess at
 * which one is meant.
 */
export function websiteCodeBlock(body: string, language: WebsiteCodeLanguage): CodeBlockResult {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const found: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const open = FENCE.exec(lines[index]!);
    if (open === null) {
      index += 1;
      continue;
    }
    const marker = open[1]!;
    const word = open[2]!.toLowerCase();
    const content: string[] = [];
    let closed = false;
    index += 1;
    while (index < lines.length) {
      const line = lines[index]!;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close !== null && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
        closed = true;
        index += 1;
        break;
      }
      content.push(line);
      index += 1;
    }
    if (!LANGUAGE_WORDS[language].has(word)) continue;
    if (!closed) return { problem: `The \`\`\`${language} block is not closed.` };
    found.push(content.join("\n"));
  }
  if (found.length === 0) {
    return { problem: `A .${language}.md note holds one \`\`\`${language} block, and this one has none.` };
  }
  if (found.length > 1) {
    return { problem: `A .${language}.md note holds one \`\`\`${language} block, and this one has ${found.length}.` };
  }
  return { code: found[0]! };
}
