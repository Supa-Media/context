/**
 * The mockup's markdown tinting, as a function.
 *
 * `docs/design/console-mockup.html` renders the note preview with the
 * frontmatter keys in blue and the heading in full-strength white. That is
 * design, not decoration — it is what makes a wall of monospace read as a
 * *note* rather than a config file — so it survives the move from a static
 * preview to a real editor, on the surfaces that are still previews:
 * `privacy.md`, and the read-only console on the landing page.
 *
 * Deliberately **not** a markdown parser. Two rules, both line-based, both
 * cheap enough to run on every keystroke if it ever needs to:
 *
 *  - a leading `---` block is frontmatter; its delimiters and its `key:`
 *    prefixes are tinted;
 *  - a line starting with `#` is a heading.
 *
 * Anything more (emphasis, links, code fences) would be a syntax highlighter,
 * and a half-correct one is worse than none — it mis-colours the customer's
 * own words. Plain text is the honest default.
 */

export interface HighlightSpan {
  text: string;
  tone?: "key" | "heading";
}

export function highlightMarkdown(text: string): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const lines = text.split("\n");

  // Frontmatter only counts at the very top of the file, which is what makes a
  // stray `---` further down a horizontal rule rather than a second block.
  let frontmatterEnd = -1;
  if (lines[0] === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      if (lines[index] === "---") {
        frontmatterEnd = index;
        break;
      }
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const newline = index === lines.length - 1 ? "" : "\n";

    if (frontmatterEnd >= 0 && (index === 0 || index === frontmatterEnd)) {
      push(spans, { text: `${line}${newline}`, tone: "key" });
      continue;
    }

    if (frontmatterEnd > 0 && index < frontmatterEnd) {
      const key = line.match(/^([A-Za-z0-9_-]+:)(.*)$/);
      if (key) {
        push(spans, { text: key[1], tone: "key" });
        push(spans, { text: `${key[2]}${newline}` });
        continue;
      }
    }

    if (/^#{1,6}\s/.test(line)) {
      push(spans, { text: line, tone: "heading" });
      push(spans, { text: newline });
      continue;
    }

    push(spans, { text: `${line}${newline}` });
  }

  return spans.filter((span) => span.text !== "");
}

/** Merge with the previous span when the tone matches, so runs stay whole. */
function push(spans: HighlightSpan[], span: HighlightSpan): void {
  const last = spans[spans.length - 1];
  if (last !== undefined && last.tone === span.tone) {
    last.text += span.text;
    return;
  }
  spans.push(span);
}
