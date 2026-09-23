/**
 * Turning a client's session log into the thing that gets sent.
 *
 * This module is the capture boundary, and it is the most security-sensitive
 * file in the package — not because of a credential, but because it decides
 * what leaves somebody's machine. A session log on disk holds far more than the
 * conversation: system prompts, the model's own reasoning, every tool call and
 * its full result, file contents read along the way, and whatever was in the
 * environment when a command ran.
 *
 * The rule, which is the same one the gateway's own instructions give every
 * connected agent: **user-visible user and assistant messages, and nothing
 * else.** Not "everything except things that look like secrets" — an
 * exclude-list over free text is a filter that fails silently and only in the
 * direction that matters. Everything is dropped unless its role is one of two
 * values and its content is text.
 *
 * That is deliberately lossy. A session whose whole substance was tool output
 * comes out thin, and thin is the correct failure: the agent had a
 * `save_context` call available for anything it judged worth keeping, and this
 * hook is the safety net for when it did not use it, not a way around the
 * boundary it was told to respect.
 */

/** Longest single message kept. Past this it is a file, not a message. */
const MESSAGE_CHAR_CAP = 20_000;
/** The gateway refuses a capture past its own cap; stop well before it. */
const TRANSCRIPT_CHAR_CAP = 400_000;

const KEPT_ROLES = new Set(["user", "assistant"]);

/**
 * One JSONL line → `{ role, text }`, or null.
 *
 * Shapes differ between clients and between versions of the same client, so
 * this reads defensively and drops anything it does not positively recognise.
 * The alternative — a best-effort stringify of an unknown shape — is how a
 * reasoning trace ends up in somebody's notes.
 */
export function messageFromEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  // Claude Code nests the API message under `message` and marks replayed or
  // internal lines with `isMeta`/`isSidechain`. A sidechain is a subagent's
  // conversation the person never saw.
  // `isCompactSummary` belongs on this line rather than in the `origin` block
  // below, and the reason is semantic rather than a matching flag name: a
  // compaction summary is neither a user message nor an assistant one. It is
  // harness bookkeeping — the same thing `isMeta` and `isSidechain` denote —
  // and it is the largest single thing that can leave here. It condenses the
  // WHOLE session, including every part this boundary drops on every other
  // path, and it arrives as a plain string on a `user` role with no `origin`
  // at all, so neither the type switch nor the kind check below can see it.
  // `isVisibleInTranscriptOnly` is here because the harness's own definition of
  // synthetic is `isMeta || isVisibleInTranscriptOnly` — this line is the hook's
  // implementation of that idea, and carrying only half of it was an accident.
  // Do not re-litigate it from the flag's name, which reads like a display
  // property and is how it came to be left out the first time: the two flags
  // are independent parameters on the message constructor, and there is a path
  // that propagates the display flag forward with no compaction flag at all.
  // No measured instance today; the cost of the extra term is nil and this
  // module is deliberately lossy in exactly this direction.
  if (
    entry.isMeta === true ||
    entry.isSidechain === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true
  ) {
    return null;
  }
  // `role: "user"` does not mean "the person typed this". The harness writes
  // user turns too — task notifications carrying a subagent's entire output,
  // system reminders, injected context — and none of it is content anybody
  // saw. It arrives as an ordinary `text` block, so the type switch below
  // cannot see it and the role check waves it through.
  //
  // Claude Code marks whose turn it is structurally, on `origin.kind`, which
  // is what keeps this an allow-list on a field rather than the denylist over
  // prose this module exists to avoid: a kind we do not positively recognise
  // as the person is dropped, so a kind added later fails closed.
  //
  // Absent `origin` keeps the previous behaviour deliberately. The other
  // supported clients do not write the field, and inventing a meaning for its
  // absence would drop every message they produce.
  const origin = entry.origin && typeof entry.origin === "object" ? entry.origin : null;
  if (origin && typeof origin.kind === "string" && origin.kind !== "human") return null;

  const message = entry.message && typeof entry.message === "object" ? entry.message : entry;
  const role = typeof message.role === "string" ? message.role : entry.type;
  if (!KEPT_ROLES.has(role)) return null;

  const text = textFromContent(message.content);
  if (!text.trim()) return null;
  return { role, text: text.slice(0, MESSAGE_CHAR_CAP) };
}

/**
 * The text parts of a content field, and only the text parts.
 *
 * A content array carries `text`, `thinking`, `tool_use` and `tool_result`
 * blocks in the same list. Only `text` is something the person saw. Note that
 * `tool_result` blocks *also* have a `text` field one level down — which is why
 * this switches on the block's declared type rather than reaching for any
 * `.text` it can find. Fishing for `.text` would pass every test written with
 * plain messages and quietly exfiltrate every file the agent read.
 */
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

/**
 * A JSONL session log → Markdown.
 *
 * A line that will not parse is skipped rather than failing the whole capture:
 * these files are appended to by a live process and the last line is routinely
 * half-written when a session ends.
 */
export function transcriptToMarkdown(jsonl) {
  const messages = [];
  for (const line of String(jsonl).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = messageFromEntry(entry);
    if (message) messages.push(message);
  }

  if (!messages.length) return { markdown: "", messages: 0, truncated: false };

  const rendered = [];
  let length = 0;
  let truncated = false;
  // Newest messages are the ones worth keeping when something has to go, so the
  // cap is applied from the end and the note says the beginning was cut.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const block = `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text.trim()}`;
    if (length + block.length > TRANSCRIPT_CHAR_CAP) {
      truncated = true;
      break;
    }
    rendered.unshift(block);
    length += block.length;
  }

  return { markdown: rendered.join("\n\n"), messages: rendered.length, truncated };
}

/**
 * The body posted to `/inbox`.
 *
 * The preamble is written for whoever reads the note later, and it says two
 * true things a capture must not leave implicit: where it came from, and what
 * was deliberately left out of it.
 */
export function captureBody({ client, sessionId, cwd, at, markdown, messages, truncated }) {
  const when = at || new Date().toISOString();
  const where = cwd ? ` in \`${singleLine(cwd)}\`` : "";
  const heading = `${client} session${where}`;
  const preamble = [
    `> Captured automatically when a ${client} session ended${where}.`,
    "> User-visible messages only — no system prompts, reasoning, tool calls, or tool output.",
    truncated ? "> The earliest messages were dropped to fit; this is the tail of the session." : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    title: heading.slice(0, 200),
    source: `hook:${client}`,
    external_id: sessionId ? `${client}:${sessionId}` : "",
    created_at: when,
    text: `${preamble}\n\n${markdown}\n`,
    metadata: { client, messages, truncated, session_id: sessionId || "" },
  };
}

function singleLine(value) {
  return String(value).replace(/[\r\n]+/g, " ").slice(0, 300);
}

export { MESSAGE_CHAR_CAP, TRANSCRIPT_CHAR_CAP };
