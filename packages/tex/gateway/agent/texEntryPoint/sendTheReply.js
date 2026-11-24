/** Builds the reply that gets texted, writes it to the chat's ledger, and saves the exchange. One step of Tex's turn (`../texEntryPoint.js`). */

import { openAskBefore } from "../openAsk.js";
import { roundsField } from "../lastRound.js";
import { json } from "../../../../../apps/mcp/src/http/responses.js";
import { advisorRequest } from "../advisor.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { attachmentsLine } from "../attachments.js";
import { crossBackInput } from "../crossChat.js";
import { QUIET_ACK_LINE, QUIET_REPORT_LINE, startedJobs } from "../background.js";
import { canRunBuiltin } from "../builtin.js";
import { chatHubUrl } from "../hubLinks.js";
import { keepGroupExchange } from "../groupTurn.js";
import { jobFields, jobTurnFields } from "../jobCheck.js";
import { gatewayGraph } from "../graph/gatewayGraph.js";
import { texConfigOf } from "../texConfig.js";
import { finishTheText } from "./finishTheText.js";
import { jobCheckFor } from "../graph/bridges.js";
import { wordsEntry } from "../ledger.js";
import { briefEntry } from "../judgeBrief.js";
import { readInstructions } from "../customInstructions.js";
import { exchangeEntries } from "../ledgerConversation.js";
import { sentPicturesLine } from "../outgoingPictures.js";
import { reactedLine, tapbackLine } from "../quoted.js";
import { steeredLine } from "../steer.js";
import { deskEligible, learnDeskKeys } from "../texDesk.js";
import { changedCalendar, refreshCalendarCache } from "../calendarCache.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { groupTimingLine, waitBefore } from "../turnLog.js";
import { turnTiming } from "../turnTiming.js";
import { heardWords, sentLine } from "../heardWords.js";
import { jobChecked, startedJobEntries } from "../workEntries.js";
import { VAULT_SAVED_QUESTION } from "../vaultSaved.js";
import { HANDED_BACK_QUESTION, handbackField } from "../handback.js";
import { tapbackSaidLine } from "../tapbackEnding.js"; // a tapback as the whole answer: nothing texted, the Worker reacts
import { factsEntry } from "../toldFacts.js";
import { connectInput } from "../connectInput.js"; // what the Connect step is handed
import { texVersion } from "../texVersion.js"; // which Tex answered, for the Lab's replays

/** Whether the history this turn was shown (and can read with earlier_texts) holds an answer from a turn that read from outside. */
export function showsOutsideWords(history) {
  return Array.isArray(history) && history.some((entry) => entry?.role === "assistant" && entry.tainted === true);
}

/** The reply entry's `version` (`../texVersion.js`), or nothing when none is known. */
const versionField = (env, production) => {
  const version = texVersion(env, production);
  return version === null ? {} : { version };
};

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
/** The texts this turn took in that the Worker drops from its queue: steered in while it ran, or taken behind it. */
const steeredField = (ids) => {
  const unique = [...new Set(ids.filter((id) => typeof id === "string"))];
  return unique.length > 0 ? { steered: unique } : {};
};

