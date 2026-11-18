/**
 * The gateway's nodes: the code of each `texConfig.json` node, by node id. Every node runs in the gateway, on one runner
 * and one graph (Dev2, 2026-11-14); the wires between them are never here: `packages/shared/src/texGraph.cjs` reads
 * them from the config (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections between
 * node to be code"). A node is `async (input, io) => output`; it reaches another node only through `io.use`, `io.back`
 * or `io.job`, which its wires decide, and it never imports another node's code.
 *
 * Each node joins this table, and leaves the "not migrated yet" list, in the pull request that moves its code.
 */
import { checkin } from "./nodes/checkin.js";
import { notify } from "./nodes/notify.js";
import { oldLineNode } from "./nodes/oldLine.js";
import { editNode } from "./nodes/edit.js";
import { moveChatNode } from "./nodes/moveChat.js";
import { jobcheck } from "./nodes/jobcheck.js";
import { handback } from "./nodes/handback.js";
import { mailadv } from "./nodes/mailadv.js";
import card from "./nodes/card.js";
import daysum from "./nodes/daysum.js";
import dream from "./nodes/dream.js";
import egress from "./nodes/egress.js";
import housekeep from "./nodes/housekeep.js";
import nightly from "./nodes/nightly.js";
import nudge from "./nodes/nudge.js";
import picture from "./nodes/picture.js";
import reflect from "./nodes/reflect.js";
import { job } from "./nodes/job.js";
import { routine } from "./nodes/routine.js";
import { advisorNode } from "./nodes/advisor.js";
import { checkItMayRunNode } from "./nodes/checkItMayRun.js";
import { checksNode } from "./nodes/checks.js";
import { checkTheQuestionNode } from "./nodes/checkTheQuestion.js";
import { classifierNode } from "./nodes/classifier.js";
import { fallbackNode } from "./nodes/fallback.js";
import { fdNode } from "./nodes/fd.js";
import { openTheWebNode } from "./nodes/openTheWeb.js";
import { plannerNode } from "./nodes/planner.js";
import { prepareBookkeepingNode } from "./nodes/prepareBookkeeping.js";
import { prepareTheAnswerNode } from "./nodes/prepareTheAnswer.js";
import { readTheHistoryNode } from "./nodes/readTheHistory.js";
import { readTheSetupNode } from "./nodes/readTheSetup.js";
import { readTheTextNode } from "./nodes/readTheText.js";
import { reviewerNode } from "./nodes/reviewer.js";
import { runARoutineNode } from "./nodes/runARoutine.js";
import { selfreviewNode } from "./nodes/selfreview.js";
import { sendNode } from "./nodes/send.js";
import { settleAYesOrNoNode } from "./nodes/settleAYesOrNo.js";
import { toolsNode } from "./nodes/tools.js";
import { watchWhatLeavesNode } from "./nodes/watchWhatLeaves.js";
// Built ahead of live Tex's config, for the simpler graph a Lab draft runs (Dev2, 2026-11-16).
import { doorStepNode } from "./nodes/doorStep.js";
import { bypassNode } from "./nodes/bypass.js";
import { answerCheckNode } from "./nodes/answerCheck.js";
import { handoffNode } from "./nodes/handoff.js";
import learn from "./nodes/learn.js";
import { afterReplyNode } from "./nodes/afterReply.js";
import chatDays from "./nodes/chatDays.js";
import moveJudge from "./nodes/moveJudge.js";
import { crossChatGateNode } from "./nodes/crossChatGate.js";
import { chatAskNode } from "./nodes/chatAsk.js";
import { chatAnswerNode } from "./nodes/chatAnswer.js";
import { tapbackNode } from "./nodes/tapback.js";
import { decideWhyNode } from "./nodes/decideWhy.js";
import { shapeGateNode } from "./nodes/shapeGate.js";
import { partEndNode } from "./nodes/partEnd.js";
import { jobReportNode } from "./nodes/jobReport.js";
import { jobStartNode } from "./nodes/jobStart.js";
import { jobadv } from "./nodes/jobadv.js";
import { staffNode } from "./nodes/staff.js";

/**
 * Each entry is a getter, so the table reads a node's code when the runner asks for it, never while the modules load: the
 * nodes' step files reach `gatewayGraph.js` (a job's check runs over a wire from `sendTheReply.js`), which imports this
 * table, so an import cycle could otherwise read a node before its module ran.
 *
 * @type {Record<string, (input: any, io: any) => Promise<any>>}
 */
