/** Runs the model with every tool, then closes the browser, records usage, and stops on a refusal or a cancel. One step of Tex's turn (`../texEntryPoint.js`). */

import { underNote } from "../replyUnder.js";
import { speaker } from "../logRender.js";
import { shapeNote } from "../shapeGate.js";
import { contextsFor } from "../../../../../apps/mcp/src/context/identity.js";
import { markUntrusted } from "../../../../../apps/mcp/src/privacy/egress.js";
import { devShareOn, devSharePrompt } from "../devShare.js";
import { screenForTurn, screenNote, screenOn } from "../screen.js";
import { CONSOLE_CLIENT_ID } from "./clients.js";
import { groupChatsForTurn, groupsOn } from "../groupChats.js";
import { CARDS_PART, cardsPrompt } from "../memberCards.js";
import { styleFacts } from "../chatStyle.js";
import { ADVISOR_TOOL, advisorRequest, advisorTimeoutMs, advisorTools, jobAdvisorLine } from "../advisor.js";
import { TRAINING, settingsOf, texCacheTtl, texConfigOf, texFreeze, texToolList } from "../texConfig.js";
import { consentContext } from "../consentContext.js";
import { frozenModules } from "../frozenModules.js";
import { prefixKeeper, warmWired } from "../warmPrefix.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { carriesData, withAttachmentImages } from "../attachments.js";
import { jobBriefPrompt, jobPartPrompt, jobReportPrompt, withBackground, withJobSteps } from "../background.js";
import { roomReads } from "../roomCheck.js";
import { handoffHook, routeSureOf } from "../handoff.js";
import { withJobDrafts } from "../jobSaved.js";
import { SAY_NOTHING_TOOL } from "../sayNothing.js";
import { standsGate } from "../standsCheck.js";
import { canRunBuiltin } from "../builtin.js";
import { withChatSkills } from "../chatSkills.js";
import { OPEN_PAGE_TIMEOUT_MS } from "../computer.js";
import { instructionsPrompt, readInstructions } from "../customInstructions.js";
import { withDelegate } from "../delegate.js";
import { withEmailFiles } from "../emailFiles.js";
import { withFolderFit } from "../folderFit.js";
import { chatLines, commandTools, groupAwareCallTool, groupLedger, groupPrompt, settingsChanged, taggedLine } from "../groupTurn.js";
import { consentFor } from "../commandTools.js";
import { gatewayGraph } from "../graph/gatewayGraph.js";
import { guestNameTool } from "../groupGuestNames.js";
import { holdersTool } from "../groupHolders.js";
import { computerTools } from "../../../../../apps/mcp/src/machines/texActions.js";
import { settingsSnapshot, settingsTools } from "../settingsTools.js";
import { heldShareTool } from "../heldShare.js";
import { personalTexTool } from "../askPersonalTex.js";
import { ASK_CHAT, crossChatGroupPrompt, crossAskTool, crossCountsOf, postInChatTool } from "../crossChat.js";
import { eitherEnds, tapbackEnding } from "../tapbackEnding.js";
import { texComputerTool } from "../texComputerSandbox.js";
import { browserOwner, groupBrowserOwner } from "../browserProviders.js";

/** A group turn's ask of the tagger's personal Tex (`askPersonalTex.js`), when it has one. */
const personalTex = (tool) => (tool === null ? [] : [tool]);
import { withKeptFiles } from "../keptFiles.js";
import { learnedSkillsLine, withLearnedSkills } from "../learnedSkills.js";
import { setupPromptFor, turnKind } from "../promptModules.js";
import { ledgerObserver, loggedCheck, stepEntry, stepLog } from "../ledger.js";
import { collectReads } from "../toldFacts.js";
import { markRead, readBackTool, readsNote, readsOf } from "../readsIndex.js";
import { carryKey } from "../stretch.js";
import { meterEach, meterParts } from "../modelPlan.js";
import { sentNoteLinksLine, withNoteLinks } from "../noteLinks.js";
import { withDrawnImages, withPictureMaker } from "../pictureMaker.js";
import { turnEfforts } from "../production.js";
import { withLive } from "../liveSteps.js";
import { LONG_MAX_ROUNDS, LONG_TOOL_BUDGET_MS } from "../progress.js";
import { askedWith, loggedQuestion, reactedLine } from "../quoted.js";
import { HANDED_BACK_QUESTION } from "../handback.js";
import { withSameAsk } from "../sameAsk.js";
import { withSkills } from "../skills.js";
import { withMailAgent } from "../supervise.js";
import { allowedFirst } from "../texTiming.js";
import { paidLine } from "../textedPay.js";
import { PLAN_DEFINITION, PLAN_HINT, planCall, splitFirst } from "../planBigAsk.js";
import { computersLine, delegationBeside } from "../../../../../apps/mcp/src/machines/forTurn.js";
import { setAsideLine } from "../textedSettle.js";
import { cancelledTurn } from "../textingRoutes.js";
import { textingAwareCallTool } from "../textingWrites.js";
import { saidBefore, withTheirNotesKept } from "../theirNotes.js";
import { ownWorkspaceName, withWorkspaceConventions } from "../workspaceConventions.js";
import { threadPrompt } from "../threadView.js";
import { sleepLineNote } from "../timeLog.js";
import { agentTools, runTurn } from "../turn.js";
import { examplesOptions } from "../turnExamples.js";
import { chatHubUrl, hubPrompt } from "../hubLinks.js";
import { VAULT_SAVED_QUESTION, withGroupVault, withVaultWatch } from "../vaultSaved.js";
import { privateAsideTool, withPrivateLinks } from "../privateAside.js";
import { doItChecks } from "../doItChecks.js";
import { replyJudge } from "../replyJudge.js";
import { threadsSortAndWrite } from "../conversationThreads.js";
import { withArchitecture } from "../texArchitecture.js";
import { withChatWriteLock } from "../chatWriteLock.js";
import { carriedLine, carriedRounds, rereadCarried } from "../turnResume.js";
import { loggedRoute, routeActs, routeIfBack, runWithDoors } from "../doorTurn.js";
import { toolRulesNode, toolRulesOn } from "../graph/nodes/toolRules.js";

