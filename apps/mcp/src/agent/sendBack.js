/**
 * A SEND-BACK IS WRITTEN FROM THE TURN'S LEDGER (Dev2, 2026-11-05: "when
 * judges send something back ... it should know his entire history. I tried to
 * reply with this, but the judges said this. It should just read the ledger
 * ... and based off the ledger, try to tweak its response. It should know ...
 * the tool calls that it already did").
 *
 * Before this, a send-back put the rejected draft into the conversation as
 * something Tex had said, then the notice. On 2026-11-05 (14:47-15:02Z, Dev2's
 * own chat) the model read the draft as sent, and each rewrite dropped the
 * answer it had found; one send-back made it save a second, unasked email
 * draft. Now the draft never appears as said. The model is shown, in one note
 * built from the same entries the chat's ledger keeps (`turn.js` `tell`):
 * every action it already took this turn, every draft it wrote, each marked
 * NOT sent with the checks that held it and why, and is asked to revise its
 * latest draft rather than start over. A write it already made this turn is
 * not run again on a rewrite (`repeatedWrite`).
 */

import { recheckNote } from "./recheck.js";

/** The most of one draft the note quotes: a texted reply is far shorter, so this cuts nothing real. */
const DRAFT_CHARS = 4_000;

/** Said to a write the model repeats after a send-back, in band, like every other refusal in the turn. */
export const ALREADY_DONE =
  "Not run: you already did this earlier this turn (see the note above), and a rewrite after a check changes your words, never repeats an action. " +
  "Write your reply from what that call already did.";

/**
 * The note the model reads after a send-back, from the turn's ledger
 * entries so far (`tool` and `judge` events, in order), the notice, and the
 * draft just held back. Starts with `recheckNote`'s framing (a check, not a
 * text from them; only the next answer is sent).
 */
export function sendBackNote({ entries = [], notice, draft }) {
  const done = [];
  for (const entry of entries) {
    if (entry?.kind !== "tool") continue;
    const state = entry.held === true ? "held for their yes" : entry.ok === false ? `failed${entry.reason ? `: ${entry.reason}` : ""}` : "done";
    done.push(`- ${String(entry.name ?? "?")} ${clip(argsText(entry.args), 200)} (${state})`);
  }
  const judged = entries.filter((entry) => entry?.kind === "judge" && entry.went === false);
  // The draft just held back is the last judged one; one a code check held is told only by its notice.
  const drafts = judged.length > 0 ? judged : [{ draft, failed: [], notice }];
  const lines = [
    "This turn so far, from its ledger:",
    done.length === 0 ? "Actions you took: none." : "Actions you took (already done; their results are above, so don't do them again):",
    ...done,
    "",
    ...drafts.flatMap((entry, i) => [
      `Draft ${i + 1}, NOT sent (they have never seen it):`,
      quote(entry.draft),
      `Held back by: ${heldBy(entry)}`,
      "",
    ]),
    "What the checks need from your latest draft:",
    notice,
    "",
    `Revise draft ${drafts.length}: keep its answer and everything in it they still need, and change only what the checks name. Don't start over, and don't redo an action above.`,
  ];
  return recheckNote(lines.join("\n"));
}

/**
 * The refusal for a call on a rewrite round that repeats a write this turn
 * already made, or null. `isWrite(name)` says whether a tool changes anything
 * (its MCP annotations); `entries` are the turn's ledger entries so far.
 */
export function repeatedWrite({ name, entries, isWrite }) {
  if (!isWrite(name)) return null;
  const earlier = entries.some((entry) => entry?.kind === "tool" && entry.name === name && (entry.ok !== false || entry.held === true));
  return earlier ? ALREADY_DONE : null;
}

function heldBy(entry) {
  const judges = Array.isArray(entry.judges) ? entry.judges.filter((judge) => judge?.passed === false) : [];
  if (judges.length > 0) return judges.map((judge) => `${String(judge.id).replaceAll("_", " ")} (${judge.yes} against ${judge.at})`).join(", ");
  return entry.by === "code" ? "a code check" : "the checks named below";
}

function quote(text) {
  const body = clip(String(text ?? ""), DRAFT_CHARS);
  return body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function argsText(args) {
  try {
    return typeof args === "string" ? args : JSON.stringify(args ?? {});
  } catch {
    return "";
  }
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
