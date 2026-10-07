/**
 * An answer, made into texts.
 *
 * The gateway asks the model to write for iMessage (`systemPrompt` in
 * `apps/mcp/src/agent/turn.js`), but a model's habits leak, and iMessage shows
 * Markdown as the characters themselves: a `**name**` arrives with its
 * asterisks and a `[note](path)` as brackets. So the last step before sending
 * strips that formatting, the way a person retyping it would:
 *
 * - bold, italics, headings, code ticks and fences go; the words stay;
 * - a `[label](link)` keeps its label, and a web link is sent after the answer
 *   as a text of its own, which is how iMessage draws it as a card;
 * - a line that is nothing but a note path (a "source" line) goes, since
 *   it means nothing on a phone;
 * - paragraphs become separate texts, the way people text, with a list kept
 *   in the same text as the line that introduces it, and never more than
 *   `MAX_TEXTS` of them.
 */

export const MAX_TEXTS = 3;
const MAX_LINKS = 2;

const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const WEB_LINK = /^https:\/\/[^\s/]+(\/\S*)?$/;
const NOTE_PATH_LINE = /^((sources?|from|see):\s*)?[\w.][\w\-./ ]*\.md$/gim;
const LIST_ITEM = /^(- |\d+[.)] )/;

export function textsFromAnswer(answer: string): string[] {
  const links: string[] = [];
  let text = answer.replace(/\r\n?/g, "\n");

  text = text.replace(MARKDOWN_LINK, (_whole, label: string, href: string) => {
    if (WEB_LINK.test(href)) {
      if (!links.includes(href)) links.push(href);
      return label.trim() === href ? "" : label;
    }
    return label;
  });

  text = text
    .replace(/^```.*$/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[*+•]\s+/gm, "- ")
    .replace(/\*\*([^*]+?)\*\*/g, "$1")
    .replace(/__([^_]+?)__/g, "$1")
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/\*\*/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(NOTE_PATH_LINE, "");

  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  const texts: string[] = [];
  for (const paragraph of paragraphs) {
    if (texts.length > 0 && (LIST_ITEM.test(paragraph) || texts.length >= MAX_TEXTS)) {
      texts[texts.length - 1] += LIST_ITEM.test(paragraph) ? `\n${paragraph}` : `\n\n${paragraph}`;
    } else {
      texts.push(paragraph);
    }
  }

  const sent = texts.length > 0 ? texts : [answer.trim()];
  return [...sent, ...links.slice(0, MAX_LINKS)].filter((part) => part.length > 0);
}
