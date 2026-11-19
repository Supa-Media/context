/**
 * LABEL LINES THE CODE CAN GRADE FROM THE RUN'S RECORD.
 *
 * A check line like "react" or "must not send an email" is about what the answer
 * did, and the record already says what it did: the tapbacks Tex sent, the tools
 * it called (and which failed or were held), the notes it wrote, the jobs it
 * started. Where the record settles a line, the code grades it and the model is
 * never sent the line, so it cannot be talked round it and the model never has to
 * guess. A line the record cannot settle (a judge line, or a compound line that
 * asks for more than one thing) stays with the model: each rule only decides when
 * it is sure, and returns null otherwise.
 */

const TAPBACK = /^\(Tex reacted(?: (\S+))? to /;
const TOOL_STATE = /\s\((failed|held for OK)\)$/;
const EMOJI = /\p{Extended_Pictographic}(?:\uFE0F|\u200d\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const FULL_TAPBACK = /^react(?: to (?:it|their text))?$|^react with \p{Extended_Pictographic}\S*$/u;
const SILENCE = ["stay quiet", "stay silent", "say nothing", "send nothing", "no reply", "don't reply", "do not reply", "nothing to send"];
const NO_WORDS = ["reply", "text", "text back", "send a text", "post", "say anything", "reply in words"];
const MAIL_ASKS = ["search mail", "search the mail", "search email", "look in mail", "check mail", "check the inbox", "look in the inbox"];
const MAIL_TOOLS = ["search_email", "read_email", "mail_", "gmail"];
// Not "read the page": a page may be a web page, read through browser tools this list does not hold.
const READ_START = ["read the note", "read the linked"];
const READ_TOOLS = ["read_note", "read_notes", "search_notes", "fetch", "read_file", "read_meeting", "read_day"];
const JOB_ASKS = ["start a job", "kick off a job", "start a background job", "background job"];

/** The line as the rules read it: trimmed, lower case, one trailing period dropped. */
function norm(line) {
  return String(line ?? "").trim().toLowerCase().replace(/\.$/, "").trim();
}

/** A tool name without its state suffix, and the state: "ok", "failed" or "held". */
function toolName(tool) {
  return String(tool).replace(TOOL_STATE, "");
}

function toolState(tool) {
  const m = String(tool).match(TOOL_STATE);
  if (!m) return "ok";
  return m[1] === "failed" ? "failed" : "held";
}

/** An emoji with its variation selector dropped, so "❤\uFE0F" and "❤" compare equal. */
function bareEmoji(text) {
  return String(text).replace(/\uFE0F/g, "");
}

/**
 * Whether the assistant said any words: its text with tapback lines removed, non-empty.
 * WHY: a tapback is not a reply, so a "no words" line must not be failed by one.
 */
export function wordsSent(answer) {
  const turns = answer?.conversation ?? [];
  return turns
    .filter((turn) => turn.from === "assistant")
    .some((turn) => {
      const kept = String(turn.text ?? "").split("\n").filter((line) => !TAPBACK.test(line.trim()));
      return kept.join("\n").trim() !== "";
    });
}

/**
 * The emoji of each tapback Tex sent, from all assistant turns; "" for a tapback that named none.
 * WHY: the record is the only proof of a reaction, and it names the emoji only when one was given.
 */
export function tapbacks(answer) {
  const out = [];
  for (const turn of answer?.conversation ?? []) {
    if (turn.from !== "assistant") continue;
    for (const line of String(turn.text ?? "").split("\n")) {
      const m = line.trim().match(TAPBACK);
      if (m) out.push(m[1] ?? "");
    }
  }
  return out;
}

/** The record facts every rule reads, taken once per answer. */
function facts(answer) {
  return {
    tools: Array.isArray(answer?.tools) ? answer.tools : [],
    changes: Array.isArray(answer?.changes) ? answer.changes.map(String) : [],
    jobs: Array.isArray(answer?.jobs) ? answer.jobs : [],
    words: wordsSent(answer ?? {}),
    taps: tapbacks(answer ?? {}),
  };
}

/** Tools called under any of these name prefixes, whatever their state. */
function calledLike(f, prefixes) {
  return f.tools.some((tool) => prefixes.some((p) => toolName(tool).startsWith(p)));
}

/**
 * The rules, in the order they are tried. Each has a `kind` the line must be, `match` on the
 * normalized line, `full` (code always decides this line, so the model never sees it), and
 * `verdict(line, facts)` returning `{ does, reason }` or null (code cannot tell).
 * `does` means "the answer does what the line says".
 */
export const RULES = [
  {
    name: "silence",
    kind: "must",
    full: () => true,
    // WHY exact, or the phrase then a colon or comma and its reason ("stay quiet: a sale email isn't worth a text"):
    // "stay quiet about the bank" asks for more than silence, so the model reads it.
    match: (line) => SILENCE.some((p) => line === p || line.startsWith(`${p}:`) || line.startsWith(`${p},`)),
    verdict: (line, f) => ({ does: !f.words, reason: f.words ? "Tex sent words" : "Tex sent no words" }),
  },
  {
    name: "no-words",
    kind: "must not",
    full: () => true,
    match: (line) => NO_WORDS.includes(line),
    verdict: (line, f) => ({ does: f.words, reason: f.words ? "Tex sent words" : "Tex sent no words" }),
  },
  {
    name: "tapback",
    kind: "must",
    full: (line) => FULL_TAPBACK.test(line),
    match: (line) => /^(react|reacts|tapback)\b/.test(line) || /\bmark\b.*\bdone\b/.test(line),
    verdict: (line, f) => {
      if (f.taps.length === 0) return { does: false, reason: "no tapback was sent" };
      if (/\bdone\b/.test(line) && !f.taps.some((e) => bareEmoji(e) === "✅")) {
        return { does: false, reason: "no ✅ tapback was sent" };
      }
      const named = line.match(EMOJI) ?? [];
      if (named.length > 0) {
        const sent = f.taps.map((e) => bareEmoji(e));
        const hit = named.some((e) => sent.includes(bareEmoji(e)));
        if (!hit) return { does: false, reason: `no tapback with ${named.join(" ")} was sent` };
      }
      if (FULL_TAPBACK.test(line)) return { does: true, reason: "Tex sent a tapback" };
      return null;
    },
  },
  {
    name: "no-tapback",
    kind: "must not",
    full: () => false,
    match: (line) => /^react\b/.test(line),
    verdict: (line, f) => (f.taps.length === 0 ? { does: false, reason: "Tex did not react" } : null),
  },
  {
    name: "mail",
    kind: "must",
    full: () => false,
    match: (line) => MAIL_ASKS.some((p) => line.includes(p)),
    verdict: (line, f) => (calledLike(f, MAIL_TOOLS) ? null : { does: false, reason: "no mail tool was called" }),
  },
  {
    name: "read-first",
    kind: "must",
    full: () => false,
    match: (line) => READ_START.some((p) => line.startsWith(p)) || (line.startsWith("look at the") && line.includes("note")),
    verdict: (line, f) => {
      const read = f.tools.some((t) => READ_TOOLS.includes(toolName(t)) && toolState(t) !== "failed");
      return read ? null : { does: false, reason: "no note was read" };
    },
  },
  {
    name: "reminder",
    kind: "must",
    full: () => false,
    match: (line) => line.includes("remind") && /\b(set|add|schedule|make|create)\b/.test(line),
    verdict: (line, f) => {
      const written = f.changes.some((c) => /^- written .*\/routines\//.test(c));
      const tried = f.tools.some((t) => /routine|remind/.test(toolName(t)));
      return written || tried ? null : { does: false, reason: "no routine was written" };
    },
  },
  {
    name: "note-written",
    kind: "must",
    full: () => false,
    match: (line) => /^(save|write|put|note)\b/.test(line) && (line.includes("note") || line.includes("page") || line.includes("in context")),
    verdict: (line, f) => {
      const written = f.changes.some((c) => /^- written /.test(c))
        || f.tools.some((t) => toolName(t) === "write_note" && toolState(t) !== "failed");
      return written ? null : { does: false, reason: "no note was written" };
    },
  },
  {
    name: "job",
    kind: "must",
    full: () => false,
    match: (line) => JOB_ASKS.some((p) => line.includes(p)),
    verdict: (line, f) => (f.jobs.length === 0 ? { does: false, reason: "no background job was started" } : null),
  },
  {
    name: "email-sent",
    kind: "must not",
    full: () => false,
    // Only lines that name an email: "send before John says yes" may be a text, which send_email never shows.
    match: (line) => /\bsend/.test(line) && /\b(e-?mail|mail)\b/.test(line),
    // WHY: a held send_email is not sent (it goes out only after a yes), and a failed one did not go out either.
    verdict: (line, f) => {
      const sent = f.tools.some((t) => toolName(t) === "send_email" && toolState(t) === "ok");
      return sent ? null : { does: false, reason: "no email was sent" };
    },
  },
];

/** The rules a check's line matches, with its kind. judge lines and other kinds match none. */
function matching(check) {
  if (!check || (check.kind !== "must" && check.kind !== "must not")) return [];
  const line = norm(check.line);
  return RULES.filter((rule) => rule.kind === check.kind && rule.match(line));
}

/**
 * The first rule that matches a check's line, or null: `must` and `must not` lines only.
 * WHY: lets a caller ask which rule would grade a line before running it.
 */
export function codeRule(check) {
  return matching(check)[0] ?? null;
}

/**
 * True when a rule matches and code always decides that line, so it is kept out of the model's request.
 * WHY: a line the record settles is never guessed at by a model.
 */
export function codeOnly(check) {
  const line = norm(check?.line);
  return matching(check).some((rule) => rule.full(line));
}

/**
 * Whether the answer does what a check's line says, from the record, or null when the model must decide.
 * `does` is the same meaning as the model's; a "must not" line inverts it where the verdict is graded.
 * WHY: a rule answers false only when the record shows the thing did not happen, and never guesses true
 * for a line that asks for more than the record can show.
 */
export function codeVerdict(check, answer) {
  const rules = matching(check);
  if (rules.length === 0) return null;
  const line = norm(check.line);
  const f = facts(answer);
  let found = null;
  for (const rule of rules) {
    const v = rule.verdict(line, f);
    if (!v) continue;
    if (!v.does) return { does: false, reason: `checked from the run's record: ${v.reason}` };
    found ??= v;
  }
  return found ? { does: found.does, reason: `checked from the run's record: ${found.reason}` } : null;
}
