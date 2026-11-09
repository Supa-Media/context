/** Builds the reply that gets texted, writes it to the chat's ledger, and saves the exchange. One step of Tex's turn (`../texEntryPoint.js`). */

import { json } from "../../http/responses.js";
import { offerLine } from "../../tools/offerFor.js";
import { advisorRequest } from "../advisor.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { attachmentsLine } from "../attachments.js";
import { QUIET_ACK, QUIET_ACK_LINE, QUIET_REPORT_LINE, reportReply, startedJobs } from "../background.js";
import { canRunBuiltin } from "../builtin.js";
import { chatHubUrl } from "../hubLinks.js";
import { keepGroupExchange } from "../groupTurn.js";
import { jobFields, jobTurnFields } from "../jobCheck.js";
import { wordsEntry } from "../ledger.js";
import { exchangeEntries } from "../ledgerConversation.js";
import { sentPicturesLine } from "../outgoingPictures.js";
import { withoutFlattery } from "../pushback.js";
import { reactedLine, tapbackLine } from "../quoted.js";
import { afterTextedTurn } from "../reflect.js";
import { EMPTY_FALLBACK, isEmptyAnswer } from "../replyChecks.js";
import { reviewAfterTurn } from "../selfReview.js";
import { steeredLine } from "../steer.js";
import { deskEligible, learnDeskKeys } from "../texDesk.js";
import { changedCalendar, refreshCalendarCache } from "../calendarCache.js";
import { answerWithAsk, textedAsk } from "../textedApprovals.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { groupTimingLine, waitBefore } from "../turnLog.js";
import { turnTiming } from "../turnTiming.js";
import { heardWords, sentLine } from "../heardWords.js";
import { jobChecked, startedJobEntries } from "../workEntries.js";
import { VAULT_SAVED_QUESTION } from "../vaultSaved.js";
import { typedCallOf } from "../sayNothing.js"; // a call typed out is never texted, the last stop before it goes