export const GATEWAY_NODES = {
  // Door steps, group "door", in the order their wires run them.
  get readTheText() { return readTheTextNode; },
  get runARoutine() { return runARoutineNode; },
  get checkTheQuestion() { return checkTheQuestionNode; },
  get settleAYesOrNo() { return settleAYesOrNoNode; },
  get watchWhatLeaves() { return watchWhatLeavesNode; },
  get checkItMayRun() { return checkItMayRunNode; },
  get readTheHistory() { return readTheHistoryNode; },
  get openTheWeb() { return openTheWebNode; },
  get readTheSetup() { return readTheSetupNode; },
  get prepareBookkeeping() { return prepareBookkeepingNode; },
  get prepareTheAnswer() { return prepareTheAnswerNode; },
  // The answer maker and what it reaches.
  get fd() { return fdNode; },
  get tools() { return toolsNode; },
  get advisor() { return advisorNode; },
  get fallback() { return fallbackNode; },
  get planner() { return plannerNode; },
  get checks() { return checksNode; },
  get reviewer() { return reviewerNode; },
  // The way out, and what runs behind it.
  get send() { return sendNode; },
  get classifier() { return classifierNode; },
  get selfreview() { return selfreviewNode; },
  // Starts and the job's checks (graph step 4).
  get checkin() { return checkin; },
  get notify() { return notify; },
  // A text on the old number, before Triage (the Photon switch).
  get oldLine() { return oldLineNode; },
  get moveChat() { return moveChatNode; },
  // A person's edit of a text they sent: the chat's record, and a turn when it changed what they said.
  get edit() { return editNode; },
  get jobcheck() { return jobcheck; },
  get handback() { return handback; },
  get mailadv() { return mailadv; },
  get job() { return job; },
  get routine() { return routine; },
  // What the front door\'s tools and Text them reach, and the nightly runs (graph step 5).
  get card() { return card; },
  get daysum() { return daysum; },
  get dream() { return dream; },
  get egress() { return egress; },
  get housekeep() { return housekeep; },
  get nightly() { return nightly; },
  get nudge() { return nudge; },
  get picture() { return picture; },
  get reflect() { return reflect; },
  // Steps on the shelf (`texNodeShelf.json`): their code is merged and main's config has no node for them,
  // so live Tex never runs them; a Lab draft that draws them does (`texConfig.js` `withDraft`). Each folds steps above
  // into one: the Door (the eleven door steps), Confirmations & refusals, the Answer check (checks and the reviewer),
  // Learn (reflect and the nudge), After the reply (classifier and self-review), the Job advisor (jobcheck and
  // mailadv) and Staff messages.
  get doorStep() { return doorStepNode; },
  get bypass() { return bypassNode; },
  get answerCheck() { return answerCheckNode; },
  get handoff() { return handoffNode; },
  get learn() { return learn; },
  get afterReply() { return afterReplyNode; },
  get jobadv() { return jobadv; },
  get staff() { return staffNode; },
  // Chat day summaries: every chat's finished days summed up after a reply, groups included (`nodes/chatDays.js`).
  get chatDays() { return chatDays; },
  // The move judge: whether their recent words, or their yes to Tex's offer, ask to move or archive a note of theirs (`nodes/moveJudge.js`).
  get moveJudge() { return moveJudge; },
  // Tex asks Tex across chats (`../crossChat.js`): the gate before an ask leaves, the input that starts the other chat's
  // run (and the asking chat's run for its answer), and the step that sends an ask-run's answer back.
  get crossChatGate() { return crossChatGateNode; },
  get chatAsk() { return chatAskNode; },
  get chatAnswer() { return chatAnswerNode; },
  // A tapback as the whole answer: whether the front door may end the turn with one, and which emoji (`nodes/tapback.js`, `../tapbackEnding.js`).
  get tapback() { return tapbackNode; },
  // Decide's reason, asked again when it contradicts the act (`nodes/decideWhy.js`): Decide's route calls it with Clef (`../textsDecide.js`).
  get decideWhy() { return decideWhyNode; },
  // The Shape gate: what kind of answer this turn is, read by Clef beside the door (`nodes/shapeGate.js`, `../shapeGate.js`).
  get shapeGate() { return shapeGateNode; },
  // After each part of a background job: the next part, the last draft, or the end, under the limits in its config (`nodes/partEnd.js`).
  get partEnd() { return partEndNode; },
  // A background job's report, a new run of its chat: read strictly, asked the gateway's own line (`nodes/jobReport.js`).
  get jobReport() { return jobReportNode; },
  // Whether a background job the front door asks for starts now, under the slots in its config (`nodes/jobStart.js`).
  get jobStart() { return jobStartNode; },
};
