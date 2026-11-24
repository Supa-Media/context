/**
 * Finish the text (node "finish", `texConfig.json`; Dev2, 2026-11-23: "everything should live inside a node"): the
 * gateway's own work on the model's words after every check, before Text them delivers them (`sendTheReply.js`). Until
 * then this ran inside Text them, where the Lab could not see it. Each rule here is listed on the step, and the ones
 * that change the model's words are its settings (`texNodeSettings.cjs`: Trim flattery, Link the saved note, Drop a
 * stale answer), so the Lab shows them and a draft can turn them off.
 *
 * Returns what Text them sends and keeps: the words, the pictures and choices the turn made, the ask and offer lines,
 * the parts of a group answer and which text each goes under, and whether the turn is quiet, silent or a tapback.
 */

import { splitUnder, underOf } from "../replyUnder.js";
import { offerLine } from "../../../../../apps/mcp/src/tools/offerFor.js";
import { QUIET_ACK, reportReply } from "../background.js";
import { settingsOf } from "../texConfig.js";
import { withoutFlattery } from "../pushback.js";
import { EMPTY_FALLBACK, emptyFallback, isEmptyAnswer, isFallback } from "../replyChecks.js";
import { withSavedLink } from "../noteLinks.js";
import { answerWithAsk, textedAsk } from "../textedApprovals.js";
import { tapbackOf } from "../tapbackEnding.js"; // a tapback as the whole answer: nothing texted, the Worker reacts
import { typedCallOf } from "../sayNothing.js"; // a call typed out is never texted, the last stop before it goes
import { scheduledSkip } from "../scheduledQuiet.js"; // a check-in's or routine's skip is a decision, never its words

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function finishTheText(t) {
  const { askChat, claims, env, group, job, ledger, opened, outgoing, report, runner, session, setAside, store, tex, turn } = t;
  // The ask goes out in the gateway's own words, after whatever the model
  // said: a person can allow only what they were told about, and the model
  // relaying it is a courtesy rather than the mechanism.
  // An answer still empty after its notice is never sent as nothing (`replyChecks.js`); a routine's empty run is its SKIP.
  // A flattering opener ("You're so right!") comes off first while Trim flattery is on (`pushback.js`).
  const crossAskRun = t.crossChat?.kind === "ask"; // its answer goes back to the chat that asked, never texted here (`crossChat.js`)
  const finishSet = settingsOf(env, "finish"); // this step's own settings, shown and changed in the Lab (`texNodeSettings.cjs`)
  const tapped = tapbackOf(turn); // the front door answered with only a tapback (`tapbackEnding.js`)
  const hushed = turn.answer === QUIET_ACK || tapped !== null; // a job's start or restart texts nothing; their text gets a tapback instead (`background.js`)
  const { answer: replied, quiet } = hushed ? { answer: "", quiet: true } : reportReply(report, turn.answer), silent = job === null && (((group !== null || turn.settled === "say_nothing") && /^\W*SKIP\W*$/.test(String(replied ?? ""))) || typedCallOf(replied) !== null || (report === null && scheduledSkip(group, replied))), { answer: toldMarked, pictures, captions, choices = [], offers = [] } = outgoing.take(quiet ? "" : silent ? (group?.tagged === true ? EMPTY_FALLBACK : "") : !runner && isEmptyAnswer(replied) ? emptyFallback(turn.timing?.failures) : finishSet.trimFlattery === true ? withoutFlattery(replied) : replied); // a report's quiet is a flag, and an ended job always gets a line (`jobReport.js`); a group's bare SKIP, or any say_nothing (`sayNothing.js`), is silence, never the fallback, and only SKIP: "Quiet." answers a question (Dev2, 2026-11-01: Tex texted "my answer got lost" to a message for Instinct); a scheduled group turn's skip is silence however it was worded, its reasoning never a text (2026-11-17, `scheduledQuiet.js`); a literal "@Tex" is never silent: its silence is the fallback (Dev2, 2026-11-12)
  // A saved deliverable's link goes on its own line when the reply does not already link it (`noteLinks.js`, `withSavedLink`).
  const linkedMarked = finishSet.linkSavedNote !== true || quiet || silent || crossAskRun || isFallback(toldMarked) || isEmptyAnswer(toldMarked) ? toldMarked : withSavedLink(toldMarked, t.noteLinking?.saved, t.noteLinking?.origin ?? null); // the floor: 2026-11-19
  // No Searched line is added after the model's words: the reply says what its search found (owner's pick, 2026-11-23: "isn't written yet" got a stray one).
  // A group turn answering several texts: the front door's "[2] " numbers come out, and say which text each paragraph goes under (`replyUnder.js`).
  const { answer: told, parts: underParts } = group !== null && job === null ? splitUnder(linkedMarked, t.logged?.covered) : { answer: linkedMarked, parts: null };
  // An email's ask is texted exactly as written (`packages/tex/worker/reply.ts`), or withdrawn if it would not fit; asks their text corrected are dropped (`claimCheck.js` rule 6).
  const { ask, verbatim } = await tex.step("ask_line", () => textedAsk(store, session, ledger.asked, told, { who: group?.from || null, stale: claims?.stale() === true ? setAside.map((entry) => entry.id) : null, chat: askChat }));
  const offerText = ledger.offered ? offerLine(ledger.offered) : null; // shown to whoever it goes from (`offerFor.js`)
  // When their text set a held step aside and nothing new is held, an answer that asks nothing gives way to the ask line (Drop a stale answer).
  const dropped = finishSet.dropStaleAnswer === true && claims?.stale() === true && ledger.asked.length === 0 && ask !== null && !/\?/.test(told);
  const answer = [answerWithAsk(dropped ? "" : told, ask, ledger.asked), offerText].filter(Boolean).join("\n\n");
  /*
    A browser handed to the person goes out as a link the gateway adds, so
    the model never holds it. The link is their own `/tex/<handle>` page,
    which only they can open, signed in; it still stays out of the saved
    conversation below, because the line is the gateway's and not an answer
    the model gave.
  */
  const handoff = opened?.browser?.handoffLine() ?? null;
  const sent = handoff === null ? answer : `${answer}\n\n${handoff}`;
  const under = underOf(underParts, told, sent); // each part of what is sent, with the text it goes under (`replyUnder.js`)
  return { crossAskRun, tapped, hushed, quiet, silent, pictures, captions, choices, offers, verbatim, offerText, answer, sent, under };
}
// TEX ENTRY POINT: end
