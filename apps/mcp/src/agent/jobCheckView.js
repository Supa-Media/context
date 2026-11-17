/**
 * WHAT THE JOB CHECK SEES OF A PART (Dev2 chose Fable's option E, 2026-11-17).
 *
 * The job check used to cut every tool result to its first 8,000 characters
 * and every call's input to 2,000, while Tex itself read results up to 60,000
 * (`toolResults.js`). A dentist job read eight two-week calendars; the check
 * saw each one's first day or two, said "all eight calendar reads were cut
 * off", and sent the job back twice to read what Tex had already read. The
 * job then shrank its answer from "nothing booked through March" to "nothing
 * booked through Nov 22" to satisfy it (Lab test chat, 2026-11-17).
 *
 * Now the part is shown whole whenever it fits the check's budget. When it
 * doesn't, every cuttable piece (a result, a call's input) gets a fair share
 * of what is left after the words: a piece shorter than the share is shown
 * whole, a longer one shows its start and its end. If even that would leave a
 * share too small to read, the oldest results become one-line stubs first,
 * never a tail slice that starts mid-result. Each piece says, in a line the
 * check's own code writes outside the quoted text, how much of it the check
 * sees and that Tex got all of it, so the check never mistakes its own view
 * for Tex's (`advisorRoles/jobCheck.js` tells it so).
 */

/** The most of a part the check reads, in characters (about 30,000 tokens). */
export const VIEW_CHARS = 120_000;
/** Below this a piece is not worth showing cut: the oldest results become stubs instead. */
export const FLOOR_CHARS = 1_500;
/** The tag a result is quoted in; its own tags in the result are neutralized, so a page can't end it. */
export const RESULT_TAG = "result";
/**
 * The marks only this file writes, around each piece's label line. Quoted text loses them (and the invisible
 * characters that could hide a lookalike), so a page or Tex's own words can't forge "Tex got all of it".
 */
export const LABEL = ["⟦", "⟧"];
const MARKS = /[⟦⟧\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;
const RESULT_TAGS = new RegExp(`<\\s*(/?)\\s*${RESULT_TAG}\\b[^>]*>`, "gi");
/** Quoted text that can neither end a <result> fence (attributes and all) nor write a label. */
const fenced = (text) => String(text ?? "").replace(MARKS, "").replace(RESULT_TAGS, (_whole, slash) => `(${slash}${RESULT_TAG})`);
const label = (words) => `${LABEL[0]}${words}${LABEL[1]}`;

const HEAD_SHARE = 2 / 3;
const STUB_WORTH = 300;
const count = (n) => n.toLocaleString("en-US");

/**
 * The share each cuttable piece may show so all of them fit `room`: pieces
 * shorter than it are whole, the rest get exactly it. Infinity when all fit.
 */
export function fairShare(lengths, room) {
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = Math.max(0, room);
  for (let index = 0; index < sorted.length; index += 1) {
    const share = Math.floor(left / (sorted.length - index));
    if (sorted[index] > share) return share;
    left -= sorted[index];
  }
  return Infinity;
}

/** `text` cut to `size` characters: its start and its end, with how much of the middle is left out. */
function startAndEnd(text, size) {
  if (text.length <= size) return text;
  const head = Math.ceil(size * HEAD_SHARE);
  const tail = Math.max(0, size - head);
  const gone = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${count(gone)} characters left out of your view here …]\n${tail > 0 ? text.slice(-tail) : ""}`;
}

/** The part as pieces: fixed words, and the cuttable results and call inputs, in order. */
function piecesOf(messages, quoted) {
  const pieces = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const said = typeof message.text === "string" ? message.text.trim() : "";
    if (message.role === "tool") {
      pieces.push({ kind: "result", name: message.name ?? "a tool", failed: message.isError === true, text: fenced(quoted(said)) });
      continue;
    }
    if (said) pieces.push({ kind: "words", text: `${message.role === "assistant" ? "Tex" : "Them"}: ${fenced(quoted(said))}` });
    for (const made of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      pieces.push({ kind: "call", name: made?.name ?? "a tool", text: fenced(quoted(JSON.stringify(made?.args ?? {}))) });
    }
  }
  return pieces;
}

function render(piece, share) {
  if (piece.kind === "words") return piece.text;
  const whole = piece.text.length;
  if (piece.kind === "call") {
    if (whole <= share) return `${label(`Tex calls ${piece.name}`)} ${piece.text}`;
    return `${label(`Tex calls ${piece.name}; your view shows the start and end of its input, ${count(share)} of ${count(whole)} characters; Tex sent all of it`)}\n<${RESULT_TAG}>\n${startAndEnd(piece.text, share)}\n</${RESULT_TAG}>`;
  }
  const failed = piece.failed ? ", failed" : "";
  if (piece.stub) return label(`result of ${piece.name}${failed}; left out of your view to fit (${count(whole)} characters); Tex got all of it`);
  const head = whole <= share ? label(`result of ${piece.name}${failed}`) : label(`result of ${piece.name}${failed}; your view shows its start and end, ${count(share)} of ${count(whole)} characters; Tex got all of it`);
  return `${head}\n<${RESULT_TAG}>\n${startAndEnd(piece.text, share) || "(no result)"}\n</${RESULT_TAG}>`;
}

/**
 * The part's transcript as the check reads it, at most about `budget`
 * characters. `quoted` neutralizes the brief's own tags in quoted text.
 */
export function partView(messages, { quoted = (text) => String(text ?? ""), budget = VIEW_CHARS } = {}) {
  const pieces = piecesOf(messages, quoted);
  // Every piece's own line and fence, roughly, and the blank lines between pieces.
  const fixed = pieces.reduce((sum, piece) => sum + (piece.kind === "words" ? piece.text.length : 200) + 2, 0);
  const room = budget - fixed;
  const cuttable = () => pieces.filter((piece) => piece.kind !== "words" && !piece.stub);
  let share = fairShare(cuttable().map((piece) => piece.text.length), room);
  // Too many to show each one readably: the oldest results go to stubs first, one at a time.
  while (share < FLOOR_CHARS) {
    // Only a result longer than a stub line is worth stubbing: a short one costs less shown whole.
    const oldest = pieces.find((piece) => piece.kind === "result" && !piece.stub && piece.text.length > STUB_WORTH);
    if (!oldest) break;
    oldest.stub = true;
    share = fairShare(cuttable().map((piece) => piece.text.length), room);
  }
  return pieces.map((piece) => render(piece, Math.max(share, piece.kind === "call" ? FLOOR_CHARS : 0))).join("\n\n");
}
