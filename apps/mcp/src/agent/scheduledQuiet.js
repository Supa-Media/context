/**
 * A SCHEDULED TURN'S SKIP IS A DECISION, NEVER A TEXT (2026-11-17 23:00 UTC: a WhatsApp group's own check-in
 * found no new mail and posted "Nothing new in the shared mailbox ... Nothing needs the group now. SKIP").
 *
 * A group's check-in and its routines run as turns of the chat nobody texted (`groupTurnCause.js`). Their
 * words asked for "exactly SKIP" when nothing was worth a text, and the gateway read only a bare SKIP as
 * silence (`texEntryPoint/sendTheReply.js`), as the Worker did (`packages/tex/worker/controlWords.ts`). A model
 * that explained why it was quiet and then said the word had written a text like any other.
 *
 * Now their words ask for the `say_nothing` call (`packages/shared/src/groupRunQuestions.cjs`), and what a
 * scheduled turn answers is decided here, in code, before anything is handed to the Worker: an answer that is
 * quiet by `saysQuiet` (the word alone, or opening or closing its reasoning, as a 1:1 routine's is read,
 * `routine.js` `runOutcome`) is the same structured nothing a `say_nothing` call is: no words and
 * `quiet: true`. The Worker's own last guard (`packages/tex/worker/outboundGuard.ts`) stands behind this one.
 *
 * Only a turn nobody texted is read this way. An answer to a person that ends in the word ("Tap the button
 * marked SKIP") is theirs.
 */
import { saysQuiet } from "./checkInGuards.js";

/** The causes of a group turn that ran on a schedule, as the Worker names them (`packages/tex/worker/groupCause.ts`). */
export const SCHEDULED_CAUSES = Object.freeze(["check_in", "routine"]);

/** Whether a group turn ran on the chat's schedule: its own check-in, or one of its routines. */
export function isScheduledGroupTurn(group) {
  return group !== null && typeof group === "object" && SCHEDULED_CAUSES.includes(group.cause);
}

/** Whether a scheduled group turn's answer decides "send nothing": a skip, however it was worded. */
export function scheduledSkip(group, answer) {
  return isScheduledGroupTurn(group) && saysQuiet(String(answer ?? ""));
}
