/**
 * A text is edited or unsent, node "edit" (`texConfig.json`; Dev2, 2026-11-16: "Build edit support in Tex", "not just
 * edits but deleted messages as well"). When someone edits a text they sent (iMessage's Edit, as Photon's line hears
 * it), the texting Worker's chat object hands its new words and, when the chat still has them, its words before
 * (`apps/agent/src/editStep.ts`). This says what the edit is:
 *
 * - "same": the words did not change (folded for case and spacing). Nothing is kept or answered.
 * - "record": only typos fixed (`typoFix`). The edit goes into the chat's record, so every later turn reads the
 *   new words, and takes no turn of its own: nobody wants an answer to a fixed typo.
 * - "turn": anything else, or words before nobody remembers. The edit goes on to Triage as a text of its own, marked
 *   as the edit of that earlier text, so Tex sees what changed and answers it the way it answers any text.
 * - "withdraw": an unsend (iMessage's Undo Send). It is kept as that text taken back, so later turns know not to act on
 *   it, and the text leaves the chat's queue if Tex has not started on it. It takes no turn.
 *
 * No model and no reads: pure code over what it is handed, logged like every node.
 */

/**
 * A typo's worth: the same words in the same order, and each word that changed is a misspelling of the same word: at
 * least `TYPO_WORD` letters long, no digit in it, and at most `TYPO_CHARS` characters different. A changed number, a
 * short word ("no" for "on"), an added or dropped word, or a reworded one changes what they said, and takes a turn.
 */
export const TYPO_WORD = 4;
export const TYPO_CHARS = 2;
/** Longer texts are never measured: a long text's edit takes a turn. */
const MEASURED = 400;
const DIGIT = /\d/;
const folded = (text) => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Whether `now` only fixes typos in `before`, both folded. */
function typoFix(before, now) {
  const [a, b] = [before.split(" "), now.split(" ")];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (Math.min(a[i].length, b[i].length) < TYPO_WORD || DIGIT.test(a[i]) || DIGIT.test(b[i])) return false;
    if (distance(a[i], b[i], TYPO_CHARS) > TYPO_CHARS) return false;
  }
  return true;
}

/** Edit distance between two short strings, or `limit + 1` once it is sure to pass `limit`. */
export function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (next[j] < best) best = next[j];
    }
    if (best > limit) return limit + 1;
    row = next;
  }
  return row[b.length];
}

/** @param {{ kind: "one" | "group", change: "edit" | "unsend", words?: string, earlier?: string }} input */
export async function editNode(input) {
  if (input.change === "unsend") return { to: "withdraw", why: "they took the text back" };
  if (typeof input.words !== "string" || input.words.trim() === "") return { to: "same", why: "an edit with no words" };
  const now = folded(input.words);
  if (typeof input.earlier !== "string" || input.earlier.trim() === "") return { to: "turn", why: "the words before are not known" };
  const before = folded(input.earlier);
  if (now === before) return { to: "same", why: "the words did not change" };
  if (now.length > MEASURED || before.length > MEASURED) return { to: "turn", why: "a long text changed" };
  return typoFix(before, now) ? { to: "record", why: "only typos were fixed" } : { to: "turn", why: "the words changed" };
}
