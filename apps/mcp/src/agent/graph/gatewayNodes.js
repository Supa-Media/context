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
  get jobcheck() { return jobcheck; },
  get handback() { return handback; },
  get mailadv() { return mailadv; },
  get job() { return job; },
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
};
