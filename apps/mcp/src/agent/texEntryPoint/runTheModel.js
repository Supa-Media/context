/** Runs the model with every tool, then closes the browser, records usage, and stops on a refusal or a cancel. One step of Tex's turn (`../texEntryPoint.js`). */

import { contextsFor } from "../../context/identity.js";
import { markUntrusted } from "../../privacy/egress.js";
import { ADVISOR_TOOL, advisorRequest, advisorTimeoutMs, advisorTools, jobAdvisorLine } from "../advisor.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { carriesData, withAttachmentImages } from "../attachments.js";
import { jobPrompt, jobReportPrompt, withBackground, withJobSteps } from "../background.js";
import { canRunBuiltin } from "../builtin.js";
import { withChatSkills } from "../chatSkills.js";
import { OPEN_PAGE_TIMEOUT_MS } from "../computer.js";
import { instructionsPrompt, readInstructions } from "../customInstructions.js";
import { withDelegate } from "../delegate.js";
import { withEmailFiles } from "../emailFiles.js";
import { withFolderFit } from "../folderFit.js";
import { chatLines, commandTools, consentForTurn, groupAwareCallTool, groupPrompt, settingsChanged, taggedLine } from "../groupTurn.js";
import { computerTools } from "../../machines/texActions.js";
import { judgeFor } from "../../privacy/judge.js";
import { withKeptFiles } from "../keptFiles.js";
import { learnedSkillsLine, withLearnedSkills } from "../learnedSkills.js";
import { setupPromptFor, turnKind } from "../promptModules.js";
import { ledgerObserver } from "../ledger.js";
import { collectReads } from "../toldFacts.js";
import { meterEach, meterParts } from "../modelPlan.js";
import { sentNoteLinksLine, withNoteLinks } from "../noteLinks.js";
import { withDrawnImages, withPictureMaker } from "../pictureMaker.js";
import { turnEfforts } from "../production.js";
import { LONG_MAX_ROUNDS, LONG_TOOL_BUDGET_MS } from "../progress.js";
import { askedWith, loggedQuestion, reactedLine } from "../quoted.js";
import { withSameAsk } from "../sameAsk.js";
import { withSkills } from "../skills.js";
import { withMailAgent } from "../supervise.js";
import { allowedFirst } from "../texTiming.js";
import { paidLine } from "../textedPay.js";
import { PLAN_DEFINITION, PLAN_HINT, planCall, splitFirst } from "../planBigAsk.js";
import { computersLine, delegationBeside } from "../../machines/forTurn.js";
import { setAsideLine } from "../textedSettle.js";
import { cancelledTurn } from "../textingRoutes.js";
import { textingAwareCallTool } from "../textingWrites.js";
import { withTheirNotesKept } from "../theirNotes.js";
import { threadPrompt } from "../threadView.js";
import { sleepLineNote } from "../timeLog.js";
import { agentTools, runTurn } from "../turn.js";
import { chatHubUrl, hubPrompt } from "../hubLinks.js";
import { withVaultWatch } from "../vaultSaved.js";
import { doItChecks } from "../doItChecks.js";
import { replyJudge } from "../replyJudge.js";
import { threadsSortAndWrite } from "../conversationThreads.js";
import { withArchitecture } from "../texArchitecture.js";