/** The settings this turn runs the front door with, as the Front door node logs them (`../graph/nodes/fd.js`). */
function doorOut({ production, productionModel, fallback, router, gated, advising, planning, computers, skills, delegation, threaded }) {
  return {
    model: productionModel ?? null,
    effort: productionModel ? (production?.efforts?.[productionModel] ?? null) : null,
    fallback: typeof fallback === "string" ? fallback : (fallback?.model ?? null),
    router: router ? true : false,
    reviewer: gated ? "on" : "off",
    advisor: advising ? (production?.advisor ?? "on") : "off",
    planner: planning ? "on" : "off",
    computers: Array.isArray(computers) ? computers.length : 0,
    skills: Array.isArray(skills) ? skills.length : undefined,
    delegation: delegation ? true : false,
    threads: threaded ? true : false,
  };
}

/** The setup's rules with the drawing ahead, the box named for this kind of turn (`texArchitecture.js`). */
const setupWithMap = (prompt, kind) => (typeof prompt === "string" && prompt !== "" ? withArchitecture(prompt, kind) : prompt);

/** The reviewer's two halves, or the code checks alone with no reviewer (`replyJudge.js`); null when a turn has neither. */
/** A Tool rules switch (`texNodeSettings.cjs` `toolRules`): the rule's wrapper when it is on, the call as it is when off. */
const ruled = (on, wrap) => (callTool, ...options) => (on === true ? wrap(callTool, ...options) : callTool);

function answerChecksFor({ judge, doIt, claims, tries, chatLog, ledgerAt, stands = null }) {
  return withStands(stands, checksOf({ judge, doIt, claims, tries, chatLog, ledgerAt }));
}

function checksOf({ judge, doIt, claims, tries, chatLog, ledgerAt }) {
  if (judge !== null) return { code: judge.codeCheck, review: judge.review };
  const codeChecks = doIt ?? claims ?? tries;
  const plainCheck = doIt === null && claims !== null ? loggedCheck(chatLog, ledgerAt ?? {}, "handback", claims) : typeof codeChecks?.check === "function" ? (answer, context) => codeChecks.check(answer, context) : null;
  if (plainCheck === null) return null;
  return { code: async (answer, context) => ({ notice: (await plainCheck(answer, context)) ?? null, review: false }), review: null };
}

/**
 * The stands gate first, then the turn's own checks (2026-11-19: #3769's check ran only on the console's front door and
 * only through `untriedWeb.js`, so a texted, group, job, `doIt` or reviewed turn never saw it). Composed, never replacing.
 */