export async function sendTheReply(t) {
  const { answered, attachments, background, begun, body, builtinUsed, chatLog, claims, controlPlane, conversation, dispatch, env, front, group, history, hot, inThread, job, keepPictures, learned, ledger, ledgerTurn, meter, offered, opened, production, replyPlace, question, quoted, reacted, received, report, router, runner, session, steer, store, tex, textingWriting, timeZone, turn } = t;
  // The words are Finish the text's (node "finish", `finishTheText.js`), made before this step when the config wires it;
  // a turn that did not run it (a draft without the step) finishes them here, the same way.
  const { crossAskRun, tapped, hushed, quiet, silent, pictures, captions, choices, offers, verbatim, offerText, answer, sent, under } = t.finished ?? (await tex.step("finish_text", () => finishTheText(t)));
  // A turn no text of theirs asked (a job's report, a vault save) keeps the gateway's line it was asked, so the chat rebuilt from the ledger shows what Tex answered.
  const eventAsked = report !== null || t.crossChat || question === VAULT_SAVED_QUESTION || question === HANDED_BACK_QUESTION ? String(question).slice(0, 2_000) : null;
  // What the person's chat rebuilt from the ledger shows beside this answer (`ledgerConversation.js`): the files they sent and where a picture is kept, the pages it read, the thread it was typed in.
  const attached = attachmentsLine(attachments, attachments.length > 0 ? ((await tex.step("pictures_kept", keepPictures)) ?? []) : []), sources = turn.steps.flatMap((step) => step.sources ?? []);
  // What this group turn knew, for the judge's next look (`judgeBrief.js`): its work, what it waits on, the chat's own rules.
  const brief = group !== null && job === null ? briefEntry({ group, question, steps: turn.steps, asked: ledger.asked, offered: ledger.offered ?? null, instructions: readInstructions(body.instructions), turn: ledgerTurn }) : null;
  tex.logTo?.(chatLog, ledgerTurn); // every step's time and outcome so far, and each one after the response (`texTiming.js`)
  chatLog?.write([...startedJobEntries(background?.started, { turn: body.turn }), ...(brief ? [brief] : []), wordsEntry(crossAskRun ? "note" : "reply", crossAskRun ? `(Your answer, sent back to Tex in ${t.crossChat.from}; nothing was texted here:)\n${sent}` : sent, { turn: ledgerTurn, model: turn.model, ms: Date.now() - received, ...versionField(env, production), timing: turnTiming({ steps: tex.steps, trace: turn.timing?.trace, waitMs: waitBefore(body.arrivedAt, received), worker: body.worker, replyMs: Date.now() - received }), clean: ledger.untrusted !== true, outside: ledger.outside === true, ...(turn.exhausted ? { outcome: "exhausted" } : {}), ...(attached ? { attached } : {}), ...(sources.length > 0 ? { sources } : {}), ...factsEntry(sent, t.reads, t.ledgerAt?.grant), ...(typeof inThread.thread === "string" ? { thread: inThread.thread } : {}), ...(eventAsked !== null ? { about: eventAsked } : {}) })]); await tex.after("ledger", () => chatLog?.flush()); // with the jobs it started (`workEntries.js`); `clean`: what a later turn trusts it by (`ledgerHistory.js`); `outside`: whether a later turn replaying its calls is marked (`stretch.js`)
  // A job's answer that a later text will replace is never texted, so it isn't kept as said; the next part is shown it (`jobPrompt`).
  const replaced = (job !== null && steer !== null && (await tex.step("steer_pending", () => steer.pending()))) || (!turn.exhausted && claims?.unfinished(turn.answer) === true); // or one that stopped short (`stopsShort.js`)
  if (steer !== null) await tex.after("steer_clear", () => begun.catch(() => {}).then(() => steer.clear()));
  // A hard job, written down for next time (`reflect.js`): after the answer; a tainted turn reflects on their own text and step names only.
  // So does one shown an earlier tainted answer: its words never mark the turn, but they never become a skill or about-me either (`turn-trust.md`).
  const taintedTurn = ledger.untrusted === true || showsOutsideWords(history), ownText = !runner && job === null && group === null, canWrite = textingWriting.some((tool) => tool.name === "write_note"); // the background wires' inputs (`reflect.js`)
  const afterCtx = { env, controlPlane, store, session, offered, turn, learned, timeZone }, afterGraph = gatewayGraph({ env, writer: chatLog, turn: ledgerTurn, config: texConfigOf(env) }); // each run kept in the chat's ledger as a node step; a Lab test chat's on its draft
  if (afterGraph.wired("send", "learn")) {
    // A draft that draws Learn (the memory nudge, then reflect, one step: Dev2, 2026-11-16), fired by this code with its own input over the wire.
    await tex.after("learn", async () => afterGraph.fire("send", "learn", { question, answer: turn.answer ?? "", tainted: taintedTurn, ownText, canWrite }, afterCtx).catch(() => {}).then(() => chatLog?.flush()));
  } else {
    await tex.after("reflect", async () => afterGraph.fire("send", "reflect", { question, tainted: taintedTurn, ownText, canWrite }, afterCtx).catch(() => {}).then(() => chatLog?.flush())); // interim: fired by this code with its own input over the wire (tagged "fired", so the run never fires it with send's output) until send's output carries it
    await tex.after("memory_nudge", async () => afterGraph.fire("send", "nudge", { question, answer: turn.answer ?? "", tainted: taintedTurn, canWrite }, afterCtx).catch(() => {}).then(() => chatLog?.flush())); // interim: fired by this code with its own input over the wire (tagged "fired", so the run never fires it with send's output) until send's output carries it
  }
  // A draft that draws Connect (`noteConnect.js`): the notes this turn wrote, linked both ways with why, behind the reply.
  const connecting = connectInput({ steps: turn.steps, question, ledger, group });
  if (connecting !== null && afterGraph.wired("send", "connect")) await tex.after("connect", async () => afterGraph.fire("send", "connect", connecting, afterCtx).catch(() => {}).then(() => chatLog?.flush()));

  if (group !== null && job === null && !crossAskRun && !turn.exhausted && !replaced && !(silent && answer === "")) await tex.behind(front, "save_group_chat", () => keepGroupExchange(store, group, history, question, [answer || (tapped !== null ? tapbackSaidLine(tapped) : ""), sentPicturesLine(pictures, captions)].filter(Boolean).join("\n"), { tainted: ledger.untrusted, tools: turn.steps.filter((step) => step.ok).map((step) => step.tool), sources: turn.steps.flatMap((step) => step.sources ?? []), timing: groupTimingLine({ arrivedAt: body.arrivedAt, received, done: Date.now(), fixed: body.fixed }), dispatch }).catch(() => {})); // with its cards' words (`sentPicturesLine`)
  const saving = conversation !== null && job === null && !turn.exhausted && !replaced, said = [answer || (tapped !== null ? tapbackSaidLine(tapped) : hushed ? QUIET_ACK_LINE : quiet ? QUIET_REPORT_LINE : ""), sentPicturesLine(pictures, captions)].filter(Boolean).join("\n");
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
  // "fix this" or frustration scores the conversation after the reply: the Self-review node, on Text them's background wire (`../graph/nodes/selfreview.js`).
  const reply = {
    answer: sent, ...((quiet || silent) && sent === "" ? { quiet: true } : {}), // nothing to text, as a flag the Worker reads, never a word (`jobReport.js`)
    ...(hushed && report === null && sent === "" ? { react: tapped ?? "" } : {}), // a tapback in place of a text: a job start's, the Worker's own pick from their words; the Worker checks the emoji (`reactEmoji.ts`)
    ...(under !== null ? { under } : {}), // which text each part goes under, when one turn answered several (`replyUnder.js`)
    ...(replyPlace === "under" || replyPlace === "plain" ? { place: replyPlace } : {}), // under the text it answers, or plain in the chat (`conversationThreads.js`)
    // How many held calls the answer's last line asks about, so a caller that
    // plays the person (the bench) knows a YES is awaited; zero on a clean turn.
    asked: ledger.asked.length,
    askIds: ledger.asked.map((asked) => asked.id), // the records its asks armed, for the Worker's ask events and `/agent/stale`
    ...steeredField([...(steer?.taken ?? []), ...(Array.isArray(t.logged?.took) ? t.logged.took : [])]), // the Worker drops these from its queue; `took`: the asker's texts that landed behind the turn (`takenBehind.js`)
    ...(verbatim.length > 0 || offerText ? { verbatim: [...verbatim, ...(offerText ? [offerText] : [])] } : {}),
    ...(offerText ? { askFor: ledger.offered.who } : {}), // the Worker takes only their 👍 or yes
    ...startedJobs(background, ledger.untrusted === true, { heard: heardWords(attachments), sent: sentLine(attachments, attached), asked: openAskBefore(history, question, { now: Date.now() }) }), // the Worker runs these (`background.js`), asked their words, voice and files included (`heardWords.js`)
    ...(pictures.length > 0 ? { pictures, ...(choices.length > 0 ? { choices } : {}) } : {}), ...(offers.length > 0 ? { offers, ...hubField(offers, chatHubUrl(env, session, group)) } : {}), // choices, offers: `outgoingPictures.js`; `hub`: where "what I'm working on" points (`hubLinks.js`)
    ...(ledger.chatMuted === true ? { muted: true } : {}), // the chat was muted: the Worker says so in fixed words, whatever this turn texted (`commandTools.js`)
    ...(ledger.chatInvite ? { invite: ledger.chatInvite } : {}), // the Worker invites this chat's people, as its asker, after the answer (`settingsTools.js`)
    ...(ledger.vaultLink === true ? { vaultWatch: true, ...(ledger.vaultLinks?.length ? { vaultLinks: ledger.vaultLinks } : {}) } : {}), // the Worker watches for the save, in a group too, on the links this chat texted (`vaultSaved.js`)
    ...(await tex.step("handback_watch", () => handbackField(opened))), // the browser it handed over, whose Done carries the task on (`handback.js`)
    ...(ledger.crossAsks?.length ? { crossAsks: ledger.crossAsks } : {}), // asks the Cross-chat gate let go: the Worker starts each in its chat (`crossChat.js`)
    provider: turn.provider,
    model: turn.model,
    steps: turn.steps,
    ...roundsField(turn), // how many rounds it took of how many, and whether it ran to its bound or handed the job off (`lastRound.js`)
    ...(turn.route ? { route: turn.route } : {}), // the specialist door the router picked, its sure and any fallback (`doorTurn.js`)
  };
  // A run answering another chat's ask texts nothing here: node "Answer the other chat" sends its draft back (`crossChat.js`).
  if (crossAskRun) Object.assign(reply, await tex.step("chat_answer", () => crossBackOf(t.crossChat, turn.answer, ledger.crossPost, { env, writer: chatLog, turn: ledgerTurn })));
  void t.rounds?.forget(); // answered: an earlier try's snapshot of this text goes (`turnResume.js`)
  // A job's part says its answer before the advisor's check, unchecked: a gateway that dies during the check (out of
  // memory, 2026-11-08) no longer loses a finished part, which the Worker then ran again from nothing (`progress.js`).
  if (job !== null && typeof answered === "function") await tex.step("answer_early", () => answered({ ...withoutSteps(reply), ...jobFields(null, { exhausted: turn.exhausted === true, unfinished: claims?.unfinished(turn.answer) === true, untrusted: ledger.untrusted === true }), ...(turn.steps?.length ? {} : { idle: true }) }));
  return json({
    ...reply,
    ...(await tex.step("job_fields", () => jobChecked(session, { job, steps: turn.steps?.length ?? 0, turn: body.turn }, () => jobTurnFields(job, turn, { unfinished: claims?.unfinished(turn.answer) === true, untrusted: ledger.untrusted === true, model: [production?.advisor, router?.think, builtinUsed].find((name) => typeof name === "string" && canRunBuiltin(name, env)), efforts: production?.efforts, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "job-check" } }), meter, config: texConfigOf(env), check: jobCheckFor(job?.id, gatewayGraph({ env, writer: session.ledger ?? null, turn: typeof body.turn === "string" ? body.turn : null })) })))), // a job's part is checked by the advisor against its finish line (`jobCheck.js`)
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

/** An ask-run's reply: nothing texted here, its draft and any signed post handed back by node `chatAnswer`. */
async function crossBackOf(event, draft, post, { env, writer, turn }) {
  const graph = gatewayGraph({ env, writer, turn, config: texConfigOf(env) });
  const input = crossBackInput(event, draft, post);
  const run = graph.wired("answerCheck", "chatAnswer") ? await graph.fire("answerCheck", "chatAnswer", input, { env }).catch(() => null) : null;
  const back = run?.to === "back" ? run : { id: event.id, state: "refused", texts: [], why: "the answer could not be sent back" };
  return { answer: "", quiet: true, crossBack: { id: back.id, state: back.state, texts: back.texts ?? [], ...(back.why ? { why: back.why } : {}) }, ...(back.post ? { crossPost: back.post } : {}) };
}

