/**
 * THE SAME ASK, SHOWN AGAIN AFTER THEY PUSHED BACK ON IT.
 *
 * On 2026-10-27 a check-in found two meetings at 6:30 and the person texted
 * "maybe make sarah's meeting 15 min". Tex held Sarah's call at 6:30 to 6:45
 * and asked for a 👍. "but they're both still at 6:30" got an explanation;
 * "are you dumb … you have to move one of them to start at a different time"
 * got "Sorry, I should have moved one of them." and the very same change
 * block, word for word. Only the third, angry text got 6:45 to 7
 * (@context-lc areas/tex-reviews/themes/repeats-after-correction.md).
 *
 * The gates already refuse a call whose arguments match an ask still armed
 * (`ALREADY_ASKED`, `../tools/approvals.js`), but a correction can disarm it,
 * and the model's second try may differ in an argument the person never sees
 * while the change they read is the same. So this is judged on what the
 * person reads: a held call whose shown copy (`detail`, the block above
 * "Give it a 👍") is one Tex already texted them, with no yes from them since,
 * is withdrawn before it is shown, and the model is told to make the change
 * their words ask for, or ask one short question. A yes that reached the
 * model (nothing was armed to take it) may still show the same ask again.
 */

import { approvalVerdict } from "./textedApprovals.js";
import { folded } from "./folded.js";
import { withdrawPending } from "../tools/approvals.js";
import { toolError } from "../tools/results.js";

/** How far back an ask Tex showed still counts as "the one they just answered". */
const LOOKBACK = 8;
/** Fewer letters than this cannot tell one shown change from another. */
const MIN_SHOWN = 24;

export const SAME_ASK =
  "Not shown: this is exactly the change they were already shown, and they didn't say yes to it. Their texts since then say what's wrong with it. " +
  "Work out from their words what to change (read what you need first), then make the call again with that change. " +
  "Only if their words really leave it open, ask one short question instead. Don't apologize, and don't describe the old one again. " +
  "If their text isn't about it at all, just answer it.";

/**
 * Whether `detail` is a change Tex texted them in its last few texts, with
 * every text of theirs after it, `question` included, something other than a yes.
 */
export function shownAndNotTaken(detail, history, question) {
  const shown = folded(detail);
  if (shown.length < MIN_SHOWN) return false;
  if (approvalVerdict(question) === "approve") return false;
  const recent = (Array.isArray(history) ? history : []).slice(-LOOKBACK);
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i];
    if (turn?.role === "user" && approvalVerdict(turn.text) === "approve") return false;
    if (turn?.role === "assistant" && folded(turn.text).includes(shown)) return true;
  }
  return false;
}

/**
 * Wrap a texted turn's dispatcher (`route.js`): a held call that repeats the
 * ask they pushed back on is withdrawn and refused. Off (`on` false) for
 * routines and anything else not answering a person's text.
 */
export function withSameAsk({ on, store, session, ledger, history, question }, call) {
  if (!on) return call;
  return async (name, args) => {
    const before = new Set(ledger.asked.map((record) => record.id));
    const result = await call(name, args);
    if (result?.held !== true) return result;
    const repeated = ledger.asked.filter((record) => !before.has(record.id) && typeof record.detail === "string" && shownAndNotTaken(record.detail, history, question));
    if (repeated.length === 0) return result;
    const ids = new Set(repeated.map((record) => record.id));
    ledger.asked.splice(0, ledger.asked.length, ...ledger.asked.filter((record) => !ids.has(record.id)));
    await withdrawPending(store, { userId: session.actorUserId, ids: [...ids] }).catch(() => {});
    console.log(JSON.stringify({ event: "same_ask_refused", tool: name, asks: ids.size }));
    return toolError(SAME_ASK);
  };
}
