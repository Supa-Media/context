/**
 * `/agent` — one question answered by a model that calls tools through the
 * very dispatcher an MCP client's calls go through (`callToolForSession`).
 */

import { claimCheck, correctsTheAsk, lastOffer } from "./claimCheck.js";
import { addressedTo, offerLine } from "../tools/offerFor.js";
import { handbackJudgeFor } from "./handbackJudge.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { AgentRefusal, agentTools, MAX_QUESTION_LENGTH, openProvider, runTurn } from "./turn.js";
import { callToolForSession } from "../tools/session.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { readTexNotes } from "./jobs.js";
import { openTranscript } from "./transcript.js";
import { groupTimingLine, turnKind, turnReport, waitBefore } from "./turnLog.js";
import { readProductionSetup, readProductionSkill } from "./production.js";
import { skillSession, withSkills } from "./skills.js";
import { openLearnedSkills, withLearnedSkills } from "./learnedSkills.js";
import { afterTextedTurn } from "./reflect.js";
import { reviewAfterTurn } from "./selfReview.js";
import { searchSettingsOf } from "../search/settings.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { BUILTIN_PROVIDER, builtinModel, canRunBuiltin } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { checkerQuestion, mailCheckerFor } from "./mailChecker.js";
import { appOriginOf, sentNoteLinksLine, withNoteLinks } from "./noteLinks.js";
import { decisionEngine } from "./decide.js";
import { openTurnWeb, theirEarlierWords } from "./turnWeb.js";
import { ProviderError } from "./providers.js";
import { meterEach, meterParts } from "./modelPlan.js"; import { advisorRequest, advisorTools } from "./advisor.js"; import { turnStages } from "./turnStages.js";
import { attachmentsLine, carriesData, carriesPictures, hearVoiceMessages, pictureFallback, turnAttachments, withAttachmentImages } from "./attachments.js";
import { withEmailFiles } from "./emailFiles.js";
import { carryKeptFiles, keepSentFiles, keptIdsOf, keptInHistory, withKeptFiles } from "./keptFiles.js";
import { EMPTY_FALLBACK, isEmptyAnswer } from "./replyChecks.js";
import { readTexStyle, stylePrompt, withoutFlattery } from "./pushback.js";
import { grantedToolsFor } from "./sixTools.js";
import { standingForwardTools } from "../tools/forwardRule.js";
import { SHOWN_HISTORY_TURNS, appendConversation, rememberRoutineText, conversationPath, earlierTextsTool, historyIsTainted } from "./conversation.js";
import { loggedTurn, recordedTurn, turnHistory } from "./loggedTurn.js"; import { newExchange } from "./events.js";
import { deferred } from "./deferred.js";
import { cancelledTurn } from "./textingRoutes.js";
import { loadRoutine, keepRun, readRuns, RoutineRefusal, ROUTINES_CLIENT_ID, routinePathFrom, routineRunQuestion, routineTimeZone, runOutcome, stopRoutine, finishOnce, routineCalendarTools } from "./routine.js";
import { textingAwareCallTool, textingWriteTools } from "./textingWrites.js";
import { withFolderFit } from "./folderFit.js"; import { withTheirNotesKept } from "./theirNotes.js";
import { delegateSession, withDelegate } from "./delegate.js";
import { NO_MODEL, deliverSupervision, prepareSupervision, withMailAgent } from "./supervise.js";
import { LONG_MAX_ROUNDS, LONG_TOOL_BUDGET_MS, progressChannel } from "./progress.js";
import { markUntrusted, newLedger } from "../privacy/egress.js";
import { transcriptionForwarder } from "../ingestion/transcription.js";
import { sentPicturesLine } from "./outgoingPictures.js";
import { turnPictures, withDrawnImages, withPictureMaker } from "./pictureMaker.js";
import { disarmTexting, withdrawPending } from "../tools/approvals.js";
import { askedWith, quotedOf, reactedLine, reactedOf, tapbackLine } from "./quoted.js";
import { threadPrompt, threadView } from "./threadView.js";
import { steerFor, steeredLine } from "./steer.js";
import { vaultSavedQuestion, withVaultWatch } from "./vaultSaved.js";
import { answerWithAsk, approvalVerdict, textedAsk, thumbsDownIsNo, thumbsUpIsYes } from "./textedApprovals.js";
import { setAsideLine, settleTextedText } from "./textedSettle.js"; import { mayAnswerAsk, waitingAsks } from "./frontDoor.js"; import { exchangeTurns, warmTurn } from "./warmCopy.js";
import { withSameAsk } from "./sameAsk.js"; // a change they pushed back on is never shown again
import { paidLine } from "./textedPay.js";
import { sleepLineNote } from "./timeLog.js"; // a sleep line their phone sends, read for sense
import { googleOfferLine } from "./googleOffer.js"; // offers Google once to a texter without it
import { backgroundSession, jobOf, jobPrompt, jobReportOf, jobReportPrompt, jobReportQuestion, runningJobsOf, startedJobs, withBackground, withJobSteps } from "./background.js";
import { chatLines, checkerHistory, earlierChatTool, groupAwareCallTool, groupOf, keepGroupSettled, withoutTexName, groupPrompt, groupWriteTools, isGroupSession, keepGroupExchange } from "./groupTurn.js";
/**
 * What a turn that may not run says. Nothing in the app can change this any
 * more (people's own model keys were deleted, the owner, 2026-10-10): the
 * built-in model answers texts and routines where the control plane allows
 * it, and every
 * other `no_provider` — another client, another plan, the assistant switched
 * off, a deployment with no built-in model, a request naming a provider — is
 * the same sentence, so none of them is told apart from the outside.
 */
const NO_MODEL_HERE = "The assistant isn't available here yet.";

