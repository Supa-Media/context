/**
 * Comments on a note, kept in the note's own file.
 *
 * ## The format
 *
 * A comment is about a stretch of text, so it has two halves, and both are
 * plain Markdown that any editor keeps:
 *
 *  - **An anchor**: a pair of HTML comments around the words, as in
 *    `<!--c:k7f2-->free, you cheapo<!--/c:k7f2-->`. HTML comments render as
 *    nothing in Obsidian, on GitHub and in our own reader, so the note still
 *    reads as the note. Pairs are matched by id, never by nesting, so two
 *    anchors may overlap.
 *  - **The threads**: one fenced block with the info string `comments`, at the
 *    end of the note. Each thread is a header line (its id and the quoted words
 *    as a JSON string) and then one line per thing that happened:
 *
 *        ```comments
 *        k7f2 "free, you cheapo"
 *        - 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.
 *        - 2026-09-27T07:31:40Z Dev2: eh, I don't really care
 *        - 2026-09-27T07:31:45Z Dev2 resolved
 *        ```
 *
 *    A comment's later lines are indented four spaces, which is deeper than a
 *    closing fence may be indented, so no comment can end the block early.
 *
 * ## Why an append-only log
 *
 * Resolving never removes anything: it adds a `resolved` line, and reopening
 * adds a `reopened` one. A thread's status is whichever of those came last.
 * That keeps the whole history in the file (Dev2 asked for Google Docs'
 * "see resolved comments"), and it makes every change an insertion. Two people
 * replying at once are two insertions, which the collaborative editor merges
 * without either reply being lost; a format that rewrote a status field in
 * place would have had them fight over one line.
 *
 * ## Why edits are returned as changes, not as a new file
 *
 * Every operation here returns `{ from, to, insert }` changes against the text
 * it was given, and `applyChanges` turns them into the new text. The gateway
 * applies them to the note it just read; the editor dispatches them as
 * CodeMirror changes so that a comment typed while somebody else is typing in
 * the same note lands as a small insertion rather than as a whole-document
 * replacement. Lines this module does not understand are never rewritten, so a
 * hand edit in Obsidian survives the next comment.
 *
 * Shared by the gateway (`apps/mcp`), the console and the renderers that must
 * never publish comments (share links, websites). One parser, so the three can
 * never disagree about where the block starts.
 */

"use strict";

const ID = "[a-z0-9]{4,12}";
const ID_RE = new RegExp(`^${ID}$`);
const OPEN_RE = new RegExp(`<!--c:(${ID})-->`, "g");
const CLOSE_RE = new RegExp(`<!--/c:(${ID})-->`, "g");
const MARKER_RE = new RegExp(`<!--/?c:${ID}-->`, "g");
const HEADER_RE = new RegExp(`^(${ID})[ \\t]+("(?:[^"\\\\]|\\\\.)*")[ \\t]*$`);
const COMMENT_RE = /^- (\S+) ([^:\n]+?): ?(.*)$/;
const STATUS_RE = /^- (\S+) ([^:\n]+?) (resolved|reopened)[ \t]*$/;
const CONTINUATION = "    ";

/** Longest author name kept; longer ones are cut. */
const MAX_AUTHOR = 60;

function openMarker(id) {
  return `<!--c:${id}-->`;
}
function closeMarker(id) {
  return `<!--/c:${id}-->`;
}

/**
 * Lines with their offsets, so a block can be found and edited in place.
 * `end` excludes the newline; `next` is where the following line starts.
 */