/** The setup's rules with the drawing ahead, the box named for this kind of turn (`texArchitecture.js`). */
const setupWithMap = (prompt, kind) => (typeof prompt === "string" && prompt !== "" ? withArchitecture(prompt, kind) : prompt);

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function runTheModel(t) {
  const { allowedRead, attachments, background, begun, body, channel, chatLog, chatTurn, claims, computersRead, controlPlane, delegation: delegated, dispatch, dropped, earlier, env, fallback, forwarding, group, groupWriting, history, home, inThread, job, knowsRead, learned, ledger, ledgerAt, logTurn, logged, maker, meter, noteLinking, offered, opened, outcome, outgoing, paid, production, productionModel, question, quoted, reacted, refused, report, router, routine, runner, seenWeb, session, setAside, shown, skills, stages, steer, step, store, streamed, supervision, tex, texted, texting, textingWriting, threadsRun, timeZone } = t;
  // When the setup's reply reviewer reads a draft, it replaces the older word checks (`untriedWeb.js`, `doItChecks.js`); a draft it does not read (one written with no action, `replyJudge.js`) gets them instead.
  // A routine's run that texts is reviewed too, as a text nobody asked for (Dev2, 2026-11-07: a routine texted its own reasoning); one that writes only a note is not a text.
  // Only a text to the person is reviewed (Dev2, 2026-11-07): a routine that texts other people (`to:`) is theirs, not reviewed.
  const scheduled = runner && routine?.settings?.send !== "note" && !(Array.isArray(routine?.settings?.to) && routine.settings.to.length > 0) ? "routine" : null;
  const gated = ((chatTurn && job === null && !runner && (texted || group !== null)) || scheduled !== null) && Boolean(production?.replyJudge) && aiGatewayConfig(env) !== null; // no AI Gateway, no reviewer: the word checks stay
  const tries = t.tries;
  if (!tex.lean) await tex.wait("steer_begin", begun);
  const knows = knowsRead === null ? null : await tex.wait("tex_notes", knowsRead);
  // A big ask the advisor plans and the gateway splits into jobs, when the setup says so (`planBigAsk.js`).
  const planning = background !== null && job === null && !routine && production?.planBigAsks === true && productionModel !== null && canRunBuiltin(production.advisor, env);
  // Their computers, told to the turn, and code no longer delegated to the web while one is paired (`machines/forTurn.js`).
  const computers = computersRead === null || computersRead === undefined ? [] : await tex.wait("computers", computersRead);
  const delegation = delegationBeside(delegated, computers);
  // A read offered back instead of done, and an advisor they asked for and nobody asked, go back once, on the front door too, without judges (`doItChecks.js`).
  const doIt = chatTurn && job === null && !runner && (texted || group !== null) ? doItChecks({ question, inner: claims ?? tries }) : null;
  // The setup's reply reviewer, after `claimCheck.js`: one Haiku call reads the reply against every action this turn took and the kind of turn it is, and sends it back with feedback only for a problem they would notice, at most once, and only on a draft written after an action (`replyJudge.js`; Dev2, 2026-11-06 and 2026-11-11). A job's report turn shows it the report.
  const askedNow = (logged ? loggedQuestion(logged.question, quoted, logged.replying) : askedWith(question, quoted)); // what the reviewers read as their text
  const judge = gated ? replyJudge({ setting: production.replyJudge, config: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "reviewer" }, report, scheduled, timeZone, question: askedNow, history: logged?.history ?? shown, inner: claims, plain: doIt ?? claims ?? tries }) : null;
  // A progress line goes unreviewed (Dev2, 2026-11-11, one-judge PR 3): it says what Tex is doing, and a review held each one up to 8 s.
  if (planning) background.plan = planCall({ model: production.advisor, effort: production.efforts?.[production.advisor], history: shown, question, background, meter, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "advisor" } }) });
  if (planning) splitFirst(background); // a lone job is offered the planner once
  // The advisor, when the setup names one this deployment can run: offered on every chat turn, a job's included (`advisor.js`).
  const advising = chatTurn && productionModel !== null && Boolean(production.advisor) && canRunBuiltin(production.advisor, env);
  // The chat by conversation: the thread list as it stood after the text before, then the last 24 hours (`threadedTurn.js`), in 1:1 and in groups.
  // The new text is sorted only after the answer has gone, and its verdict kept for the next turn (Dev2, 2026-11-12: "Never wait for it").
  const threaded = threadsRun ? await tex.wait("threads", threadsRun) : null;
  if (threaded?.sort) tex.after("threads_sort", () => threadsSortAndWrite(threaded.sort, store, session));
  // Whether Tex answers at all was the Worker's one judge's, before this turn was asked for (`textDecide.cjs`).
  stages?.ready(); const turn = await tex.step("model", () => runTurn({
    // With the log, the chat and its tapbacks are in the transcript, and the covered events are the question (`loggedTurn.js`).
    question: [logged === null ? chatLines(group) : "", logged === null ? reactedLine(reacted) : "", setAsideLine(setAside, dropped), paidLine(paid), sentNoteLinksLine(question, noteLinking.origin), (logged ? loggedQuestion(logged.question, quoted, logged.replying) : askedWith(question, quoted)), logged === null ? sleepLineNote(question) : ""].filter(Boolean).join("\n\n"),
    place: body.place ?? null,
    tools: [
      ...agentTools(offered),
      ...textingWriting, ...groupWriting, ...forwarding,
      ...(skills?.tools ?? []), ...(learned?.tools ?? []),
      ...(delegation?.tools ?? []), ...(background?.tools ?? []), ...(planning ? [PLAN_DEFINITION] : []),
      ...(supervision?.mail.tools ?? []), ...(maker?.tools ?? []),
    ],
    // THE ONE DISPATCHER, AND IT IS THE CLIENT'S (`callToolForSession`): its routing and every
    // per-call scope refusal. An agent that reached past it would be a second, untested authority.
    onModel: (model) => void (store.usageModel = model),
    // A group turn's tool start goes down the stream as a step line: the Worker taps the asked message once on the first (`groupModelTurn.ts`).
    ...(group !== null && job === null && typeof step === "function" ? { onToolStart: (name) => void Promise.resolve(step(name)).catch(() => {}) } : {}),
    answerCheck: judge?.check ?? doIt?.check ?? claims?.check ?? tries?.check ?? null, endsTurn: background?.endsTurn ?? null, sayNothing: job === null, scheduled: runner === true, roundNote: background?.roundNote ?? null, // a job's start answers at once (`background.js`); a routine's run may say nothing too, as its prompt tells it (`routine.js`; 2026-11-07: offered none, it texted why)
    callTool: allowedFirst(tex.lean ? allowedRead : null, (steer?.track ?? ((call) => call))(withVaultWatch(ledger, (claims?.wrap ?? ((call) => call))(withSameAsk({ on: claims !== null, store, session, ledger, history, question }, withBackground(background, outgoing.wrap(
      withPictureMaker(maker, withDrawnImages(outgoing, withAttachmentImages(
        attachments,
        withEmailFiles({ store, attachments }, withKeptFiles(store, () => markUntrusted(ledger), withMailAgent(supervision?.mail ?? null, withDelegate(delegation, withChatSkills(group, learned, withLearnedSkills(group !== null ? null : learned, withSkills(skills, withNoteLinks(withFolderFit(group !== null ? groupAwareCallTool(withTheirNotesKept(dispatch, { question, on: !runner }), groupWriting, { store, group, outside: () => ledger.outside === true }) : textingAwareCallTool(withTheirNotesKept(dispatch, { question, on: !runner }), textingWriting, { timeZone })), noteLinking)), { tainted: () => ledger.untrusted === true, dispatch }), { outside: () => ledger.outside === true }))))),
      ))),
    ))))))),
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
    web: steer?.trackWeb((claims ?? tries)?.wrapWeb(seenWeb) ?? seenWeb) ?? (claims ?? tries)?.wrapWeb(seenWeb) ?? seenWeb, // whether the web was tried before "I couldn't open it" (`claimCheck.js`)
    history: threaded?.history ? [...threaded.history, ...(logged?.carried ?? [])] : logged?.history ?? shown, // the stretch's turns after it (`stretch.js`)
    // Per text, so said in their turn after the cached prefix (`turnPrompt.js`): who tagged it, the thread, the jobs running now, whether their computers are online.
    turnNote: [group !== null ? taggedLine(group) : "", threaded?.note ?? "", threaded?.timeNote ?? "", threadPrompt(logged ? { thread: null } : inThread), background?.runningNow ?? "", job === null ? computersLine(computers, { planning }) : ""].map((part) => part.trim()).filter(Boolean).join("\n\n"),
    threadNote: (group !== null ? groupPrompt(group, home) : "") + learnedSkillsLine(learned) + (background?.prompt ?? "") + (planning ? PLAN_HINT : "") + (chatTurn && job === null ? hubPrompt(chatHubUrl(env, session, group), { group: group !== null }) : "") + jobPrompt(job) + jobAdvisorLine(job, advising) + jobReportPrompt(report) + (chatTurn ? instructionsPrompt(readInstructions(body.instructions)) : ""), steer,
    local: (doIt?.wrapLocal ?? ((local) => local))([...earlier, ...(threaded?.read_thread ? [threaded.read_thread] : []), ...(chatTurn && job === null && !routine ? commandTools({ run: (command) => settingsChanged(env, controlPlane.texCommand(session.accessToken, command), command, group ? { chat: group.key } : { person: session.workspaceId }), group, consent: consentForTurn(question, env) }) : []), ...(chatTurn && job === null && !routine ? computerTools({ env, session, controlPlane, group, words: question, judge: judgeFor(env) }) : []), ...(advising ? advisorTools({ model: production.advisor, effort: production.efforts?.[production.advisor], history: shown, question, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "advisor" } }), meter }) : [])]), // the advisor, when the setup names one (`advisor.js`); watched for whether they asked for it (`doItChecks.js`)
    // What Tex keeps about them and its open jobs, in their own workspace (`aboutMe.js`, `jobs.js`), on a texted turn,
    ...(knows === null ? {} : outgoing.knows(knows)), // and who they are by their account (`identity.js`); where they live starts a places card's distances (`visuals/distance.js`)
    localNow: { now: Date.now(), timeZone },
    observe: chatLog === null ? withJobSteps(job, step, null) : collectReads((t.reads = []), ledgerObserver(chatLog, withJobSteps(job, step, null), ledgerAt)), // a job's steps also go to its chat (`background.js`), and every step to the chat's ledger; what it read, for the facts its reply keeps (`toldFacts.js`)
    workspaces: contextsFor(session), // Where a new note goes (`workspaces.js`).
    texting: texting || group !== null, // a group's answer is a text too, written for one
    notes: production !== null ? { prompt: setupWithMap(setupPromptFor(production, turnKind({ group, job })), turnKind({ group, job })) } : null, // a 1:1 text, a group or a job: each its own modules (`promptModules.js`)
    builtinModelOverride: productionModel ?? undefined,
    router,
    efforts: turnEfforts(production, job), // a job's turn thinks as `models.job_effort` says (`production.js`)
    fallback,
    maxRounds: production?.maxSteps ?? undefined,
    // A browser call can open a page and settle it (`infra/site-shots`
    // budgets 17 s); the default would cut a slow one short and lose it. A captcha on the page
    // adds Browserbase's 30 s solver wait, then a reload and a fresh browser (`captchaLadder.js`):
    // at 30 s the ladder never finished, and Tex handed an Instacart picture check over (2026-10-24).
    // A card's boxes are filled one browser call each, after the person's yes (`fillCard.js`).
    // An email or calendar change is checked by the control plane and the Mail checker before it is held (2026-10-22: three "timed out" for one email;
    // the owner: "at least 2 minutes … it's a crucial thing"). A quick group turn cuts it to its own end (`turn.js`).
    // The advisor (Opus, thinking) answers in 20 to 38 s: its own limit, longer in a job (`advisor.js`, 2026-11-12).
    toolTimeouts: { open_page: OPEN_PAGE_TIMEOUT_MS, browse: 160_000, fill_login: 30_000, fill_card: 60_000, draw_picture: 40_000, draw_visual: 75_000, make_picture: 70_000, send_email: 120_000, save_email_draft: 120_000, calendar_event: 40_000, slack_api: 40_000, google_chat: 40_000, [ADVISOR_TOOL]: advisorTimeoutMs(job !== null) },
    // A background job is long whether or not it streams (`background.js`).
    // So is a data file to work through: Opus plans it, so a breakdown isn't guessed on the everyday model (2026-10-24).
    planned: job !== null || carriesData(attachments), ...(streamed || job !== null ? { ...(channel?.offered ? { progress: channel } : {}), roundCap: LONG_MAX_ROUNDS, toolBudgetMs: LONG_TOOL_BUDGET_MS } : {}),
  }));
  const notAllowed = tex.lean ? await tex.wait("allowed", allowedRead).then(() => null, (thrown) => thrown) : null; // beside the model, its no ends the turn here: no tool ran (`allowedFirst`), nothing is kept or sent
  if (notAllowed !== null) return (opened !== null && tex.after("browser_close", () => opened.close()), steer !== null && tex.after("steer_clear", () => begun.catch(() => {}).then(() => steer.clear())), await tex.step("refused", () => refused(notAllowed)));
  // The question's browser is not left running, unless held while the answer waits on them (`browserHold.js`).
  if (opened !== null) await tex.after("browser_close", () => opened.close(turn.exhausted ? {} : { answer: turn.answer, vaultLink: ledger.vaultLink }));
  await tex.after("usage", () => meterEach(turn, meter)); // one report per model it ran on, at its own price (`modelPlan.js`)
  await tex.after("turn_row", logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage, meterParts(turn)));
  outcome.clean = ledger.untrusted !== true;
  // Cancelled by the Worker (`steer.js`), in a round or after the last: its asks are withdrawn, nothing is kept as said, and nothing is texted.
  if (turn.cancelled || (steer !== null && (await tex.step("cancel_check", () => steer.endCancelled())))) return await tex.step("cancelled", () => begun.catch(() => {}).then(() => cancelledTurn(store, session, { ledger, steer, steps: turn.steps })));
  Object.assign(t, { turn, replyPlace: null }); // the classifier no longer runs before the reply, so it places none (`threadedTurn.js`)
}
// TEX ENTRY POINT: end