/** The texting assistant's first-party client (`apps/convex/functions/textLinks.ts`). */
const TEXTS_CLIENT_ID = "context_texts";
/** The app's own client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

/**
 * One agent turn over HTTP.
 *
 * ## Why it is a route here rather than a tool, or a server of its own
 *
 * It is here because it must spend the *same* session, the same scope clamp and
 * the same store as `/mcp`. A second service would need a second answer to "may
 * this caller read that note", and the second answer is the one that drifts —
 * this worker has one privacy engine and one authority decision, and the agent
 * is a caller of them rather than a peer.
 *
 * It is not a tool because a tool is something a *model* invokes, and this is
 * the thing that invokes models.
 *
 * ## What comes back
 *
 * Whole turns, not a stream. A turn that finishes is worth more than a turn
 * that renders prettily, and adding SSE later changes `turn.js` and this
 * function without touching the authority above them. `steps` names the tools
 * that ran, in order, so the app can show what the agent did — names only, no
 * arguments: a path or a query is a fact about what somebody is looking for in
 * their own notes.
 *
 * ## Every refusal is the client's to read, and none of them is a reason
 *
 * A provider that errored is `model_unavailable` with no detail. The reason
 * lives in this deployment's own logs, because a provider's error body quotes
 * the request that produced it — the customer's question and their notes.
 */
export function handleAgent(request, env, store, session, controlPlane, options = {}) {
  const stages = turnStages(env); return recordedTurn(store, (outcome) => agentTurn(request, env, store, session, controlPlane, { ...options, stages }, outcome)).finally(() => stages.flush()); // every exit of a named turn is recorded (`loggedTurn.js`), with where its time went (`turnStages.js`)
}

