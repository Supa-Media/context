/**
 * WHY A TOOL FAILED, KEPT WITH THE ROW (Training run of 2026-11-19).
 *
 * A Lab row said "send_email email failed" and nothing more, so nobody could tell a send the bench's stand-in refused
 * (the world's mailbox at another address than the chat's setting) from one Tex got wrong. The model is shown each
 * failed tool's answer as a `tool_result` with `is_error` (`src/agent/providers.js`); this reads those from the turn's
 * model calls (`modelLog.mjs`) and keeps each as one short line, `<tool>: <its error>`, for the row's detail.
 *
 * Short and plain: at most `ERROR_CHARS` per line and `MAX_ERRORS` lines, whitespace folded, links cut to their host,
 * and anything shaped like a key or token (a long run of letters and digits) replaced, so no secret reaches a record.
 */

/** The longest one error line is kept, in characters. */
export const ERROR_CHARS = 160;
/** The most error lines a turn keeps. */
export const MAX_ERRORS = 6;

const TOKENISH = /[A-Za-z0-9_\-+/=]{32,}/g;
const LINK = /\bhttps?:\/\/([^/\s"')]+)[^\s"')]*/g;

/** One error's words, safe to keep: folded, links cut to their host, token-shaped runs hidden, clipped. */
export function safeError(text) {
  const plain = String(text ?? "").replace(/\s+/g, " ").replace(LINK, "https://$1/…").replace(TOKENISH, "[hidden]").replaceAll(" | ", " / ").trim();
  return plain.length > ERROR_CHARS ? `${plain.slice(0, ERROR_CHARS - 1)}…` : plain;
}

const blocksOf = (content) => (Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : []);

function resultText(block) {
  if (typeof block.content === "string") return block.content;
  return blocksOf(block.content).map((part) => (typeof part.text === "string" ? part.text : "")).join(" ");
}

/**
 * The failed tools in a turn's model calls (`modelLog.mjs` calls, oldest first), as `<tool>: <error>` lines in the
 * order the model was shown them. A tool's name comes from the model's own `tool_use` with the same id.
 */
export function toolErrorsIn(calls) {
  const names = new Map();
  const lines = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    for (const message of Array.isArray(call?.messages) ? call.messages : []) {
      for (const block of blocksOf(message?.content)) {
        if (block.type === "tool_use" && typeof block.id === "string") names.set(block.id, String(block.name ?? "tool"));
        if (block.type === "tool_result" && block.is_error === true) {
          const line = `${names.get(block.tool_use_id) ?? "tool"}: ${safeError(resultText(block))}`;
          if (!lines.includes(line)) lines.push(line);
        }
      }
    }
    for (const block of blocksOf(call?.answer?.content)) if (block.type === "tool_use" && typeof block.id === "string") names.set(block.id, String(block.name ?? "tool"));
  }
  return lines.slice(0, MAX_ERRORS);
}

/**
 * What went wrong with the model itself in a turn, as gap lines (`benchGaps.mjs`): a call that failed (no 200), and a
 * Front door answer that came back with no words and no tool call. Production's model does not hand Tex an empty
 * answer to send; on the bench it is the answerer (Claude Code in cc, the gateway in gw) failing, so the row is a
 * harness error, never Tex's miss. `isFrontDoor` tells the Front door's calls (`frontDoorCall.mjs`).
 */
export function modelFailuresIn(calls, isFrontDoor) {
  const out = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    if (typeof call?.status === "number" && call.status !== 200) {
      out.push(`a model call failed (status ${call.status})`);
      continue;
    }
    if (!isFrontDoor(call)) continue;
    const content = call?.answer?.content;
    if (!Array.isArray(content)) continue;
    const words = content.some((block) => block?.type === "text" && String(block.text ?? "").trim() !== "");
    const acts = content.some((block) => block?.type === "tool_use");
    if (!words && !acts) out.push("the model gave an empty answer");
  }
  return [...new Set(out)];
}