export function withStands(stands, checks) {
  if (stands === null) return checks;
  return {
    code: async (answer, context) => {
      const notice = stands.check(answer, context);
      if (notice !== null) return { notice, review: false };
      return checks === null ? { notice: null, review: false } : checks.code(answer, context);
    },
    review: checks?.review ?? null,
  };
}

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function runTheModel(t, via) {
  const { allowedBeside = false, allowedRead, attachments, background, begun, body, channel, chatLog, chatTurn, claims, computersRead, mailRead = null, groupsRead = null, controlPlane, keptReads = null, delegation: delegated, dispatch, dropped, earlier, env, fallback, forwarding, group, groupWriting, history, home, inThread, job, knowsRead, learned, ledger, ledgerAt, logTurn, logged, cardCheck, maker, meter, noteLinking, offered, opened, outcome, outgoing, paid, production, productionModel, question, quoted, reacted, refused, report, router, routine, runner, seenWeb, session, setAside, shown, skills, stages, steer, step, store, streamed, supervision, tex, texted, texting, textingWriting, threadsRun, timeZone, view = null, week = null } = t;
  // What this chat has read before, under this turn's own carry key: listed in the per-text block, opened with read_back (`readsIndex.js`).
  const reads = keptReads === null ? null : readsOf(keptReads.entries, { grant: carryKey(session), before: logged?.parts?.since ?? null, notes: group === null });
  // When the setup's reply reviewer reads a draft, it replaces the older word checks (`untriedWeb.js`, `doItChecks.js`); a draft it does not read (one written with no action, `replyJudge.js`) gets them instead.
  // A routine's run that texts is reviewed too, as a text nobody asked for (Dev2, 2026-11-07: a routine texted its own reasoning); one that writes only a note is not a text.
  // Only a text to the person is reviewed (Dev2, 2026-11-07): a routine that texts other people (`to:`) is theirs, not reviewed.
  const scheduled = runner && routine?.settings?.send !== "note" && !(Array.isArray(routine?.settings?.to) && routine.settings.to.length > 0) ? "routine" : null;
  // Only a job's report and a scheduled text are reviewed (Dev2, 2026-11-15): on every other chat turn the code checks run alone, the figure check over what the model saw among them (`untriedWeb.js`).
  const gated = ((chatTurn && job === null && !runner && (texted || group !== null) && report !== null) || scheduled !== null) && Boolean(production?.replyJudge) && aiGatewayConfig(env) !== null; // no AI Gateway, no reviewer: the word checks stay
  const tries = t.tries;
  // Tool rules' switches, shown and changed in the Lab (`texNodeSettings.cjs`); the step turned off or unwired turns them all off.
  const toolRules = toolRulesOn(texConfigOf(env)) ? settingsOf(env, "toolRules") : Object.fromEntries(Object.keys(settingsOf(env, "toolRules")).map((rule) => [rule, false]));
  if (!tex.lean) await tex.wait("steer_begin", begun);
  const knows = knowsRead === null ? null : await tex.wait("tex_notes", knowsRead);
  // A big ask the advisor plans and the gateway splits into jobs, when the setup says so (`planBigAsk.js`).
  // The plan call is offered only while the config wires the Big-ask planner and its jobs (`planner -> jobStart`; retired off main, 2026-11-20): never a call nothing answers.
  const planning = background !== null && job === null && !routine && production?.planBigAsks === true && productionModel !== null && canRunBuiltin(production.advisor, env) && texConfigOf(env).edges.some((e) => e.from === "fd" && e.to === "planner") && texConfigOf(env).edges.some((e) => e.from === "planner" && e.to === "jobStart");
  // Their computers, told to the turn, and code no longer delegated to the web while one is paired (`machines/forTurn.js`).
  const computers = computersRead === null || computersRead === undefined ? [] : await tex.wait("computers", computersRead);
  const delegation = delegationBeside(delegated, computers);
  const mail = mailRead === null ? null : await tex.wait("mail_accounts", mailRead); // their mailboxes (`mailAccounts.js`)
  // The group chats they are in, and the read-only tool that searches and reads them (`groupChats.js`).
  t.groups = groupsRead === null ? null : await tex.wait("my_groups", groupsRead); // `[{ key, name, people, lastSeenAt }]`, also read by the cross-chat ask
  const groupChats = t.groups === null || !groupsOn(env) ? null : groupChatsForTurn({ env, groups: t.groups, timeZone, onRead: () => markUntrusted(ledger) });
  // A read offered back instead of done, and an advisor they asked for and nobody asked, go back once, on the front door too, without judges (`doItChecks.js`).
  // The Shape gate's read of this text, started beside the door (`graph/nodes/doorStep.js`); null with no gate, or one that was not sure (`shapeGate.js`).
  const shape = t.shapeRead ? await tex.wait("shape_gate", t.shapeRead) : null;
  const doIt = chatTurn && job === null && !runner && (texted || group !== null) ? doItChecks({ question, inner: claims ?? tries, shape, tagged: group?.tagged === true }) : null;
  // The setup's reply reviewer, after `claimCheck.js`: one Haiku call reads the reply against every action this turn took and the kind of turn it is, and sends it back with feedback only for a problem they would notice, at most once (five times for a task or a job's report, the advisor brought in from the third), and only on a draft written after an action (`replyJudge.js`; Dev2, 2026-11-06 and 2026-11-11). A job's report turn shows it the report.
  const askedNow = (logged ? loggedQuestion(logged.question, quoted, logged.replying) : askedWith(question, quoted)); // what the reviewers read as their text
  // The advisor, when the setup names one this deployment can run: offered on every chat turn, a job's included (`advisor.js`).
  const advising = chatTurn && productionModel !== null && Boolean(production.advisor) && canRunBuiltin(production.advisor, env);
  const judge = gated ? replyJudge({ setting: production.replyJudge, config: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "reviewer" }, report, scheduled, timeZone, question: askedNow, history: logged?.history ?? shown, inner: claims, plain: doIt ?? claims ?? tries, advisor: advising }) : null;
  // What the Answer checks and Reply reviewer nodes run on each draft (`../graph/nodes/checks.js`, `reviewer.js`): the reviewer's two halves, or the code checks alone.
  // A job's claim check is still the Hand-back judge's own step in the ledger (`loggedCheck`) until the job's nodes move onto the runner.
  // The stands gate (`standsCheck.js`): on every chat turn, whatever door and checker it runs, and fail-closed on the answer the turn returns.
  const stands = runner ? null : standsGate({ question: askedNow });
  t.answerChecks = answerChecksFor({ judge, doIt, claims, tries, chatLog, ledgerAt, stands });
  t.reviewedAs = judge === null ? null : report !== null ? "report" : "routine"; // the tag the wire to the Reply reviewer fires on (`texConfig.json`: Answer checks to reviewer, when report or routine)
  // A progress line goes unreviewed (Dev2, 2026-11-11, one-judge PR 3): it says what Tex is doing, and a review held each one up to 8 s.
  if (planning) background.plan = via.planner(planCall({ model: production.advisor, effort: production.efforts?.[production.advisor], history: shown, question, background, meter, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "advisor" } }) }));
  if (planning) splitFirst(background); // a lone job is offered the planner once
  // The chat by conversation: the thread list as it stood after the text before, then the last 24 hours (`threadedTurn.js`), in 1:1 and in groups.
  // The new text is sorted only after the answer has gone, and its verdict kept for the next turn (Dev2, 2026-11-12: "Never wait for it").
  const threaded = threadsRun ? await tex.wait("threads", threadsRun) : null;
  t.threadsSort = threaded?.sort ? (answer = "") => threadsSortAndWrite(threaded.sort, store, session, answer) : null; // the Classifier node files the text after the reply (`../graph/nodes/classifier.js`), on Text them's background wire
  // What this turn runs the front door with, every setting that shapes it, logged as the Front door node's (Dev2, 2026-11-14: "every single block should have proper logging of what's going in and out and what parameters were set").
  t.settings = doorOut({ production, productionModel, fallback, router, gated, advising, planning, computers, skills, delegation, threaded });
  // Every judge call in a texted chat says which chat "here" is and what Tex last offered (`consentContext.js`, Dev2 2026-11-22).
  const judgeChat = consentContext({ group, history: logged?.history ?? shown, chatTurn: chatTurn && job === null && !routine, config: texConfigOf(env) });
  const egressJudge = aiGatewayConfig(env) === null ? null : (input) => gatewayGraph({ env, writer: chatLog, turn: ledgerAt?.turn ?? null }).fire("tools", "egress", { ...input, ...judgeChat }, { env }); // interim: io.use.egress once tools is a node
  if (typeof session.sharingJudge === "function" && egressJudge) session.sharingJudge = egressJudge; // interim: io.use.egress once tools is a node
  // The move judge, where the config wires tools -> moveJudge (`graph/nodes/moveJudge.js`); without the wire, the word list.
  const drawn = gatewayGraph({ env, writer: chatLog, turn: ledgerAt?.turn ?? null, config: texConfigOf(env) });
  // The Front door's start_background_job starts a job only over its own wire, `fd -> jobStart` (`../background.js`
  // `withBackground`; `scripts/tex-wire-check.mjs`).
  if (background) background.startOn = drawn.wired("fd", "jobStart");
  // Tex asks Tex across chats (`crossChat.js`), once a config wires the Cross-chat gate: it replaces ask_personal_tex in a group.
  const crossWired = chatTurn && job === null && !routine && drawn.wired("tools", "crossChatGate");
  // A group chat turn's sensitive asks go to the tagger's own chat, never the group (`privateAside.js`; Dev2, 2026-11-25).
  const asideGroup = chatTurn && job === null && group !== null && t.crossChat?.kind !== "ask" ? group : null;
  const asideTool = privateAsideTool({ group: asideGroup, ledger });
  // What a group turn reads from a workspace someone here can't open, for the Room check before it goes (`roomCheck.js`);
  // a job's report brings what its job read there, its words as what was read.
  t.roomReads = group !== null ? roomReads(group) : null;
  if (t.roomReads !== null && report !== null && Array.isArray(report.roomRead)) t.roomReads.add(report.roomRead, report.texts);
  // A group's progress line is read by the Room check before it goes, when the config wires it (`graph/nodes/roomCheck.js`).
  if (t.roomReads !== null && typeof via?.roomCheck === "function" && typeof channel?.holdWith === "function") channel.holdWith(async (text) => {
    t.roomProgress = text;
    const out = await tex.step("room_check_progress", () => via.roomCheck({ at: "progress", draftChars: text.length }), null).catch(() => null);
    return out?.to === "hold" ? t.roomNotice : null;
  });
  const crossTools = crossWired ? [crossAskTool({ event: t.crossChat ?? null, group, groups: t.groups ?? null, counts: crossCountsOf(body.crossCounts), ledger, gate: (input) => drawn.fire("tools", "crossChatGate", input, { env }), identity: typeof controlPlane?.askerIdentity === "function" ? () => controlPlane.askerIdentity(session.accessToken) : null }), postInChatTool({ event: t.crossChat ?? null, group, ledger })].filter(Boolean) : [];
  // The group's prompt says to ask a person's own Tex only when ask_chat is offered: a chat with guests has none
  // (`crossAskTool`), and telling it to ask got "ask_chat isn't available on this turn" (Tex Devs, 2026-11-24).
  const canAskChat = crossTools.some((entry) => entry?.tool?.name === ASK_CHAT);
  // A tapback as the whole answer (`tapbackEnding.js`), once a config wires the Tapback node: a chat turn of the front door only,
  // answering a text of theirs the Worker can react to. Never on their own tapback (the Worker never taps a tapback:
  // `groupModelTurn.ts`, `inbox.ts` `acknowledgeText`), nor on a turn the gateway asked (a vault save, a hand-back).
  const reactable = !quoted?.tapback && question !== VAULT_SAVED_QUESTION && question !== HANDED_BACK_QUESTION;
  const tapping = chatTurn && reactable && job === null && !routine && report === null && !t.crossChat && drawn.wired("tools", "tapback") ? tapbackEnding({ gate: (input) => drawn.fire("tools", "tapback", input, { env }), tagged: group?.tagged === true, stickers: settingsOf(env, "tapback").stickers === true }) : null;
  // Tex's own computer (`../texComputerSandbox.js`), once a config wires the Tex's computer node: a background job's turn
  // only, on a deployment with the TEX_COMPUTER binding. One per person, one per group chat, by the same tag as the browser.
  // Tex's own computer is wired by the config (`tools -> computer`); a texted turn is told so (`forTurn.js` `computersLine`).
  const ownComputerWired = Boolean(env?.TEX_COMPUTER) && drawn.wired("tools", "computer");
  const computerOwner = job !== null && !routine && ownComputerWired ? await tex.step("computer_owner", () => (group ? groupBrowserOwner(env, group) : browserOwner(env, session.actorUserId)).catch(() => null)) : null;
  const ownComputer = computerOwner ? texComputerTool({ gate: (input) => drawn.fire("tools", "computer", input, { env }), owner: computerOwner }) : null;
  // A job the front door can't finish in its turn goes to a background worker, when the config wires the Hand-off node (`../handoff.js`):
  // from a draft the Answer check would send back with no send-back left (`answerCheck -> handoff`), and from a turn two
  // rounds from its bound and still gathering (`fd -> handoff`). Neither wired, nothing changes.
  // The Hand-off node starts a job only over its own wire, `handoff -> jobStart`: unwired, nothing is handed off.
  const handoffJobs = drawn.wired("handoff", "jobStart");
  const handoffFrom = chatTurn && job === null && !routine && report === null && Boolean(background) && handoffJobs ? ["answerCheck", "fd", "router"].filter((from) => drawn.wired(from, "handoff")) : [];
  const handOff = handoffFrom.length > 0 ? handoffHook({ background, gate: (input, from) => drawn.fire(from, "handoff", input, { env }), ask: question }) : null;
  t.handoff = handOff !== null && handoffFrom.includes("answerCheck") ? (draft, info, notice) => handOff(draft, info, notice, "answerCheck") : null;
  const roundsOut = handOff !== null && handoffFrom.includes("fd") ? ({ messages, lastWords }) => handOff(lastWords, { messages }, "", "fd") : null;
  // The lookup ladder (`../lookupLadder.js`), when the config wires `answerCheck -> askGate`: a draft that asks them a fact
  // Tex could find climbs the cheap rungs first, and the slow ones go to a job when the config wires `askGate -> handoff`.
  t.ladderOn = chatTurn && job === null && !routine && report === null && !t.crossChat && drawn.wired("answerCheck", "askGate");
  const ladderHook = t.ladderOn && Boolean(background) && handoffJobs && drawn.wired("askGate", "handoff") ? handoffHook({ background, gate: (input) => drawn.fire("askGate", "handoff", input, { env }), ask: question }) : null;
  t.ladderHandOff = ladderHook !== null ? (draft, info, notice) => ladderHook(draft, info, notice, "askGate") : null;
  // A job the router reads as long goes to the Hand-off node before any round, when the config wires `router -> handoff` (`doorTurn.js`).
  const routeHandOff = handOff !== null && handoffFrom.includes("router") ? () => handOff("", { messages: [] }, "", "router") : null;
  // The bar a job pick must clear, when the Hand-off node sets its own (`handoff.js` `routeSureOf`); none, the doors' 0.6.
  const jobAt = routeHandOff !== null ? routeSureOf(texConfigOf(env)) : null;
  // The specialist doors' own prompts, when the setup gives them (`texConfig.js` `texModules`); none, the front door's notes.
  const doorNotes = (door) => (typeof production?.prompts?.[`door-${door}`] === "string" ? { prompt: setupWithMap(production.prompts[`door-${door}`], turnKind({ group, job })) } : null);
  const keptOptions = { question, on: !runner, ...(aiGatewayConfig(env) !== null && drawn.wired("tools", "moveJudge") ? { judge: (input) => drawn.fire("tools", "moveJudge", input, { env }), said: saidBefore(history) } : {}) };
  const pictureRun = (name, args, callTool) => gatewayGraph({ env, writer: chatLog, turn: ledgerAt?.turn ?? null }).fire("tools", "picture", { tool: name, args }, { env, maker, callTool, cardCheck }).then((out) => out.result); // interim: io.use.picture once tools is a node
  steer?.revertWith(dispatch); // a provisional run's note saves are read first and put back through the client's own dispatcher (`steer.js`)
  // An earlier try of this same text, or a job's part cut off before it answered, carried on from what it had done (`savedRounds.js`); a routine's run has no text.
  // The slow modules' words for the day, when the step freezes them until the next summary (`frozenModules.js`).
  const freezeStep = job === null ? "fd" : "job";
  const freeze = (job !== null || chatTurn) && texFreeze(freezeStep, texConfigOf(env)) === "summary" ? await tex.step("frozen_modules", () => frozenModules({ store, session, step: freezeStep, freeze: "summary", timeZone }).catch(() => null)) : null;
  const rounds = !runner && (job !== null || chatTurn) ? await tex.step("carried_rounds", () => carriedRounds({ store, session, body, question, job, egress: ledger }).catch(() => null)) : null;
  t.rounds = rounds; // its snapshot goes once the reply is made (`sendTheReply.js`)
  stages?.ready();
  // The router's read, awaited only by a turn that may use a door (`doorTurn.js`); its wait is logged. A text's read was started beside the Door.
  const eligible = chatTurn === true && job === null && report === null && !t.crossChat && (rounds?.from ?? null) === null;
  // Only while something acts on the read (a door wired, or router -> handoff); else it is logged after the turn, never waited on.
  const acts = routeActs((from, to) => drawn.wired(from, to), handoffFrom.includes("router"));
  const waitStart = eligible && acts && t.routeRead ? Date.now() : null;
  const routed = eligible && acts && t.routeRead ? await tex.wait("route", t.routeRead) : null;
  const waitedMs = waitStart === null ? null : Date.now() - waitStart;
  // What the Context app had open when they texted it from its chat (`screen.js`): a 1:1 app turn, when the front door's ctx lists `screen`.
  const screen = screenOn(env) && chatTurn && job === null && group === null && !runner && session.actorClientId === CONSOLE_CLIENT_ID && typeof session.actorUserId === "string"
    ? await tex.step("screen", () => screenForTurn({ env, actorUserId: session.actorUserId, contexts: contextsFor(session), dispatch, ownId: session.workspaceId, now: Date.now() }).catch(() => null), null)
    : null;
  // The member cards of the people here, read by the Member cards node beside the door (`memberCards.js`); its words are on the turn, never the wire.
  if (via.memberCards) await tex.wait("member_cards", via.memberCards);
  const cards = via.memberCards ? cardsPrompt(t.memberCards) : "";
  // How this chat's people text, counted by the Chat style node beside the door (`chatStyle.js`): data in the per-text facts.
  if (via.chatStyle) await tex.wait("chat_style", via.chatStyle);
  const style = via.chatStyle ? styleFacts(t.chatStyle ?? null) : "";
  const args = {
    ...examplesOptions(via.examples ?? null, texConfigOf(env), TRAINING, env?.TEX_EXAMPLES), // the nearest Training examples, when the front door is wired to them (`turnExamples.js`)
    resumeFrom: rounds?.from ?? null, keepRounds: rounds?.keep ? { keep: rounds.keep, marks: rounds.marks } : null,
    // With the log, the chat and its tapbacks are in the transcript, and the covered events are the question (`loggedTurn.js`).
    question: [logged === null && view === null ? chatLines(group) : "", logged === null ? reactedLine(reacted) : "", setAsideLine(setAside, dropped), paidLine(paid), sentNoteLinksLine(question, noteLinking.origin), logged?.left ?? "", (logged ? loggedQuestion(logged.question, quoted, logged.replying) : askedWith(question, quoted)), logged === null ? sleepLineNote(question) : ""].filter(Boolean).join("\n\n"),
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
    answerCheck: t.answerChecks === null ? null : withJobDrafts(job, step, via.answerCheck), silences: judge?.silences ?? null,endsTurn: eitherEnds(background?.endsTurn ?? null, tapping?.endsTurn ?? null), sayNothing: job === null, mustAnswer: group?.tagged === true, scheduled: runner === true, roundNote: background?.roundNote ?? null, // a job's start answers at once (`background.js`); a routine's run may say nothing too, as its prompt tells it (`routine.js`; 2026-11-07: offered none, it texted why)
    // Each draft is checked by the nodes the config wires after the front door (`../graph/draftBridge.js`): Answer checks, then the Reply reviewer.
    // A job's turn streams each draft first, so a part that dies in its checks hands it on (`jobSaved.js`).
    // A group turn's changing calls take the chat's write lock, one at a time across its turns side by side (`chatWriteLock.js`).
    callTool: via.tools(allowedFirst(allowedBeside ? allowedRead : null, withChatWriteLock({ env, group, steps: chatLog === null ? null : stepLog(chatLog, ledgerAt ?? {}) }, (steer?.track ?? ((call) => call))(withPrivateLinks(asideGroup, ledger, withVaultWatch(ledger, withGroupVault(group, (stands?.wrap ?? ((call) => call))((claims?.wrap ?? tries?.wrap ?? ((call) => call))(withSameAsk({ on: claims !== null && toolRules.sameAsk === true, store, session, ledger, history, question }, withBackground(background, outgoing.wrap(
      withPictureMaker(maker, withDrawnImages(outgoing, withAttachmentImages(
        attachments,
        withEmailFiles({ store, attachments }, withKeptFiles(store, () => markUntrusted(ledger), withMailAgent(supervision?.mail ?? null, withDelegate(delegation, withChatSkills(group, learned, withLearnedSkills(group !== null ? null : learned, withSkills(skills, withWorkspaceConventions(ruled(toolRules.noteLinks, withNoteLinks)(ruled(toolRules.folderFit, withFolderFit)(group !== null ? (t.roomReads?.wrap ?? ((call) => call))(groupAwareCallTool(withTheirNotesKept(dispatch, keptOptions), groupWriting, { store, group })) : textingAwareCallTool(withTheirNotesKept(dispatch, keptOptions), textingWriting, { timeZone })), noteLinking), { own: ownWorkspaceName(noteLinking.contexts) })), { tainted: () => ledger.untrusted === true, dispatch }), { outside: () => ledger.outside === true }))))),
      )), pictureRun),
    )))))))))))),
    pictures: texted || group !== null,
    attachments,
    env,
    providerOptions: {
      ai: env.AI,
      gateway: aiGatewayConfig(env),
      // With node `warm` wired, the first round's request is kept, cut at the history, to warm the cache before their next text (`warmPrefix.js`).
      ...(chatTurn && job === null && warmWired(texConfigOf(env)) ? { onSent: prefixKeeper({ store, session, timeZone }) ?? undefined } : {}),
      // Ids only: what the AI costs tab files this call's spend under.
      metadata: {
        feature: "assistant",
        workspace: String(session.workspaceId),
        client: group !== null ? "texts-group" : texting ? "texts" : "app",
        // The setup that answered, when one did: which note a cost is for.
        ...(production !== null ? { setup: production.version } : {}),
      },
    },
    web: via.web(steer?.trackWeb((claims ?? tries)?.wrapWeb(seenWeb) ?? seenWeb) ?? (claims ?? tries)?.wrapWeb(seenWeb) ?? seenWeb), // whether the web was tried before "I couldn't open it" (`claimCheck.js`)
    history: threaded?.history ? [...threaded.history, ...(logged?.carried ?? [])] : logged?.history ?? shown, // the stretch's turns after it (`stretch.js`)
    // Per text, so said in their turn after the cached prefix (`turnPrompt.js`): who tagged it, the thread, the jobs running now, whether their computers are online, and a job's per-part lines and a report (both changed nearly every text above the history: cache audit, 2026-11-20).
    turnNote: [group !== null ? taggedLine(group) : "", job === null ? underNote(logged?.covered, { group: group !== null, speaker }) : "", shapeNote(shape), threaded?.note ?? "", threaded?.timeNote ?? "", threadPrompt(logged ? { thread: null } : inThread), readsNote(reads?.listed ?? []), background?.runningNow ?? "", job === null ? computersLine(computers, { planning, own: ownComputerWired }) : "", jobPartPrompt(job), carriedLine(rounds?.from), jobReportPrompt(report), screenNote(screen ?? {}), style].map((part) => part.trim()).filter(Boolean).join("\n\n"),
    // In parts, so the prompt's manifest names which one changed between two texts (a cache miss, 2026-11-14); sent as one block.
    threadNote: [["group", group !== null ? (canAskChat ? crossChatGroupPrompt(groupPrompt(group, home)) : groupPrompt(group, home)) : ""], [CARDS_PART, cards], ["cross", t.crossPrompt ?? ""], ["learned", learnedSkillsLine(learned)], ["background", background?.prompt ?? ""], ["plan", planning ? PLAN_HINT : ""], ["hub", chatTurn && job === null ? hubPrompt(chatHubUrl(env, session, group), { group: group !== null }) : ""], ["job", jobBriefPrompt(job)], ["jobAdvisor", jobAdvisorLine(job, advising)], ["instructions", chatTurn ? instructionsPrompt(readInstructions(body.instructions)) : ""]], steer,
    routeLocal: via.local, // say_nothing, which the loop adds itself, over the same `fd -> tools` wire (`turn.js`)
    local: via.local((doIt?.wrapLocal ?? ((local) => local))([...earlier, ...(groupChats ? [groupChats.tool] : []), ...(reads !== null ? [readBackTool({ reads: reads.all, open: keptReads.open, reread: dispatch, onRead: (read) => markRead(ledger, read) })] : []), ...(threaded?.read_thread ? [threaded.read_thread] : []), ...(threaded?.read_day ? [threaded.read_day] : week?.read_day ? [week.read_day] : []), ...(t.chatSearch ? [t.chatSearch] : []), ...(chatTurn && job === null && !routine ? commandTools({ run: (command) => settingsChanged(env, controlPlane.texCommand(session.accessToken, command), command, group ? { chat: group.key } : { person: session.workspaceId }), group, consent: consentFor(question, egressJudge, { offered: judgeChat.offered ?? "" }), snapshot: () => settingsSnapshot({ session, controlPlane, group, dispatch }), onMute: () => void (ledger.chatMuted = true) }) : []), ...(chatTurn && job === null && !routine ? computerTools({ env, session, controlPlane, group, words: question, offered: judgeChat.offered ?? "", judge: egressJudge }) : []), ...(chatTurn && job === null && !routine ? settingsTools({ session, controlPlane, group, dispatch, words: question, offered: judgeChat.offered ?? "", judge: egressJudge, onInvite: (invite) => void (ledger.chatInvite = invite) }) : []), ...personalTex(chatTurn && job === null && !routine ? heldShareTool({ session, controlPlane, group, groups: t.groups ?? null, words: question, offered: judgeChat.offered ?? "", judge: egressJudge }) : null), ...crossTools, ...(asideTool ? [asideTool] : []), ...(tapping ? [tapping.local] : []), ...(ownComputer ? [ownComputer] : []), ...personalTex(chatTurn && job === null && !routine && !crossWired ? personalTexTool({ group, ledger, asker: typeof controlPlane?.askerIdentity === "function" ? () => controlPlane.askerIdentity(session.accessToken) : null }) : null), ...personalTex(chatTurn && job === null && !routine && group !== null ? guestNameTool({ group, ledger: groupLedger(store, group) }) : null), ...personalTex(chatTurn && job === null && !routine && group !== null ? holdersTool({ group, holders: typeof controlPlane?.workspaceHolders === "function" ? (workspace) => controlPlane.workspaceHolders(session.accessToken, workspace) : null }) : null), ...(advising ? advisorTools({ model: production.advisor, effort: production.efforts?.[production.advisor], history: shown, question, request: advisorRequest({ ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "advisor" } }), meter, config: texConfigOf(env) }) : [])])), // the advisor, when the setup names one (`advisor.js`); watched for whether they asked for it (`doItChecks.js`)
    // What Tex keeps about them and its open jobs, in their own workspace (`aboutMe.js`, `jobs.js`), on a texted turn,
    ...(knows === null ? {} : outgoing.knows(knows)), // and who they are by their account (`identity.js`); where they live starts a places card's distances (`visuals/distance.js`)
    localNow: { now: Date.now(), timeZone },
    observe: withLive(t.live, body?.live === true && job === null, chatLog === null ? withJobSteps(job, step, null, () => ledger.untrusted === true) : collectReads((t.reads = rereadCarried(rounds?.from ?? null, claims)), ledgerObserver(chatLog, withJobSteps(job, step, null, () => ledger.untrusted === true), ledgerAt))), // and, for an ask that asked (the app chat), each step to its run card (`liveSteps.js`) // a job's steps also go to its chat (`background.js`), and every step to the chat's ledger; what it read, for the facts its reply keeps (`toldFacts.js`)
    workspaces: contextsFor(session), // Where a new note goes (`workspaces.js`).
    groups: groupChats?.prompt ?? "", // the group chats they are in (`groupChats.js`)
    devShare: group !== null && devShareOn(env) ? devSharePrompt(group.devShare) : "", // whether the developers can read this chat (`devShare.js`)
    mail, // the mailboxes a mail search reaches, and any not fine (`mailAccounts.js`)
    texting: texting || group !== null, // a group's answer is a text too, written for one
    inGroup: group !== null, // never told the 1:1's own record, check-ins and pings (`turnPrompt.js`)
    notes: production !== null ? { prompt: setupWithMap(setupPromptFor(production, turnKind({ group, job })), turnKind({ group, job })) } : null, // a 1:1 text, a group or a job: each its own modules (`promptModules.js`)
    builtinModelOverride: productionModel ?? undefined,
    router,
    cacheTtl: texCacheTtl(job === null ? "fd" : "job", texConfigOf(env)), // the prefix cache's life, the step's own in Tex's config
    freeze, // the slow modules frozen for the day (`frozenModules.js`), or null: read each turn
    // Every tool its kind of chat has, the same bytes each turn (`sixToolsFixed.js`). Texts and group chats only: an app
    // or another client's agent is shown what its own grant holds, as before.
    fixedTools: (texting || group !== null) && texToolList(job === null ? "fd" : "job", texConfigOf(env)) === "fixed" ? (group ? "group" : "one") : null,
    efforts: turnEfforts(production, job), // a job's turn thinks as `models.job_effort` says (`production.js`)
    fallback: via.fallback(fallback),
    maxRounds: production?.maxSteps ?? undefined,
    roundsOut, // out of rounds with the job not done: the Hand-off node, when the config wires `fd -> handoff`
    // A browser call can open a page and settle it (`infra/site-shots`
    // budgets 17 s); the default would cut a slow one short and lose it. A captcha on the page
    // adds Browserbase's 30 s solver wait, then a reload and a fresh browser (`captchaLadder.js`):
    // at 30 s the ladder never finished, and Tex handed an Instacart picture check over (2026-10-24).
    // A card's boxes are filled one browser call each, after the person's yes (`fillCard.js`).
    // An email or calendar change is checked by the control plane and the Mail checker before it is held (2026-10-22: three "timed out" for one email;
    // the owner: "at least 2 minutes … it's a crucial thing"). A quick group turn cuts it to its own end (`turn.js`).
    // The advisor (Opus, thinking) answers in 20 to 38 s: its own limit, longer in a job (`advisor.js`, 2026-11-12).
    toolTimeouts: { open_page: OPEN_PAGE_TIMEOUT_MS, browse: 160_000, fill_login: 30_000, make_login: 30_000, fill_card: 60_000, draw_picture: 40_000, draw_visual: 75_000, make_picture: 70_000, send_email: 120_000, save_email_draft: 120_000, calendar_event: 40_000, slack_api: 40_000, google_chat: 40_000, [ADVISOR_TOOL]: advisorTimeoutMs(job !== null, texConfigOf(env)) },
    // A background job is long whether or not it streams (`background.js`).
    // So is a data file to work through: Opus plans it, so a breakdown isn't guessed on the everyday model (2026-10-24).
    planned: job !== null || carriesData(attachments), ...(streamed || job !== null ? { ...(channel?.offered ? { progress: channel } : {}), roundCap: LONG_MAX_ROUNDS, toolBudgetMs: LONG_TOOL_BUDGET_MS } : {}),
  };
  // The front door's turn, or the specialist door the router picked first (`doorTurn.js`): its runTurn is this one, with the door's tools.
  const turn = await tex.step("model", () => runWithDoors({ runTurn, args, eligible, route: routed, waitedMs, via, handOffRoute: routeHandOff, doorNotes, jobAt }));
  if (typeof freeze?.keep === "function") await tex.after("frozen_keep", () => freeze.keep()); // the day's words, once the model answered (`frozenModules.js`)
  if (eligible && !acts && t.routeRead) loggedRoute(turn, await tex.step("route_logged", () => routeIfBack(t.routeRead)));
  const notAllowed = allowedBeside ? await tex.wait("allowed", allowedRead).then(() => null, (thrown) => thrown) : null; // beside the model, its no ends the turn here: no tool ran (`allowedFirst`), nothing is kept or sent
  if (notAllowed !== null) return (opened !== null && tex.after("browser_close", () => opened.close()), steer !== null && tex.after("steer_clear", () => begun.catch(() => {}).then(() => steer.clear())), await tex.step("refused", () => refused(notAllowed)));
  // The question's browser is not left running, unless held while the answer waits on them (`browserHold.js`).
  if (opened !== null) await tex.after("browser_close", () => opened.close(turn.exhausted ? {} : { answer: turn.answer, vaultLink: ledger.vaultLink }));
  await tex.after("usage", () => meterEach(turn, meter)); // one report per model it ran on, at its own price (`modelPlan.js`)
  await tex.after("turn_row", logTurn(turn.exhausted ? "exhausted" : "answered", turn.model, turn.timing, turn.usage, meterParts(turn)));
  // Tool rules (node "toolRules"): a row of its own when the turn called tools, naming the calls and which switchable rules they passed.
  if (turn.steps?.length > 0) {
    const rules = toolRulesNode({ steps: turn.steps, settings: toolRules });
    chatLog?.write([stepEntry({ step: "node", name: "toolRules", ms: 0, input: { calls: rules.calls, tools: rules.tools }, output: { on: rules.on, off: rules.off } }, { turn: t.ledgerTurn ?? null })].filter(Boolean));
  }
  outcome.clean = ledger.untrusted !== true;
  // Cancelled by the Worker (`steer.js`), in a round or after the last: its asks are withdrawn, nothing is kept as said, and nothing is texted.
  // A provisional run (the config's "Provisional run" wire) answers only once the Worker's checks said go; stopped, or never told, it is cancelled.
  const stopped = steer?.provisional === true && !turn.cancelled && !(await tex.step("provisional_wait", () => steer.waitGo()));
  if (stopped || turn.cancelled || (steer !== null && (await tex.step("cancel_check", () => steer.endCancelled())))) {
    if (steer !== null && steer.changed.length > 0) await tex.step("provisional_undo", () => steer.revert()); // what it changed before its go is put back
    return await tex.step("cancelled", () => begun.catch(() => {}).then(() => cancelledTurn(store, session, { ledger, steer, steps: turn.steps })));
  }
  // Fail-closed (`standsCheck.js` `final`): an answer that still says it stands, skips or waits on an earlier turn with nothing this turn behind it,
  // on the last round or after its one send-back, goes as an honest line, never as it is. A settled ending (a tapback, silence, a job's start) is not a reply in words.
  // After its send-back, an empty retry, a 1:1's silence or spent rounds get the honest line too: the gate never drops a reply.
  // A group chat's silence stands: saying nothing there is a choice the chat's rules allow (`sendTheReply.js`).
  const silent = turn.settled === SAY_NOTHING_TOOL && group === null;
  const honest = stands !== null && (turn.settled === undefined || silent) ? stands.final(turn.answer, { exhausted: turn.exhausted === true, silent }) : null;
  if (honest !== null) {
    turn.answer = honest;
    if (silent) delete turn.settled;
  }
  Object.assign(t, { turn, replyPlace: null }); // the classifier no longer runs before the reply, so it places none (`threadedTurn.js`)
}
// TEX ENTRY POINT: end