function lines(text) {
  const out = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(start, end);
    out.push({ start, end, next: nl === -1 ? text.length : nl + 1, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/** Where frontmatter ends, or 0. A leading `---` line closed by another. */
function frontmatterEnd(text) {
  if (!/^---\r?\n/.test(text)) return 0;
  const rows = lines(text);
  for (let i = 1; i < rows.length; i += 1) {
    if (/^(---|\.\.\.)\s*$/.test(rows[i].text)) return rows[i].next;
  }
  return 0;
}

/**
 * Every fenced block outside frontmatter, as `{ start, end, info, bodyStart, bodyEnd }`.
 * `start` is the opening fence line, `end` the offset after the closing fence
 * line (or the end of the text when the fence is never closed).
 */
function fencedBlocks(text) {
  const rows = lines(text);
  const skip = frontmatterEnd(text);
  const blocks = [];
  let open = null;
  for (const row of rows) {
    if (row.start < skip) continue;
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(row.text);
      if (m) open = { start: row.start, fence: m[1], info: m[2], bodyStart: row.next };
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(row.text);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      blocks.push({ start: open.start, end: row.next, info: open.info, bodyStart: open.bodyStart, bodyEnd: row.start, closed: true });
      open = null;
    }
  }
  if (open) blocks.push({ start: open.start, end: text.length, info: open.info, bodyStart: open.bodyStart, bodyEnd: text.length, closed: false });
  return blocks;
}

/** The note's comments block, the last one if a note somehow has two. */
function findBlock(text) {
  const blocks = fencedBlocks(text).filter((block) => block.info === "comments" && block.closed);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

/**
 * Every anchor, by id, with the offsets of both markers. Unpaired markers are
 * left out, and so is anything inside a fenced block — the comments block
 * itself, and a code sample that shows the format (like
 * docs/decisions/comments.md) rather than using it.
 */
function findAnchors(text) {
  const fences = fencedBlocks(text);
  const inBlock = (at) => fences.some((block) => at >= block.start && at < block.end);
  const opens = new Map();
  const anchors = new Map();
  for (const m of text.matchAll(OPEN_RE)) {
    if (!inBlock(m.index) && !opens.has(m[1])) opens.set(m[1], { start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(CLOSE_RE)) {
    const open = opens.get(m[1]);
    if (!open || inBlock(m.index) || m.index < open.end || anchors.has(m[1])) continue;
    anchors.set(m[1], {
      id: m[1],
      openStart: open.start,
      from: open.end,
      to: m.index,
      closeEnd: m.index + m[0].length,
    });
  }
  return anchors;
}

/**
 * The note's threads, in the order the block lists them.
 *
 * Each is `{ id, quote, events, status, anchored, headerStart, end }`, where an
 * event is `{ at, author, kind: "comment" | "resolved" | "reopened", text }`
 * and `end` is the offset just after the thread's last line (where the next
 * event goes). Lines the parser does not recognise are skipped, never fatal:
 * this reads files people edit by hand.
 */
function parseComments(text) {
  const source = typeof text === "string" ? text : "";
  const block = findBlock(source);
  const anchors = findAnchors(source);
  if (!block) return { block: null, threads: [], anchors };
  const threads = [];
  let thread = null;
  let lastComment = null;
  for (const row of lines(source.slice(block.bodyStart, block.bodyEnd))) {
    const at = block.bodyStart + row.start;
    const next = block.bodyStart + row.next;
    if (block.bodyStart + row.start >= block.bodyEnd) break;
    const header = HEADER_RE.exec(row.text);
    if (header) {
      let quote = "";
      try {
        quote = JSON.parse(header[2]);
      } catch {
        quote = header[2].slice(1, -1);
      }
      thread = { id: header[1], quote, events: [], status: "open", anchored: anchors.has(header[1]), headerStart: at, end: Math.min(next, block.bodyEnd) };
      threads.push(thread);
      lastComment = null;
      continue;
    }
    if (!thread) continue;
    if (row.text.startsWith(CONTINUATION) && lastComment) {
      lastComment.text += `\n${row.text.slice(CONTINUATION.length)}`;
      thread.end = Math.min(next, block.bodyEnd);
      continue;
    }
    const comment = COMMENT_RE.exec(row.text);
    const status = comment ? null : STATUS_RE.exec(row.text);
    if (comment) {
      lastComment = { at: comment[1], author: comment[2], kind: "comment", text: comment[3] };
      thread.events.push(lastComment);
      thread.end = Math.min(next, block.bodyEnd);
    } else if (status) {
      lastComment = null;
      thread.events.push({ at: status[1], author: status[2], kind: status[3], text: "" });
      thread.status = status[3] === "resolved" ? "resolved" : "open";
      thread.end = Math.min(next, block.bodyEnd);
    } else if (row.text.trim() === "") {
      lastComment = null;
    }
  }
  return { block, threads, anchors };
}

/** A display name made safe for the author slot: one line, no colon, bounded. */
function sanitizeAuthor(name) {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/:/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_AUTHOR)
    .trim();
  // A name that ends in the status words would read back as a status line.
  if (!cleaned || /\s(resolved|reopened)$/i.test(` ${cleaned}`)) return cleaned ? `${cleaned}.` : "Someone";
  return cleaned;
}

/** A comment body as log lines: the first after the colon, the rest indented. */
function formatBody(body) {
  const rows = String(body ?? "").replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n").trim().split("\n");
  return rows.map((row, i) => (i === 0 ? row : `${CONTINUATION}${row}`)).join("\n");
}

function eventLine({ at, author, kind, text }) {
  const who = sanitizeAuthor(author);
  if (kind === "resolved" || kind === "reopened") return `- ${at} ${who} ${kind}`;
  return `- ${at} ${who}: ${formatBody(text)}`;
}

function isoNow(at) {
  const date = at instanceof Date ? at : at === undefined ? new Date() : new Date(at);
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A fresh id not already used in this note. `random` is injectable for tests. */
function newThreadId(text, random = Math.random) {
  const used = new Set([...parseComments(text).threads.map((t) => t.id), ...findAnchors(text).keys()]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let id = "";
    for (let i = 0; i < 4 + Math.floor(attempt / 25); i += 1) id += "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)];
    if (!used.has(id) && /[a-z]/.test(id[0])) return id;
  }
  throw new Error("could not choose a comment id");
}

/**
 * The note as a reader sees it for matching purposes: markers removed, with a
 * map from each visible offset back to the file.
 */
function visibleIndex(text) {
  let plain = "";
  const map = [];
  let at = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    for (let i = at; i < m.index; i += 1) {
      map.push(i);
      plain += text[i];
    }
    at = m.index + m[0].length;
  }
  for (let i = at; i < text.length; i += 1) {
    map.push(i);
    plain += text[i];
  }
  map.push(text.length);
  return { plain, map };
}

/** Regions a comment may not be anchored in: frontmatter and every fenced block. */
function forbiddenRegions(text) {
  const regions = [];
  const fm = frontmatterEnd(text);
  if (fm) regions.push([0, fm]);
  for (const block of fencedBlocks(text)) regions.push([block.start, block.end]);
  return regions;
}

/** Inside an inline code span on its line: an odd number of backticks before it. */
function insideInlineCode(text, at) {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return ((text.slice(lineStart, at).match(/`/g) || []).length % 2) === 1;
}

/**
 * Where `quote` sits, as file offsets `[from, to)`, or an error a caller can
 * show. `occurrence` is 1-based and defaults to 1; a quote that appears more
 * than once without one is refused, so an agent never anchors the wrong copy.
 */
function locateQuote(text, quote, occurrence) {
  const wanted = String(quote ?? "");
  if (!wanted.trim()) return { error: "quote the words to comment on" };
  if (wanted.length > 2000) return { error: "the quoted text is too long; quote at most 2000 characters" };
  if (/<!--|-->/.test(wanted)) return { error: "the quote may not contain HTML comment markers" };
  const { plain, map } = visibleIndex(text);
  const regions = forbiddenRegions(text);
  const hits = [];
  for (let at = plain.indexOf(wanted); at !== -1; at = plain.indexOf(wanted, at + 1)) {
    const from = map[at];
    const to = map[at + wanted.length - 1] + 1;
    const blocked = regions.some(([start, end]) => from < end && to > start);
    if (!blocked && !insideInlineCode(text, from)) hits.push({ from, to });
  }
  if (!hits.length) return { error: `"${wanted}" does not appear in the note's text (code blocks and frontmatter cannot be commented on)` };
  if (occurrence === undefined && hits.length > 1) {
    return { error: `"${wanted}" appears ${hits.length} times; pass occurrence (1 to ${hits.length}) to say which` };
  }
  const index = occurrence === undefined ? 1 : Number(occurrence);
  if (!Number.isInteger(index) || index < 1 || index > hits.length) {
    return { error: `occurrence must be between 1 and ${hits.length}` };
  }
  return hits[index - 1];
}

/**
 * Start a thread: anchor `[from, to)` (or the located `quote`) and add the
 * first comment. Returns `{ id, changes }` or `{ error }`.
 */
function addThread(text, { quote, occurrence, from, to, author, body, at, id, random } = {}) {
  const source = typeof text === "string" ? text : "";
  if (!String(body ?? "").trim()) return { error: "a comment needs some text" };
  let range;
  if (Number.isInteger(from) && Number.isInteger(to)) {
    if (from < 0 || to > source.length || from >= to) return { error: "the selection is empty" };
    const regions = forbiddenRegions(source);
    if (regions.some(([start, end]) => from < end && to > start) || insideInlineCode(source, from)) {
      return { error: "code blocks and frontmatter cannot be commented on" };
    }
    range = { from, to };
  } else {
    range = locateQuote(source, quote, occurrence);
    if (range.error) return range;
  }
  const threadId = id && ID_RE.test(id) ? id : newThreadId(source, random);
  const words = visibleIndex(source.slice(range.from, range.to)).plain;
  const header = `${threadId} ${JSON.stringify(words.replace(/\s+/g, " ").trim().slice(0, 200))}`;
  const entry = `${header}\n${eventLine({ at: isoNow(at), author, kind: "comment", text: body })}\n`;
  const block = findBlock(source);
  const changes = [
    { from: range.from, to: range.from, insert: openMarker(threadId) },
    { from: range.to, to: range.to, insert: closeMarker(threadId) },
  ];
  if (block) {
    const parsed = parseComments(source);
    const hasThreads = parsed.threads.length > 0;
    changes.push({ from: block.bodyEnd, to: block.bodyEnd, insert: `${hasThreads ? "\n" : ""}${entry}` });
  } else {
    const trailing = source.endsWith("\n\n") ? "" : source.endsWith("\n") ? "\n" : source.length ? "\n\n" : "";
    changes.push({ from: source.length, to: source.length, insert: `${trailing}\`\`\`comments\n${entry}\`\`\`\n` });
  }
  return { id: threadId, changes };
}

/**
 * Add a reply, a resolve or a reopen to an existing thread. Returns
 * `{ changes }` or `{ error }`. Resolving a resolved thread (or reopening an
 * open one) is refused, so the log never records a change that changed nothing.
 */
function appendEvent(text, { thread, kind, author, body, at } = {}) {
  const source = typeof text === "string" ? text : "";
  const found = parseComments(source).threads.find((t) => t.id === thread);
  if (!found) return { error: `there is no comment thread "${thread}" on this note` };
  if (!["comment", "resolved", "reopened"].includes(kind)) return { error: "unknown comment action" };
  if (kind === "comment" && !String(body ?? "").trim()) return { error: "a reply needs some text" };
  if (kind === "resolved" && found.status === "resolved") return { error: `thread ${thread} is already resolved` };
  if (kind === "reopened" && found.status === "open") return { error: `thread ${thread} is already open` };
  const line = eventLine({ at: isoNow(at), author, kind, text: body });
  const before = source.slice(0, found.end);
  const insert = before.endsWith("\n") ? `${line}\n` : `\n${line}`;
  return { changes: [{ from: found.end, to: found.end, insert }] };
}

/** Apply `{ from, to, insert }` changes (offsets in the original text). */
function applyChanges(text, changes) {
  const sorted = [...changes].map((c, i) => ({ ...c, i })).sort((a, b) => b.from - a.from || b.i - a.i);
  let out = text;
  for (const change of sorted) out = out.slice(0, change.from) + change.insert + out.slice(change.to);
  return out;
}

/**
 * The note without its comments: markers gone and the block removed. For
 * every surface that publishes a note beyond its readers (share links,
 * websites), where comments are never shown.
 */
function stripComments(text) {
  const source = typeof text === "string" ? text : "";
  const block = findBlock(source);
  let out = source;
  if (block) {
    let start = block.start;
    while (start > 0 && out[start - 1] === "\n") start -= 1;
    const tail = out.slice(block.end);
    out = out.slice(0, start) + (start > 0 ? "\n" : "") + tail.replace(/^\n+/, "");
  }
  return out.replace(MARKER_RE, "");
}

/** One line for an agent: how many threads are open and on what. */
function describeComments(text) {
  const { threads } = parseComments(text);
  if (!threads.length) return null;
  const open = threads.filter((t) => t.status === "open");
  const resolved = threads.length - open.length;
  const listed = open
    .slice(0, 5)
    .map((t) => `${t.id} on ${JSON.stringify(t.quote.length > 40 ? `${t.quote.slice(0, 39)}…` : t.quote)}${t.anchored ? "" : " (text deleted)"}`)
    .join(", ");
  return `${open.length} open${open.length ? ` (${listed}${open.length > 5 ? ", …" : ""})` : ""}, ${resolved} resolved`;
}

module.exports = {
  COMMENTS_INFO: "comments",
  MARKER_RE,
  openMarker,
  closeMarker,
  findBlock,
  findAnchors,
  parseComments,
  sanitizeAuthor,
  newThreadId,
  locateQuote,
  addThread,
  appendEvent,
  applyChanges,
  stripComments,
  describeComments,
};
