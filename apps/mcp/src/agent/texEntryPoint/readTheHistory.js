/** Hears voice messages, keeps sent files, and reads the chat's history and the tools offered. One step of Tex's turn (`../texEntryPoint.js`). */

import { transcriptionForwarder } from "../../ingestion/transcription.js";
import { markChatWords, markUntrusted } from "../../privacy/egress.js";
import { addressedTo } from "../../tools/offerFor.js";
import { aiGatewayConfig } from "../aiGateway.js";
import { hearVoiceMessages } from "../attachments.js";
import { backgroundSession, runningJobsOf } from "../background.js";
import { machinesFor } from "../../machines/forJobs.js";
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
import { TEXTS_CLIENT_ID } from "./clients.js";

// TEX ENTRY POINT: begin (every await below is a timed `tex` call: `texTiming.js`, checked by `scripts/tex-entry-check.mjs`)
export async function readTheHistory(t) {
  const { body, chatTurn, controlPlane, dispatch, env, group, historyRead, hot, job, ledger, offeredRead, question, quoted, received, report, routine, runner, sent, session, stages, store, tex } = t;
  // Voice messages become their words only now, once the turn is allowed and counted; a file is kept for later texts and jobs, and shown to them again (`keptFiles.js`).
  const fresh = await tex.step("keep_sent_files", async () => keepSentFiles(store, await tex.step("hear_voice", () => hearVoiceMessages(sent, transcriptionForwarder(env), session.workspaceId))));

  const offered = await tex.wait("tools_list", offeredRead); stages?.mark("tools");
  const learnedRead = tex.ahead("learned_skills", () => group !== null ? historyRead.then(() => openChatSkills(group)) : openLearnedSkills(dispatch, { texted: session.actorClientId === TEXTS_CLIENT_ID, contexts: store.contexts, warm: hot.skills }), null).catch(() => null); // read beside the history, once the egress ledger is set
  // Today's history, and the chat's event log when the Worker names what this turn covers (`loggedTurn.js`).
  const [{ conversation, history }, logged] = await tex.wait("history", historyRead); const attachments = [...fresh, ...(runner ? [] : await tex.step("kept_files_again", () => carryKeptFiles(store, history, fresh), []))]; stages?.mark("history");
  // The new text sorted into the chat's conversations, started now and waited for just before the model (`threadedTurn.js`).
  const place = ledgerPlace(session);
  const threadsRun = chatTurn && job === null && !runner && logged !== null && place !== null && threadsOn(env) && typeof store?.texLedger === "function"
    ? tex.ahead("threads", () => threadedTurn({ logged, ledger: store.texLedger(place.owner.chat ?? null), chat: place.chat, group: group !== null, config: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "threads" } }), null).catch(() => null)
    : null;
  if (group !== null) markChatWords(ledger); if (job?.tainted || report !== null) markUntrusted(ledger); // a chat's own words are no stranger's (`chatSkills.js`); a job planned after a read from outside still carries it, and a job's report is what it read
  // The computers a chat turn may name, read beside the rest so the turn is told they're there (`machines/forTurn.js`); a job's own turn names none.
  const computersRead = chatTurn && job === null && (group !== null || session.actorClientId === TEXTS_CLIENT_ID) ? tex.ahead("computers", () => machinesFor(env, session, controlPlane), []).catch(() => []) : null;
  const background = chatTurn ? backgroundSession({ running: runningJobsOf(body.running), job, now: received, report: report !== null, read: () => markUntrusted(ledger), machines: group !== null || session.actorClientId === TEXTS_CLIENT_ID ? () => computersRead ?? machinesFor(env, session, controlPlane) : null, inGroup: group !== null }) : null;
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
  Object.assign(t, { attachments, background, computersRead, conversation, fresh, history, learnedRead, logged, offered, threadsRun });
}
// TEX ENTRY POINT: end
