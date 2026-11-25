/** Hears voice messages, keeps sent files, and reads the chat's history and the tools offered. One step of Tex's turn (`../texEntryPoint.js`). */

import { transcriptionForwarder } from "../../../../../apps/mcp/src/ingestion/transcription.js";
import { markChatWords, markUntrusted } from "../../../../../apps/mcp/src/privacy/egress.js";
import { carryCounts } from "../stretch.js";
import { addressedTo } from "../../../../../apps/mcp/src/tools/offerFor.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { hearVoiceMessages } from "../attachments.js";
import { backgroundSession, runningJobsOf } from "../background.js";
import { jobStartChooser } from "../jobStartChoice.js";
import { texConfigOf } from "../texConfig.js";
import { machinesFor } from "../../../../../apps/mcp/src/machines/forJobs.js";
import { readMailHealth } from "../mailHealth.js";
import { openChatSkills } from "../chatSkills.js";
import { lastOffer } from "../claimCheck.js";
import { checkerHistory } from "../groupTurn.js";
import { carryKeptFiles, keepSentFiles } from "../keptFiles.js";
import { openLearnedSkills } from "../learnedSkills.js";
import { checkerQuestion, mailCheckerFor } from "../mailChecker.js";
import { approvalVerdict } from "../textedApprovals.js";
import { threadsOn } from "../conversationThreads.js";
import { ledgerPlace } from "../ledger.js";
import { threadedTurn } from "../threadedTurn.js";
import { carryKey } from "../stretch.js";
import { historyReadsOf, imageOf, weekTurn } from "../weekHistory.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "../localNow.js";
import { routineTimeZone } from "../routine.js";
import { pagesOpenedBefore } from "../turnWeb.js";
import { TEXTS_CLIENT_ID } from "./clients.js";
import { asksOn, groupsOn, readTexterGroups } from "../groupChats.js";
import { lastShownSend } from "../../../../../apps/mcp/src/tools/shownEmail.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function readTheHistory(t) {
  const { body, chatTurn, controlPlane, dispatch, env, group, historyRead, hot, job, ledger, offeredRead, question, quoted, received, report, routine, runner, sent, session, stages, store, tex } = t;
  // Voice messages become their words only now, once the turn is allowed and counted; a file is kept for later texts and jobs, and shown to them again (`keptFiles.js`).
  const fresh = await tex.step("keep_sent_files", async () => keepSentFiles(store, await tex.step("hear_voice", () => hearVoiceMessages(sent, transcriptionForwarder(env), session.workspaceId))));

  const offered = await tex.wait("tools_list", offeredRead); stages?.mark("tools");
  const learnedRead = tex.ahead("learned_skills", () => group !== null ? historyRead.then(() => openChatSkills(group)) : openLearnedSkills(dispatch, { texted: session.actorClientId === TEXTS_CLIENT_ID, contexts: store.contexts, warm: hot.skills }), null).catch(() => null); // read beside the history, once the egress ledger is set
  // Today's history, and the chat's event log when the Worker names what this turn covers (`loggedTurn.js`).
  const [{ conversation, history, view: momentRead = null, tools: keptReads = null }, logged] = await tex.wait("history", historyRead); const attachments = [...fresh, ...(runner ? [] : await tex.step("kept_files_again", () => carryKeptFiles(store, history, fresh), []))]; stages?.mark("history");
  // The new text sorted into the chat's conversations, started now and waited for just before the model (`threadedTurn.js`).
  const place = ledgerPlace(session);
  // The chat's history (`weekHistory.js`): when the front door reads the `chat:` and `summaries:` modules, every chat, one-to-one or group, is shown its chat word for word over the days the config names after each earlier day's summary, with its pictures.
  const reads = chatTurn && job === null && place !== null && typeof store?.texLedger === "function" ? historyReadsOf(env) : null;
  const week = reads !== null ? { reads, grant: carryKey(session), readPicture: pictureReader(group, dispatch) } : null;
  // The threaded turn carries the history modules even with conversation threads off (then it sorts nothing).
  const threading = threadsOn(env);
  const threadsRun = chatTurn && job === null && !runner && logged !== null && place !== null && (threading || week !== null) && typeof store?.texLedger === "function"
    ? tex.ahead("threads", () => threadedTurn({ logged, ledger: store.texLedger(place.owner.chat ?? null), chat: place.chat, group: group !== null, config: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "threads" }, week, threading }).then((built) => (built !== null && !threading ? { ...built, sort: null } : built)), null).catch(() => null)
    : null;
  // A turn that answers no named text (a routine, a check-in, a job's report) reads the same week.
  const weekMoment = week !== null && momentRead !== null && logged === null ? await tex.step("week_history", () => weekTurn({ ledger: store.texLedger(place.owner.chat ?? null), chat: place.chat, now: received, timeZone: runner ? routineTimeZone(routine?.settings, body.routine?.timeZone) : readTimeZone(body.timeZone) ?? DEFAULT_TIME_ZONE, reads: week.reads, grant: week.grant, readPicture: week.readPicture }), null).catch(() => null) : null;
  const view = weekMoment?.history ? { history: [weekMoment.history], shown: weekMoment.shown } : momentRead;
  // A carried result read from outside marks this turn as if it had read it itself (the owner, 2026-11-10; `stretch.js`).
  const carry = carryCounts(logged?.carried ?? []); if (logged !== null) { const line = { carried: carry.carried, stubOther: carry.stubOther, stubGrant: carry.stubGrant, stubWorkspace: carry.stubWorkspace, carriedOutside: carry.outside ? "yes" : "no", stretch: carry.stretch }; console.log(JSON.stringify({ event: "tex_carry", ...line })); if (stages) stages.carry = line; }
  if (group !== null) markChatWords(ledger); if (job?.tainted || report !== null || t.crossChat || carry.outside) markUntrusted(ledger); // a chat's own words are no stranger's (`chatSkills.js`); a job planned after a read from outside still carries it, and a job's report is what it read, and another chat's ask or answer is that chat's words
  // The computers a chat turn may name, read beside the rest so the turn is told they're there (`machines/forTurn.js`); a job's own turn names none.
  const computersRead = chatTurn && job === null && (group !== null || session.actorClientId === TEXTS_CLIENT_ID) ? tex.ahead("computers", () => machinesFor(env, session, controlPlane), []).catch(() => []) : null;
  // Their own mailboxes, read beside the rest so a mail search is told which it reaches (`mailAccounts.js`); a group's shared mail is told by `groupMail.js`.
  const mailRead = group === null ? tex.ahead("mail_accounts", () => readMailHealth(store), []).catch(() => []) : null;
  // The group chats they are in, read from their own 1:1 when the front door reads the `groups` module (`groupChats.js`).
  const groupsRead = chatTurn && job === null && !runner && group === null && session.actorClientId === TEXTS_CLIENT_ID && (groupsOn(env) || asksOn(env)) ? tex.ahead("my_groups", () => readTexterGroups(controlPlane, session), null).catch(() => null) : null;
  const background = chatTurn ? backgroundSession({ running: runningJobsOf(body.running), job, now: received, report: report !== null, read: () => markUntrusted(ledger), machines: group !== null || session.actorClientId === TEXTS_CLIENT_ID ? () => computersRead ?? machinesFor(env, session, controlPlane) : null, inGroup: group !== null, opened: () => pagesOpenedBefore(history), chooseStart: jobStartChooser({ env, config: texConfigOf(env), writer: store.ledger ?? null, turn: typeof body.turn === "string" ? body.turn : null }) }) : null; // a job starts with the pages the chat opened (`jobPages.js`)
  session.egress.turn = runner ? { note: routine?.body ?? "" } : { history, question }; // the sharing judge's
  // A typed yes, nothing armed, to Tex's last text offering a held change in its own words (`tools/likedPreview.js`),
  // or showing an email and asking "Send?" (`tools/shownEmail.js`).
  if (session.egress.liked === undefined && approvalVerdict(question) === "approve") session.egress.liked = [lastOffer(history) ?? lastShownSend(history)].find((offer) => group === null || addressedTo(offer, group.from)) ?? undefined;

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
  Object.assign(t, { attachments, background, computersRead, mailRead, groupsRead, conversation, fresh, history, keptReads, learnedRead, logged, offered, threadsRun, view, week: weekMoment ? { read_day: weekMoment.read_day, search_chat: weekMoment.search_chat } : null });
}
// TEX ENTRY POINT: end

/**
 * How the week's pictures are read back: `read_image` on the note each is kept in, a group's in its home (`chatHome.js`),
 * a person's in their own workspace. A picture kept anywhere else is not read.
 */
function pictureReader(group, dispatch) {
  return async (note, image) => {
    if (group !== null) {
      const home = group.home;
      if (!home || typeof home.dispatch !== "function" || !note.startsWith(`${home.folder}/`)) return null;
      return imageOf(await home.dispatch("read_image", { note, image }));
    }
    return typeof dispatch === "function" ? imageOf(await dispatch("read_image", { note, image })) : null;
  };
}
