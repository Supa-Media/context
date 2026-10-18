// Reading a channel-day note back with its bodies, for the console's day
// view. Split out of note.js, which renders and indexes the same notes; the
// two readers must agree with the renderer on every heading level.

import { FENCE_MARKER } from "./note.js";

/**
 * Attachment headings this reader understands.
 *
 * The renderer now labels the list once and marks only the individual rows it
 * could not store. Keep the earlier blanket label readable because existing
 * channel-day notes are canonical files in customer-owned buckets and are not
 * rewritten merely because the renderer improved.
 */
const ATTACHMENTS_LABELS = new Set([
  "**Attachments**:",
  "**Attachments** (not stored):",
]);

/** One rendered attachment row, with either a wikilink or a plain filename. */
const ATTACHMENT_LINE = /^-\s(.*)\s—\s(\S+),\s(.*?)(?:\s+\(not stored\))?$/;

/** Drop only the renderer-owned wikilink shell; never return its storage path. */
function attachmentFilename(rendered) {
  if (!rendered.startsWith("[[") || !rendered.endsWith("]]")) return rendered;
  const divider = rendered.indexOf("|");
  return divider === -1 ? rendered : rendered.slice(divider + 1, -2);
}

/**
 * Read a channel-day note back **with the message bodies**, for a reader that
 * needs the words rather than the index `parseChannelDayNote` gives.
 *
 * The heading is split on " · " into at most three fields the way it is
 * written — time, sender, subject — with everything past the second
 * separator kept together as the subject. That is deliberate rather than a
 * simplification: `senderLabel` is a name or an address and does not contain
 * one, while a hostile *subject* is exactly the kind of string this corpus is
 * tested against, and a fixed three-way split would silently move the tail of
 * an attacker's `"a · b · c"` subject into a field that is shown as the
 * sender's name. Losing a stray `·` out of a subject is a display detail;
 * misattributing text a stranger wrote to the name a reader trusts is not.
 *
 * A body is returned exactly as it sits between its two fence markers —
 * `defangFence` only ever *adds* a zero-width space to a forged marker
 * inside it, so nothing here does the unfencing an attacker could exploit —
 * and it is still fenced content: a caller renders it as a quotation, never
 * as an instruction or as navigable markup, the same rule the note's own
 * preamble states in prose. See `docs/decisions/app-and-console.md` for why
 * the console that reads this back does not turn a body's `[[...]]` or
 * `[...](...)` into a link: that defence is the one thing a renderer of
 * *this* value must not undo.
 *
 * @param {string} text
 * @returns {{
 *   frontmatter: Record<string, string>,
 *   title: string,
 *   messages: Array<{
 *     anchor: string, thread: string, space: string, time: string,
 *     sender: string, subject: string, body: string,
 *     attachments: Array<{filename: string, contentType: string, size: string}>,
 *   }>,
 * }}
 */
export function parseChannelDayMessages(text) {
  const source = String(text ?? "");
  const frontmatter = {};
  let body = source;

  if (source.startsWith("---\n")) {
    const end = source.indexOf("\n---", 3);
    if (end !== -1) {
      for (const line of source.slice(4, end).split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const key = line.slice(0, colon).trim();
        const raw = line.slice(colon + 1).trim();
        let value = raw;
        if (raw.startsWith('"')) {
          try {
            value = JSON.parse(raw);
          } catch {
            value = raw;
          }
        }
        frontmatter[key] = String(value);
      }
      body = source.slice(end + 4);
    }
  }

  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";

  const messages = [];
  let thread = "";
  let space = "";
  let inFence = false;
  let inAttachments = false;
  /** @type {ReturnType<typeof messages[number]> | null} */
  let current = null;
  let bodyLines = [];

  function flush() {
    if (current === null) return;
    current.body = bodyLines.join("\n").trim();
    messages.push(current);
    current = null;
    bodyLines = [];
    inAttachments = false;
  }

  for (const line of body.split("\n")) {
    // A heading or a thread line inside the fence is a stranger's words that
    // merely look like one — the same rule `parseChannelDayNote` follows, and
    // for the same reason: only the renderer's own headings, outside every
    // fence, are real structure.
    // Both levels, as `parseChannelDayNote` reads them: email and iMessage
    // write `## Thread — ` and `### … {#msg-…}`; a Google Chat day writes
    // `### Thread — ` and `#### … {#msg-…}` under a `## ` space heading.
    const heading = !inFence ? /^#{3,4}\s(.*)\s\{#(msg-[0-9a-f]+)\}\s*$/.exec(line) : null;
    const threadHeading = !inFence && !heading ? /^#{2,3}\sThread\s—\s(.+)$/.exec(line) : null;
    if (threadHeading) {
      flush();
      thread = threadHeading[1].trim();
      continue;
    }
    const spaceHeading = !inFence && !heading ? /^##\s(.+)$/.exec(line) : null;
    if (spaceHeading) {
      flush();
      space = spaceHeading[1].trim();
      continue;
    }
    if (heading) {
      flush();
      const fields = heading[1].split(" · ");
      current = {
        anchor: heading[2],
        thread,
        space,
        time: fields[0] ?? "",
        sender: fields[1] ?? "",
        subject: fields.slice(2).join(" · "),
        body: "",
        attachments: [],
      };
      continue;
    }
    if (current === null) continue; // the preamble, before the first message

    if (line.startsWith(`<!-- ${FENCE_MARKER} begin `)) {
      inFence = true;
      continue;
    }
    if (line.startsWith(`<!-- ${FENCE_MARKER} end `)) {
      inFence = false;
      continue;
    }
    if (inFence) {
      bodyLines.push(line);
      continue;
    }
    if (ATTACHMENTS_LABELS.has(line.trim())) {
      inAttachments = true;
      continue;
    }
    if (inAttachments) {
      const match = ATTACHMENT_LINE.exec(line);
      if (match) {
        current.attachments.push({
          filename: attachmentFilename(match[1]),
          contentType: match[2],
          size: match[3],
        });
      }
      continue;
    }
  }
  flush();

  return { frontmatter, title, messages };
}