/** Whether the history this turn was shown (and can read with earlier_texts) holds an answer from a turn that read from outside. */
export function showsOutsideWords(history) {
  return Array.isArray(history) && history.some((entry) => entry?.role === "assistant" && entry.tainted === true);
}

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function sendTheReply(t) {
  const { answered, askChat, attachments, background, begun, body, builtinUsed, chatLog, claims, controlPlane, conversation, dispatch, env, front, group, history, hot, inThread, job, keepPictures, learned, ledger, ledgerTurn, meter, offered, opened, outgoing, production, question, quoted, reacted, received, report, router, runner, session, setAside, steer, store, tex, textingWriting, timeZone, turn } = t;
  // The ask goes out in the gateway's own words, after whatever the model
  // said: a person can allow only what they were told about, and the model
  // relaying it is a courtesy rather than the mechanism.
  // An answer still empty after its notice is never sent as nothing (`replyChecks.js`); a routine's empty run is its SKIP.
  // A flattering opener ("You're so right!") comes off first (`pushback.js`).
  const hushed = turn.answer === QUIET_ACK; // a start or restart they asked to hear nothing about until it's done (`background.js`)
  const { answer: replied, quiet } = hushed ? { answer: "", quiet: true } : reportReply(report, turn.answer), silent = job === null && (((group !== null || turn.settled === "say_nothing") && /^\W*SKIP\W*$/.test(String(replied ?? ""))) || typedCallOf(replied) !== null), { answer: told, pictures, captions, choices = [], offers = [] } = outgoing.take(quiet || silent ? "" : !runner && isEmptyAnswer(replied) ? EMPTY_FALLBACK : withoutFlattery(replied)); // a report's quiet is a flag, and an ended job always gets a line (`jobReport.js`); a group's bare SKIP, or any say_nothing (`sayNothing.js`), is silence, never the fallback, and only SKIP: "Quiet." answers a question (Dev2, 2026-11-01: Tex texted "my answer got lost" to a message for Instinct)
  // An email's ask is texted exactly as written (`apps/agent/src/reply.ts`), or withdrawn if it would not fit; asks their text corrected are dropped (`claimCheck.js` rule 6).
  const { ask, verbatim } = await tex.step("ask_line", () => textedAsk(store, session, ledger.asked, told, { who: group?.from || null, stale: claims?.stale() === true ? setAside.map((entry) => entry.id) : null, chat: askChat }));
  const offerText = ledger.offered ? offerLine(ledger.offered) : null; // shown to whoever it goes from (`offerFor.js`)
  const answer = [answerWithAsk(claims?.stale() === true && ledger.asked.length === 0 && ask !== null && !/\?/.test(told) ? "" : told, ask, ledger.asked), offerText].filter(Boolean).join("\n\n"); // a drop's line replaces the model's unless it asked something
  /*
    A browser handed to the person goes out as a link the gateway adds, so
    the model never holds it. The link is their own `/tex/<handle>` page,
    which only they can open, signed in; it still stays out of the saved
    conversation below, because the line is the gateway's and not an answer
    the model gave.
  */
  const handoff = opened?.browser?.handoffLine() ?? null;
  const sent = handoff === null ? answer : `${answer}\n\n${handoff}`;
  // A turn no text of theirs asked (a job's report, a vault save) keeps the gateway's line it was asked, so the chat rebuilt from the ledger shows what Tex answered.
  const eventAsked = report !== null || question === VAULT_SAVED_QUESTION ? String(question).slice(0, 2_000) : null;
  // What the person's chat rebuilt from the ledger shows beside this answer (`ledgerConversation.js`): the files they sent and where a picture is kept, the pages it read, the thread it was typed in.
  const attached = attachmentsLine(attachments, attachments.length > 0 ? ((await tex.step("pictures_kept", keepPictures)) ?? []) : []), sources = turn.steps.flatMap((step) => step.sources ?? []);
  chatLog?.write([...startedJobEntries(background?.started, { turn: body.turn }), wordsEntry("reply", sent, { turn: ledgerTurn, model: turn.model, ms: Date.now() - received, timing: turnTiming({ steps: tex.steps, trace: turn.timing?.trace, waitMs: waitBefore(body.arrivedAt, received), worker: body.worker, replyMs: Date.now() - received }), clean: ledger.untrusted !== true, ...(turn.exhausted ? { outcome: "exhausted" } : {}), ...(attached ? { attached } : {}), ...(sources.length > 0 ? { sources } : {}), ...(typeof inThread.thread === "string" ? { thread: inThread.thread } : {}), ...(eventAsked !== null ? { about: eventAsked } : {}) })]); await tex.after("ledger", () => chatLog?.flush()); // with the jobs it started (`workEntries.js`); `clean`: what a later turn trusts it by (`ledgerHistory.js`)
  // A job's answer that a later text will replace is never texted, so it isn't kept as said; the next part is shown it (`jobPrompt`).
  const replaced = (job !== null && steer !== null && (await tex.step("steer_pending", () => steer.pending()))) || (!turn.exhausted && claims?.unfinished(turn.answer) === true); // or one that stopped short (`stopsShort.js`)
  if (steer !== null) await tex.after("steer_clear", () => begun.catch(() => {}).then(() => steer.clear()));
  // A hard job, written down for next time (`reflect.js`): after the answer; a tainted turn reflects on their own text and step names only.
  // So does one shown an earlier tainted answer: its words never mark the turn, but they never become a skill or about-me either (`turn-trust.md`).
  await tex.after("reflect", () => afterTextedTurn({ env, controlPlane, store, session, offered, question, turn, tainted: ledger.untrusted === true || showsOutsideWords(history), ownText: !runner && job === null && group === null, learned, canWrite: textingWriting.some((tool) => tool.name === "write_note"), timeZone }));

  if (group !== null && job === null && !turn.exhausted && !replaced && !(silent && answer === "")) await tex.behind(front, "save_group_chat", () => keepGroupExchange(store, group, history, question, [answer, sentPicturesLine(pictures, captions)].filter(Boolean).join("\n"), { tainted: ledger.untrusted, tools: turn.steps.filter((step) => step.ok).map((step) => step.tool), sources: turn.steps.flatMap((step) => step.sources ?? []), timing: groupTimingLine({ arrivedAt: body.arrivedAt, received, done: Date.now(), fixed: body.fixed }), dispatch }).catch(() => {})); // with its cards' words (`sentPicturesLine`)
  const saving = conversation !== null && job === null && !turn.exhausted && !replaced, said = [answer || (hushed ? QUIET_ACK_LINE : quiet ? QUIET_REPORT_LINE : ""), sentPicturesLine(pictures, captions)].filter(Boolean).join("\n");
  if (saving) await tex.behind(front, "save_chat", () => (async () => { // a job's answer is its report, never texted: only the coordinator's turn is kept as said (`jobReport.js`)
    try {
      // A caller other than the texting Worker (which posts every text both ways itself, `/agent/events`) keeps its exchange in the ledger, in the gateway's words.
      // An event turn that texted nothing is kept as that, a line beside the gateway's question, since the Worker posts no text of Tex's for it.
      if (session.actorClientId === TEXTS_CLIENT_ID && eventAsked !== null && answer === "" && said !== "") { chatLog?.write([wordsEntry("note", said, { turn: ledgerTurn, about: eventAsked })]); await tex.step("ledger_texts", () => chatLog?.flush()); }
      if (session.actorClientId !== TEXTS_CLIENT_ID) { chatLog?.write(exchangeEntries([reactedLine(reacted), tapbackLine(quoted) || question, steeredLine(steer?.words ?? [])].filter(Boolean).join("\n"), said, { turn: ledgerTurn, asked: received })); await tex.step("ledger_texts", () => chatLog?.flush()); } if (conversation === "texts" && group === null) await tex.step("learn_desk_keys", () => learnDeskKeys(store, session.workspaceId)); // the desk's note keys, for the next turn (`texDesk.js`)
    } catch {
      // The answer is still owed. A history that failed to save costs the next turn some context, not this one its reply.
    }
  })());

  // Their next 7 days, read again behind the reply when the copy is stale or this turn changed the calendar (`calendarCache.js`).
  if (job === null && group === null && conversation === "texts" && deskEligible(store)) await tex.after("calendar_copy", () => refreshCalendarCache(dispatch, { timeZone, force: changedCalendar(turn.steps) }));
  // "fix this" or frustration scores the conversation now (`selfReview.js`); quiet ends do it from the Worker.
  if (!turn.exhausted) await tex.after("self_review", () => reviewAfterTurn({ env, store, session, controlPlane, question, group, saved: group !== null || conversation !== null }));
  const reply = {
    answer: sent, ...((quiet || silent) && sent === "" ? { quiet: true } : {}), // nothing to text, as a flag the Worker reads, never a word (`jobReport.js`)
    // How many held calls the answer's last line asks about, so a caller that
    // plays the person (the bench) knows a YES is awaited; zero on a clean turn.
    asked: ledger.asked.length,
    askIds: ledger.asked.map((asked) => asked.id), // the records its asks armed, for the Worker's ask events and `/agent/stale`
    ...(steer !== null && steer.taken.length > 0 ? { steered: steer.taken } : {}), // the Worker drops these from its queue
    ...(verbatim.length > 0 || offerText ? { verbatim: [...verbatim, ...(offerText ? [offerText] : [])] } : {}),
    ...(offerText ? { askFor: ledger.offered.who } : {}), // the Worker takes only their 👍 or yes
    ...startedJobs(background, ledger.untrusted === true, { heard: heardWords(attachments), sent: sentLine(attachments, attached) }), // the Worker runs these (`background.js`), asked their words, voice and files included (`heardWords.js`)
    ...(pictures.length > 0 ? { pictures, ...(choices.length > 0 ? { choices } : {}) } : {}), ...(offers.length > 0 ? { offers, ...hubField(offers, chatHubUrl(env, session, group)) } : {}), // choices, offers: `outgoingPictures.js`; `hub`: where "what I'm working on" points (`hubLinks.js`)
    ...(ledger.vaultLink === true && group === null ? { vaultWatch: true } : {}), // the Worker watches for the save (`vaultSaved.js`)
    provider: turn.provider,
    model: turn.model,
    steps: turn.steps,
  };
  // A job's part says its answer before the advisor's check, unchecked: a gateway that dies during the check (out of
  // memory, 2026-11-08) no longer loses a finished part, which the Worker then ran again from nothing (`progress.js`).
  if (job !== null && typeof answered === "function") await tex.step("answer_early", () => answered({ ...withoutSteps(reply), ...jobFields(null, { exhausted: turn.exhausted === true, unfinished: claims?.unfinished(turn.answer) === true, untrusted: ledger.untrusted === true }), ...(turn.steps?.length ? {} : { idle: true }) }));
  return json({
    ...reply,
    ...(await tex.step("job_fields", () => jobChecked(session, { job, steps: turn.steps?.length ?? 0, turn: body.turn }, () => jobTurnFields(job, turn, { unfinished: claims?.unfinished(turn.answer) === true, untrusted: ledger.untrusted === true, model: [production?.advisor, router?.think, builtinUsed].find((name) => typeof name === "string" && canRunBuiltin(name, env)), efforts: production?.efforts, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "job-check" } }), meter })))), // a job's part is checked by the advisor against its finish line (`jobCheck.js`)
    ...{ warm: (await tex.step("seal_warm", () => hot.seal({ wrote: turn.steps.length > 0 }))) ?? undefined }, // the copy the Worker hands back with the next text (`warmCopy.js`)
  });
}
// TEX ENTRY POINT: end

/** The reply without its steps, which only the final line needs: the early line stays small. */
function withoutSteps({ steps: _steps, provider: _provider, model: _model, ...said }) {
  return said;
}

/** `hub` beside an answer that offered the live view of its jobs, when the chat has one (`hubLinks.js`). */
function hubField(offers, hub) {
  return offers.includes("threads") && hub !== null ? { hub } : {};
}