async function agentTurn(request, env, store, session, controlPlane, { progress = null, step = null, stages = null }, outcome) {
  const received = Date.now();
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid_request", error_description: "Expected a JSON body." }, 400);
  }

  /*
    A routine's connection runs routines and nothing else, and nothing else runs
    one: both decided by the grant's client, never by the body. A routine grant
    that answered free questions would be a second texting grant nobody linked.
  */
  const runner = session.actorClientId === ROUTINES_CLIENT_ID;
  if (runner !== (body.routine !== undefined)) {
    return json(
      {
        error: "invalid_request",
        error_description: runner ? "This connection only runs routines." : "Only a routine's own connection runs one.",
      },
      runner ? 400 : 403,
    );
  }

  // A group chat's turn names its chat (`groupTurn.js`); decided by the grant, never by the body.
  const group = isGroupSession(session) ? groupOf(body, session) : null;
  if (isGroupSession(session) && group === null) return json({ error: "invalid_request", error_description: "A group chat's turn names its chat." }, 400);
  // Background jobs (`background.js`): a texted turn may start them, and a job's own turn names itself.
  const chatTurn = !runner && (session.actorClientId === TEXTS_CLIENT_ID || group !== null);
  const job = chatTurn ? jobOf(body.job) : null, report = jobReportOf(body, { chatTurn, job }); // and a job reporting to the chat's own turn, its coordinator (`jobReport.js`)

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  const hot = warmTurn(env, session, body, { eligible: session.actorClientId === TEXTS_CLIENT_ID && group === null && job === null && report === null && !runner, now: received }); // what the Worker kept of the last turn's reads (`warmCopy.js`)
  const setupRead = readProductionSetup(store, session, { texting: session.actorClientId === TEXTS_CLIENT_ID || runner || group !== null, warm: hot.setup }); // read beside what comes before it, not after

  // The routine is re-read now, before any model is opened: a paused or vanished one costs no turn.
  // A tool call through the client's own dispatcher, under this session.
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);
  let routine = null;
  let runs = [];
  // A delegated job's supervisor (`supervise.js`): what this run is for, decided before any model.
  let supervision = null;
  // A saved login's turn (`vaultSaved.js`) and a job's report are asked the gateway's own line, never the body's.
  let question = vaultSavedQuestion(body, { texting: session.actorClientId === TEXTS_CLIENT_ID && group === null, job }) ?? (report !== null ? jobReportQuestion(report) : null) ?? (typeof body.question === "string" ? body.question.trim() : "");
  if (runner) {
    try {
      routine = await loadRoutine(dispatch, routinePathFrom(body.routine));
    } catch (error) {
      if (!(error instanceof RoutineRefusal)) throw error;
      return json({ error: error.code, error_description: error.message }, error.code === "routine_gone" ? 404 : 400);
    }
    if (routine.settings.paused) return json({ outcome: "paused", skipped: true });
    runs = await readRuns(store, routine.path);
    question = await routineRunQuestion(store, routine, runs, body.routine.timeZone);
    // A job going well, done or gone costs no model call (`supervise.js`); done or gone stops its supervisor.
    supervision = await prepareSupervision(dispatch, routine, { runs, handle: store.contexts.find((c) => c.current)?.name });
    if (supervision?.skip) {
      const { skip: outcome, answer = "" } = supervision;
      await keepRun(store, routine, runs, outcome, answer || NO_MODEL);
      if (outcome === "finished") await stopRoutine(dispatch, routine.path);
      if (supervision.task) await deliverSupervision(store, dispatch, supervision, { outcome, text: answer }, (work) => deferred(store, work));
      return json({ outcome, answer, skipped: answer === "", send: routine.settings.send, to: routine.settings.to });
    }
    if (supervision !== null) question = supervision.question;
  }
  const { attachments: sent, refusal } = turnAttachments(body.attachments, runner); if (refusal) return json({ error: "invalid_request", error_description: refusal }, 400); // what came with the question (`attachments.js`); a routine's run has none
  if (question.length === 0 && sent.length === 0) {
    return json({ error: "invalid_request", error_description: "Ask a question." }, 400);
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return json({ error: "invalid_request", error_description: `A question is at most ${MAX_QUESTION_LENGTH} characters.` }, 400);
  }
  /*
    The words an inline reply answers (`quoted.js`). They are somebody else's
    — the message picked may be one Tex sent, carrying whatever Tex read — so
    they never join `question`, which is what the browser's addresses, the
    outgoing pictures, the sharing judge and the Mail checker all vouch from.
    Only `runTurn` sees the two together, and the quote is marked there.
  */
  const quoted = quotedOf(session.actorClientId === TEXTS_CLIENT_ID || group !== null ? body : null);
  const reacted = reactedOf(session.actorClientId === TEXTS_CLIENT_ID ? body : null); // tapbacks since their last text
  const steer = steerFor(store, session, body); // texts sent while it works (`steer.js`)
  if (steer !== null) outcome.turn = body.turn; // only a texted turn the Worker named is recorded (`loggedTurn.js`)

  // A texted yes or no settles a pending approval before any model runs (`textedSettle.js`).
  let setAside = [], dropped = [], paid = [], thumbsUp = false, asksRead = false; // dropped: asks Tex texted something else after by itself (`askOvertaken.js`)
  // A group chat's yes is its tagger's, said to Tex in the chat (`groupTurn.js`); a guest's is nobody's (`groupGuests.js`).
  const front = env.TEX_FRONT_DOOR !== "off" && (await setupRead)?.frontDoor !== false; // Haiku as the front door (`frontDoor.js`): only a yes or no is matched before it, and no reply checks after
  const ownConversation = group === null && conversationPath(body.conversation) !== null && hasScope(session, SCOPE_WRITE) ? body.conversation : null;
  if (front && (session.actorClientId === TEXTS_CLIENT_ID || group !== null) && job === null && group?.guestTagger !== true && !mayAnswerAsk(group !== null ? withoutTexName(question) : question, quoted, sent.length > 0)) [{ setAside = [], dropped = [] }, asksRead] = [(await waitingAsks(store, session, { conversation: ownConversation, told: body.told, now: received, warm: hot })) ?? {}, true];
  else if ((session.actorClientId === TEXTS_CLIENT_ID || group !== null) && job === null && group?.guestTagger !== true) {
    thumbsUp = await thumbsUpIsYes(store, session, quoted, { who: group?.from || null }); // a 👍 on the ask is that yes
    const thumbsDown = !thumbsUp && (await thumbsDownIsNo(store, session, quoted, { who: group?.from || null })); // and a 👎 the no
    const settled = await settleTextedText(store, session, {
      dispatch,
      // A tapback's own text is its emoji: a 👍 on other words is not a typed 👍, so it is no verdict.
      question: thumbsUp ? "yes" : thumbsDown ? "no" : quoted.tapback ? "" : group !== null ? withoutTexName(question) : question,
      keep: group !== null ? keepGroupSettled(store, group, dispatch) : null,
      hasAttachments: sent.length > 0,
      now: received,
      timeZone: readTimeZone(body.timeZone),
      defer: (work) => deferred(store, work),
      // Kept on the same terms as a model turn's history, below, with the Worker's fixed texts (`told`).
      conversation: ownConversation,
      told: body.told,
      thumbsUp,
    });
    if (settled?.answer !== undefined) return (outcome.clean = true), json(settled); // the gateway's words, nothing read
    ({ setAside = [], dropped = [] } = settled ?? {});
    paid = settled?.allowed ?? [];
  }

  try {
    await openProvider(controlPlane, session, body.provider, env); stages?.mark("provider");
  } catch (error) {
    outcome.turn = undefined; // no model ran: no record (`loggedTurn.js`)
    if (runner) await keepRun(store, routine, runs, error instanceof AgentRefusal ? error.code : "failed", "");
    if (error instanceof AgentRefusal && error.code === "daily_limit") {
      return json(
        { error: "daily_limit", error_description: "That's all the questions for today. Ask me again tomorrow." },
        429,
      );
    }
    if (error instanceof AgentRefusal) {
      return json(
        {
          error: error.code,
          error_description: NO_MODEL_HERE,
        },
        409,
      );
    }
    // A control plane that could not be reached is not a refusal, and telling somebody
    // the assistant is not theirs when it is is worse than telling them nothing.
    return json({ error: "model_unavailable" }, 503);
  }
  // Voice messages become their words only now, once the turn is allowed and counted; a file is kept for later texts and jobs, and shown to them again (`keptFiles.js`).
  const fresh = await keepSentFiles(store, await hearVoiceMessages(sent, transcriptionForwarder(env), session.workspaceId));

  const offered = await grantedToolsFor(session, store); stages?.mark("tools");

  /*
    THE EGRESS LEDGER FOR THIS TURN. `/agent` sees a turn whole — the
    question is the person's own words and every tool call passes through
    this gateway — so the ledger can say whether it took in anything from
    outside the workspace, and carry the asks it raised (`privacy/egress.js`).
  */
  const ledger = newLedger();
  /*
    "Seen whole" is a claim about who wrote the question, and only the clients
    that are ours can make it: the texting thread's question is the person's
    own message, the app's panel is their own hand, a routine is their own
    note. Any other connected client could put anything in `question`, so its
    turn is held like its tool calls are.
  */
  const firstParty =
    session.actorClientId === TEXTS_CLIENT_ID ||
    session.actorClientId === CONSOLE_CLIENT_ID ||
    session.actorClientId === ROUTINES_CLIENT_ID ||
    group !== null;
  session.egress = {
    complete: firstParty,
    ledger,
    texting: session.actorClientId === TEXTS_CLIENT_ID || group !== null,
    // The routine this run is, for a standing forward only it may use (`tools/forwardRule.js`).
    ...(runner ? { routine: routine.path } : {}),
    // A 👍 on words that were not the armed ask: Tex's own preview, maybe (`tools/likedPreview.js`).
    // In a group, only on words that asked this tagger by name (`tools/offerFor.js`).
    ...(!thumbsUp && (quoted.tapback === "Liked" || quoted.tapback === "Loved") && (group === null || addressedTo(quoted.words, group.from)) ? { liked: quoted.words } : {}),
    ...(group !== null ? { group: { from: group.from, people: group.people } } : {}), // who an email may be offered to (`offerFor.js`)
  };

  const learnedRead = openLearnedSkills(dispatch, { texted: session.actorClientId === TEXTS_CLIENT_ID, contexts: store.contexts, warm: hot.skills }).catch(() => null); // read beside the history, once the egress ledger is set
  // Today's history, and the chat's event log when the Worker names what this turn covers (`loggedTurn.js`).
  const [{ conversation, history }, logged] = await Promise.all([turnHistory(store, session, body, { runner, group, dispatch, warm: hot }), runner ? null : loggedTurn(store, body, { group, timeZone: readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE, workspace: session.workspaceId, warm: hot })]); // side by side
  const attachments = [...fresh, ...(runner ? [] : await carryKeptFiles(store, history, fresh))]; stages?.mark("history");
  if (group !== null || job?.tainted || report !== null) markUntrusted(ledger); // a job planned after a read from outside still carries it, and a job's report is what it read
  const background = chatTurn ? backgroundSession({ running: runningJobsOf(body.running), job, now: received }) : null;
  session.egress.turn = runner ? { note: routine?.body ?? "" } : { history, question }; // the sharing judge's
  // A typed yes, nothing armed, to Tex's last text offering a held change in its own words (`tools/likedPreview.js`).
  if (session.egress.liked === undefined && approvalVerdict(question) === "approve") session.egress.liked = [lastOffer(history)].find((offer) => group === null || addressedTo(offer, group.from)) ?? undefined;

  /*
    The Mail checker reads this thread's texts and nothing else the turn read
    (`mailChecker.js`), so it is made here, from the person's own words, before
    the model runs. Only a texted turn has those words; any other client's
    email waits for the person in the app with no checker in front of it.
  */
  if (session.actorClientId === TEXTS_CLIENT_ID || group !== null) {
    session.mailChecker = mailCheckerFor({
      // A group's kept turns carry what the chat said beside what the tagger
      // asked, and the checker reads a kept turn as the person (`groupTurn.js`).
      history: group !== null ? checkerHistory(history) : history,
      question: checkerQuestion(question, quoted),
      config: aiGatewayConfig(env),
      metadata: { feature: "mail-checker", workspace: String(session.workspaceId) },
    });
  }

  /*
    The computer is the texting assistant's for now (the owner's decision is
    about texting), behind the address guard in `computer.js`. Widening it to
    the app's agent panel is one condition here.
  */
  // Decided by the grant, never by the request body: only the texting client's
  // answers go out as iMessages, and only they are written for one. A
  // routine's answer is a text too, when it says anything.
  const texting = session.actorClientId === TEXTS_CLIENT_ID || runner;
  // A texted write answers with the note's link, so Tex can text it (`noteLinks.js`).
  // A group's too (2026-10-21): everyone in it is a member of the one workspace it reads, so the app link opens for each of them.
  const noteLinking = { origin: session.actorClientId === TEXTS_CLIENT_ID || group !== null ? appOriginOf(env) : null, contexts: store.contexts };
  // A text has the MCP's own write tools (`textingWrites.js`, the owner,
  // 2026-10-08); a routine's own run never may.
  const textingWriting = textingWriteTools(offered, { texting: session.actorClientId === TEXTS_CLIENT_ID });
  // A group chat edits as its tagger could in the app, never moving or deleting a note (`groupTurn.js`).
  const groupWriting = group !== null ? groupWriteTools(offered, group) : [];
  /*
    A long task texts its progress (`progress.js`): a person's own texted
    turn or a group's, asked for as a stream by the texting Worker. A routine runs
    unattended and texts once, so it never gets one.
  */
  const channel =
    typeof progress === "function" && (session.actorClientId === TEXTS_CLIENT_ID || group !== null) ? progressChannel(progress) : null;
  // Clef is metered with the turn (`meter` below).
  /*
    AN ADDRESS IS VOUCHED FOR BY THE PERSON, NEVER BY A PREVIOUS ANSWER.

    A texted turn's `question` is the person's own message, so it is both the
    prompt and the allow-list's source. A routine's is not: `routineQuestion`
    frames the note with the schedule and **the last run's answer**, which the
    model wrote. Seeding the guard from it would let a page read on one run
    plant an address in the answer and the next run fetch it — unattended,
    every run — which is the exfiltration `computer.js`'s guard exists to
    prevent, laundered through the bucket. So a routine vouches for the
    addresses in its own body and nothing else. The routine's *path* is not in
    the body either, which keeps `watch.md` from reading as a hostname. A group's chat lines are people's own words.
  */
  const vouched = runner ? routine?.body ?? "" : [theirEarlierWords(history), chatLines(group), question].filter(Boolean).join("\n\n"); // their earlier texts too (`turnWeb.js`)
  // Another agent's mail is someone else's words, like a page (`supervise.js`).
  if (supervision !== null) markUntrusted(ledger);
  const { opened, web } = await openTurnWeb(env, { session, texting, group, question, vouched, history: runner ? [] : history, channel, store, dispatch, ledger }); stages?.mark("web");

  /*
    THE PRODUCTION SETUP (`production.js`): the texting job's file on a texted
    turn or a group chat's (2026-10-23), none otherwise. Its prompt replaces the built-in words, and
    its model is used only when this deployment can call it: an uncallable one
    falls back.
  */
  const production = await setupRead; stages?.mark("setup");
  // What of the conversation this turn is shown: the setup's `history:`, else the default; a text typed in a thread, that thread (`threadView.js`).
  const { shown, ...inThread } = threadView(history, quoted, production?.history ?? SHOWN_HISTORY_TURNS);
  // A previous answer written after a read from outside still carries it.
  if (historyIsTainted(shown) || logged?.tainted === true) markUntrusted(ledger); // and what the log shows of a tainted turn (`loggedTurn.js`)
  if (attachments.length > 0) markUntrusted(ledger); // a forwarded PDF is someone else's words, like a page
  // The rest is read on request, and carries its own mark when it is read.
  const earlier = group !== null ? [earlierChatTool(history)] : conversation === null ? [] : [earlierTextsTool(history, () => markUntrusted(ledger))];
  // The setup's `search:` section, when it has one, over the deployment's
  // settings for this turn's searches, in this context and any it addresses
  // (`openContext` copies the store's settings at open time).
  if (production?.search) store.searchSettings = searchSettingsOf(store, production.search);
  // The setup's task skills (`skills.js`), read from the pinned workspace only when asked for.
  // A skill read this turn vouches for its own addresses and backticked values,
  // as the person's message does (`computer.js` `vouch`); nothing else can.
  const skills = skillSession(production?.skills ?? [], (path) => readProductionSkill(store, session, path), {
    onRead: (body) => opened?.vouch(body),
  });
  // Skills Tex wrote itself (`learnedSkills.js`): an index on a text, read on request, never vouched for.
  const learned = await learnedRead; stages?.mark("skills");
  // A text that can write may hand a sub-project to another agent (`delegate.js`), as the person.
  const home = store.contexts.find((entry) => entry.current)?.name ?? null;
  const delegation =
    session.actorClientId === TEXTS_CLIENT_ID && textingWriting.length > 0 && home !== null
      ? delegateSession(dispatch, {
          handle: home,
          home,
          vouch: (url, message) => opened?.delegated(url, message),
          trusted: () => ledger.untrusted !== true,
          browser: opened?.browser != null,
        })
      : null;
  // The setup's trusted sites (`trustedSites.js`), openable without an address given.
  // With `open_web: yes`, any public https address (owner, 2026-10-11).
  opened?.trust(production?.trustedSites ?? [], { openWeb: production?.openWeb === true });
  const productionModel =
    production !== null && canRunBuiltin(production.model, env) ? production.model : null;
  const builtinUsed = productionModel ?? builtinModel(env);
  // The setup's router (`router.js`), when this deployment can run both the
  // decision model and the thinking model; otherwise every text runs on `main`.
  const router =
    productionModel !== null && production.router !== null && canRunBuiltin(production.router.think, env)
      ? { decide: decisionEngine(env.AI), think: production.router.think, routeAt: production.router.routeAt, thinkRounds: production.router.thinkRounds }
      : null;
  // The setup's fallback model (`production.js`), when this deployment can call it.
  const fallback = pictureFallback(productionModel !== null && production.fallback !== null && canRunBuiltin(production.fallback, env) ? production.fallback : null, [builtinUsed, router?.think], attachments);

  const started = Date.now();
  /*
    The built-in turn was counted when it was allowed; this adds what it spent.
    Counts only, best effort: a meter that could not be reached costs us a
    report, not the person their answer.
  */
  const meter = async (usage, failed, model = builtinUsed, whole = true) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        // The model that spent this: a planned turn reports each (`modelPlan.js`), its own counts on one.
        model: typeof model === "string" ? model : builtinUsed,
        decision: whole ? (web?.usage.decision ?? 0) + (usage?.decision ?? 0) : 0,
        failed,
        ms: whole ? Date.now() - started : 0,
      });
    } catch {
      // See above.
    }
  };

  // Ours, not the person's: after the answer has gone (`deferred`).
  const afterAnswer = (work) => deferred(store, work);

  /*
    Every turn goes to the turn log (`apps/convex/functions/agentTurns.ts`) and
    to this deployment's logs: where its time went, by model round and tool
    name, so the agent can be audited and made faster. Never text. Best effort
    like the meter: a log that could not be reached costs us a row, not the
    person their answer.
  */
  const logTurn = (outcome, model, timing, usage, parts = null) => {
    const report = turnReport({ provider: BUILTIN_PROVIDER, outcome, model, timing, usage, parts, kind: turnKind({ runner, job, group, texting }), ms: Date.now() - received, waitMs: waitBefore(body.arrivedAt, received) }); stages?.ran(report);
    console.log(
      JSON.stringify({
        event: "agent_turn",
        workspace: session.workspaceId,
        grant: session.grantId, texting,
        ...report,
        trace: undefined,
        tools: report.trace.filter((entry) => entry.kind === "tool").map((entry) => entry.tool),
      }),
    );
    return (async () => {
      try {
        await controlPlane.recordAgentTurn(session.accessToken, session.workspaceId, report);
      } catch {
        // See above.
      }
    })();
  };

  // Their zone: a routine's own, else the one the texting Worker sent (`localNow.js`).
  const timeZone = runner ? routineTimeZone(routine.settings, body.routine.timeZone) : readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE;
  // Today's transcript (`transcript.js`), under a ledger of its own: what it reads, the model never does.
  const unseen = { ...session, egress: { ...session.egress, ledger: newLedger() } };
  Object.defineProperty(unseen, "accessToken", { value: session.accessToken, enumerable: false }); // as `sessionForContext`
  const transcript = texting
    ? openTranscript((name, args) => callToolForSession({ name, arguments: args }, store, unseen), {
        now: received,
        timeZone,
        question,
        quoted: quoted.words,
        attachments: fresh, // what came with this text, never a file shown again
        routine: runner ? routine.path : null,
      })
    : null;

  const texted = session.actorClientId === TEXTS_CLIENT_ID; // Pictures sent back, drawn or made: a text or a group's (`pictureMaker.js`).
  // A texted answer that says a change was made is checked against the calls that ran (`claimCheck.js`).
  const forwarding = runner ? [...(await standingForwardTools(store, routine.path, offered)), ...routineCalendarTools(offered)] : []; // and their own calendar (`routine.js`)
  // A small model also reads it for work handed back to them (`handbackJudge.js`).
  const claims = !runner && (!front || job !== null) && (texted || group !== null) ? claimCheck({ question, job, waiting: setAside.length > 0, corrects: correctsTheAsk(question, setAside), pictures: carriesPictures(attachments), kept: keptIdsOf(attachments, keptInHistory(history, { texts: Infinity })), keptShown: attachments.some((file) => file.kept), history, detailed: readTexStyle(body.texStyle)?.length === "detailed", visuals: () => maker?.has("draw_visual") === true, judge: env.HANDBACK_JUDGE !== "on" ? null : handbackJudgeFor({ question, config: aiGatewayConfig(env), metadata: { feature: "handback-judge", workspace: String(session.workspaceId) } }) }) : null;
  // A page's cover it draws is kept for the page's link card (`/gateway/page-cover`).
  const keepCover = async (path, png) => controlPlane.recordPageCover(session.accessToken, session.workspaceId, path, png);
  const { outgoing, maker } = await turnPictures(env, { texted: texted || group !== null, question, attachments, store, keep: conversation === "texts", meter, workspaceId: session.workspaceId, keepCover }); stages?.mark("pictures");
  const seenWeb = outgoing.wrapWeb(web); // pages read like any tool result, so cards get their photos; a card hunts more through it (`visuals/hunt.js`)
  maker?.useWeb?.(seenWeb === null ? null : (name, args) => seenWeb.call(name, args));
  try {
    await steer?.begin(); // `/agent/cancel` may stop it from now (`steer.js`)
    stages?.ready(); const turn = await runTurn({
      // With the log, the chat and its tapbacks are in the transcript, and the covered events are the question (`loggedTurn.js`).
      question: [logged === null ? chatLines(group) : "", logged === null ? reactedLine(reacted) : "", setAsideLine(setAside, dropped), paidLine(paid), sentNoteLinksLine(question, noteLinking.origin), logged?.question ?? askedWith(question, quoted), logged === null ? sleepLineNote(question) : ""].filter(Boolean).join("\n\n"),
      place: body.place ?? null,
      // A turn that edits directly is not also handed proposals: they have no
      // screen on a phone, and two ways to change a note is one too many.
      tools: [
        ...agentTools(offered).filter((tool) => (textingWriting.length === 0 && group === null && !runner) || tool.name !== "propose_note"), // a routine stops itself with DONE:, never a proposal
        ...textingWriting, ...groupWriting, ...forwarding,
        ...(skills?.tools ?? []), ...(learned?.tools ?? []),
        ...(delegation?.tools ?? []), ...(background?.tools ?? []),
        ...(supervision?.mail.tools ?? []), ...(maker?.tools ?? []),
      ],
      // THE ONE DISPATCHER, AND IT IS THE CLIENT'S (`callToolForSession`): its routing and every
      // per-call scope refusal. An agent that reached past it would be a second, untested authority.
      onModel: (model) => void (store.usageModel = model),
      answerCheck: claims?.check ?? null,
      callTool: (steer?.track ?? ((call) => call))(withVaultWatch(ledger, (claims?.wrap ?? ((call) => call))(withSameAsk({ on: claims !== null, store, session, ledger, history, question }, withBackground(background, outgoing.wrap(
        withPictureMaker(maker, withDrawnImages(outgoing, withAttachmentImages(
          attachments,
          withEmailFiles({ store, attachments }, withKeptFiles(store, () => markUntrusted(ledger), withMailAgent(supervision?.mail ?? null, withDelegate(delegation, withLearnedSkills(learned, withSkills(skills, withNoteLinks(withFolderFit(group !== null ? groupAwareCallTool(withTheirNotesKept(dispatch, { question, on: !runner }), groupWriting, { store, group, question }) : textingAwareCallTool(withTheirNotesKept(dispatch, { question, on: !runner }), textingWriting, { timeZone })), noteLinking)), { tainted: () => ledger.untrusted === true, dispatch }))))),
        ))),
      )))))),
      pictures: texted || group !== null,
      attachments,
      env,
      providerOptions: {
        ai: env.AI,
        gateway: aiGatewayConfig(env),
        // Ids only: what the AI costs tab files this call's spend under.
        metadata: {
          feature: "assistant",
          workspace: String(session.workspaceId),
          client: group !== null ? "texts-group" : texting ? "texts" : "app",
          // The setup that answered, when one did: which note a cost is for.
          ...(production !== null ? { setup: production.version } : {}),
        },
      },
      web: steer?.trackWeb(claims?.wrapWeb(seenWeb) ?? seenWeb) ?? claims?.wrapWeb(seenWeb) ?? seenWeb, // whether the web was tried before "I couldn't open it" (`claimCheck.js`)
      history: logged?.history ?? shown,
      threadNote: (group !== null ? groupPrompt(group, home) : "") + threadPrompt(inThread) + (background?.prompt ?? "") + jobPrompt(job) + jobReportPrompt(report) + (texted && job === null ? await googleOfferLine(store, shown) : "") + (chatTurn ? stylePrompt(readTexStyle(body.texStyle)) : ""), steer,
      local: [...earlier, ...(chatTurn && productionModel !== null && production.advisor && canRunBuiltin(production.advisor, env) ? advisorTools({ model: production.advisor, effort: production.efforts?.[production.advisor], history: shown, question, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "advisor" } }), meter }) : [])], // the advisor, when the setup names one (`advisor.js`)
      // What Tex keeps about them and its open jobs, in their own workspace (`aboutMe.js`, `jobs.js`), on a texted turn,
      ...(texting ? outgoing.knows(await hot.notes(() => readTexNotes(dispatch, { controlPlane, session }))) : {}), // and who they are by their account (`identity.js`); where they live starts a places card's distances (`visuals/distance.js`)
      localNow: { now: Date.now(), timeZone },
      observe: withJobSteps(job, step, transcript?.record ?? null), // a job's steps also go to its chat (`background.js`)
      workspaces: contextsFor(session), // Where a new note goes (`workspaces.js`).
      texting: texting || group !== null, // a group's answer is a text too, written for one
      notes: production !== null ? { prompt: production.prompt } : null,
      builtinModelOverride: productionModel ?? undefined,
      router,
      efforts: production?.efforts ?? null,
      fallback,
      maxRounds: production?.maxSteps ?? undefined,
      // A browser call can open a page and settle it (`infra/site-shots`
      // budgets 17 s); the default would cut a slow one short and lose it. A captcha on the page
      // adds Browserbase's 30 s solver wait, then a reload and a fresh browser (`captchaLadder.js`):
      // at 30 s the ladder never finished, and Tex handed an Instacart picture check over (2026-10-24).
      // A card's boxes are filled one browser call each, after the person's yes (`fillCard.js`).
      // An email or calendar change is checked by the control plane and the Mail checker before it is held (2026-10-22: three "timed out" for one email;
      // the owner: "at least 2 minutes … it's a crucial thing"). A quick group turn cuts it to its own end (`turn.js`).
      toolTimeouts: { browse: 160_000, fill_login: 30_000, fill_card: 60_000, draw_picture: 40_000, draw_visual: 75_000, make_picture: 70_000, send_email: 120_000, save_email_draft: 120_000, calendar_event: 40_000, slack_api: 40_000, google_chat: 40_000 },
      // A background job is long whether or not it streams (`background.js`).
      // So is a data file to work through: Opus plans it, so a breakdown isn't guessed on the everyday model (2026-10-24).
      planned: job !== null || carriesData(attachments), ...(channel !== null || job !== null ? { ...(channel !== null ? { progress: channel } : {}), roundCap: LONG_MAX_ROUNDS, toolBudgetMs: LONG_TOOL_BUDGET_MS } : {}),
    });
    // The question's browser is not left running, unless held while the answer waits on them (`browserHold.js`).
    if (opened !== null) await afterAnswer(opened.close(turn.exhausted ? {} : { answer: turn.answer, vaultLink: ledger.vaultLink }));
    await afterAnswer(meterEach(turn, meter)); // one report per model it ran on, at its own price (`modelPlan.js`)
    await afterAnswer(logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage, meterParts(turn)));
    outcome.clean = ledger.untrusted !== true;
    // Cancelled by the Worker (`steer.js`), in a round or after the last: its asks are withdrawn, nothing is kept as said, and nothing is texted.
    if (turn.cancelled || (steer !== null && (await steer.endCancelled()))) return await cancelledTurn(store, session, { ledger, steer, transcript, steps: turn.steps });

    if (runner) {
      const ran = turn.exhausted ? { outcome: "failed", text: "" } : runOutcome(turn.answer, { routine, runs });
      await afterAnswer(transcript.finish({ answer: ran.text, outcome: ran.outcome }));
      await keepRun(store, routine, runs, ran.outcome, ran.text);
      /*
        A routine that texts the person is a message they may answer with a bare
        "ok" or "yes", and that answer is to it, not to an ask raised before it.
      */
      if (ran.text && routine.settings.send !== "note") {
        await disarmTexting(store, { userId: session.actorUserId });
        await rememberRoutineText(store, routine, ran.text, ledger.untrusted);
      }
      // A routine whose `until:` came true stops itself, recoverably.
      if (ran.outcome === "finished" && routine.cadence.unit !== "once") {
        await stopRoutine(dispatch, routine.path);
      }
      // A one-off has run: it stays where it is, marked done (`finishOnce`).
      if (supervision !== null) await deliverSupervision(store, dispatch, supervision, ran, afterAnswer);
      if (routine.cadence.unit === "once" && ran.outcome !== "failed") {
        await finishOnce(dispatch, routine.path, {
          now: Date.now(),
          timeZone: routineTimeZone(routine.settings, body.routine.timeZone),
        });
      }
      return json({
        outcome: ran.outcome,
        answer: ran.text,
        skipped: ran.outcome !== "answered" && ran.outcome !== "finished",
        send: routine.settings.send,
        to: routine.settings.to,
        provider: turn.provider,
        model: turn.model,
        steps: turn.steps,
      });
    }

    // The ask goes out in the gateway's own words, after whatever the model
    // said: a person can allow only what they were told about, and the model
    // relaying it is a courtesy rather than the mechanism.
    // An answer still empty after its notice is never sent as nothing (`replyChecks.js`); a routine's empty run is its SKIP.
    // A flattering opener ("You're so right!") comes off first (`pushback.js`).
    const { answer: told, pictures, captions, choices = [], offers = [] } = outgoing.take(!runner && isEmptyAnswer(turn.answer) ? EMPTY_FALLBACK : withoutFlattery(turn.answer));
    // An email's ask is texted exactly as written (`apps/agent/src/reply.ts`), or withdrawn if it would not fit; asks their text corrected are dropped (`claimCheck.js` rule 6).
    const { ask, verbatim } = await textedAsk(store, session, ledger.asked, told, { who: group?.from || null, stale: claims?.stale() === true ? setAside.map((entry) => entry.id) : null });
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
    if (transcript !== null) await afterAnswer(transcript.finish({ answer, outcome: turn.exhausted ? "exhausted" : "answered" }));
    // A job's answer that a later text will replace is never texted, so it isn't kept as said; the next part is shown it (`jobPrompt`).
    const replaced = (job !== null && steer !== null && (await steer.pending())) || (!turn.exhausted && claims?.unfinished(turn.answer) === true); // or one that stopped short (`stopsShort.js`)
    if (steer !== null) await afterAnswer(steer.clear());
    // A hard job, written down for next time (`reflect.js`): after the answer; a tainted turn reflects on their own text and step names only.
    await afterAnswer(afterTextedTurn({ env, controlPlane, store, session, offered, question, turn, tainted: ledger.untrusted === true, ownText: !runner && job === null && group === null, learned, canWrite: textingWriting.some((tool) => tool.name === "write_note"), timeZone }));

    const behind = front ? afterAnswer : (work) => work; // on the front door the chat is saved after the reply has gone; best effort, as below: a memory that failed to save costs the chat some context, not this answer
    if (group !== null && job === null && !turn.exhausted && !replaced) await behind(keepGroupExchange(store, group, history, question, [answer, sentPicturesLine(pictures, captions)].filter(Boolean).join("\n"), { tainted: ledger.untrusted, tools: turn.steps.filter((step) => step.ok).map((step) => step.tool), sources: turn.steps.flatMap((step) => step.sources ?? []), timing: groupTimingLine({ arrivedAt: body.arrivedAt, received, done: Date.now(), fixed: body.fixed }), dispatch }).catch(() => {})); // with its cards' words (`sentPicturesLine`)
    const saving = conversation !== null && job === null && !turn.exhausted && !replaced, said = [answer, sentPicturesLine(pictures, captions)].filter(Boolean).join("\n");
    const kept = { ...newExchange(), tainted: ledger.untrusted, tools: turn.steps.filter((step) => step.ok).map((step) => step.tool), sources: turn.steps.flatMap((step) => step.sources ?? []), thread: inThread.thread, theirs: session.actorClientId === TEXTS_CLIENT_ID }; // addresses only (`sources.js`); the same exchange is handed to the warm copy
    if (saving) await behind((async () => { // a job's answer is its report, never texted: only the coordinator's turn is kept as said (`jobReport.js`)
      try {
        const saved = [reactedLine(reacted), tapbackLine(quoted) || question, attachmentsLine(attachments, (await transcript?.kept()) ?? []), steeredLine(steer?.words ?? [])].filter(Boolean).join("\n"); // names only, never bytes
        await appendConversation(store, conversation, history, saved, said, kept);
      } catch {
        // The answer is still owed. A history that failed to save costs the next turn some context, not this one its reply.
      }
    })());

    // "fix this" or frustration scores the conversation now (`selfReview.js`); quiet ends do it from the Worker.
    if (!turn.exhausted) await afterAnswer(reviewAfterTurn({ env, store, session, controlPlane, question, group, saved: group !== null || conversation !== null }));
    return json({
      answer: sent,
      // How many held calls the answer's last line asks about, so a caller that
      // plays the person (the bench) knows a YES is awaited; zero on a clean turn.
      asked: ledger.asked.length,
      askIds: ledger.asked.map((asked) => asked.id), // the records its asks armed, for the Worker's ask events and `/agent/stale`
      ...(steer !== null && steer.taken.length > 0 ? { steered: steer.taken } : {}), // the Worker drops these from its queue
      ...(verbatim.length > 0 || offerText ? { verbatim: [...verbatim, ...(offerText ? [offerText] : [])] } : {}),
      ...(offerText ? { askFor: ledger.offered.who } : {}), // the Worker takes only their 👍 or yes
      ...startedJobs(background, ledger.untrusted === true), // the Worker runs these (`background.js`)
      ...(pictures.length > 0 ? { pictures, ...(choices.length > 0 ? { choices } : {}) } : {}), ...(offers.length > 0 ? { offers } : {}), // choices, offers: `outgoingPictures.js`
      ...(ledger.vaultLink === true && group === null ? { vaultWatch: true } : {}), // the Worker watches for the save (`vaultSaved.js`)
      provider: turn.provider,
      model: turn.model,
      steps: turn.steps,
      ...(turn.exhausted ? { exhausted: true } : claims?.unfinished(turn.answer) ? { unfinished: true } : {}),
      ...{ warm: (await hot.seal({ exchange: saving && attachments.length === 0 ? exchangeTurns([reactedLine(reacted), tapbackLine(quoted) || question, steeredLine(steer?.words ?? [])].filter(Boolean).join("\n"), said, kept) : null, keepChat: !saving || attachments.length === 0, turn: body.turn, clean: ledger.untrusted !== true, wrote: turn.steps.length > 0, asks: asksRead && setAside.length === 0 && ledger.asked.length === 0 && !ledger.offered ? "none" : null })) ?? undefined }, // the copy the Worker hands back with the next text (`warmCopy.js`)
    });
  } catch (error) {
    outcome.clean = false;
    if (steer !== null) await steer.clear();
    if (opened !== null) await afterAnswer(opened.close());
    if (transcript !== null) await afterAnswer(transcript.finish({ answer: "", outcome: "the turn failed" }));
    await meter(null, true);
    /*
      An ask the person was never told about (the turn failed before its ask
      line went out) is withdrawn: left waiting, it would be released by the
      next bare "yes", which is about something else.
    */
    await withdrawPending(store, { userId: session.actorUserId, ids: ledger.asked.map((asked) => asked.id) }).catch(() => {});
    if (runner) await keepRun(store, routine, runs, "failed", "");
    if (error instanceof ProviderError) {
      await afterAnswer(logTurn("failed", error.model, error.timing, null));
      // Logged for an operator, opaque to the caller. `reason` is a phrase this
      // worker wrote and a status; `builtin.js` and `aiGateway.js` never put a
      // response body in it, because a provider's error body quotes the request.
      console.log(
        JSON.stringify({
          event: "agent_provider_error",
          workspace: session.workspaceId,
          grant: session.grantId,
          provider: BUILTIN_PROVIDER,
          reason: error.reason,
          status: error.status,
        }),
      );
      return json({ error: "model_unavailable" }, 502);
    }
    throw error;
  }
}
