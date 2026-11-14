/**
 * The gateway's nodes: the code of each `texConfig.json` node, by node id. Every node runs in the gateway, on one runner
 * and one graph (Dev2, 2026-11-14); the wires between them are never here: `packages/shared/src/texGraph.cjs` reads
 * them from the config (Dev2, 2026-11-14: "it's fine for node to be code, but it's not fine for the connections between
 * node to be code"). A node is `async (input, io) => output`; it reaches another node only through `io.use`, `io.back`
 * or `io.job`, which its wires decide, and it never imports another node's code.
 *
 * Each node joins this table, and leaves the "not migrated yet" list, in the pull request that moves its code.
 */
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

/** @type {Record<string, (input: any, io: any) => Promise<any>>} */
export const GATEWAY_NODES = {
  // Door steps, group "door", in the order their wires run them.
  readTheText: readTheTextNode,
  runARoutine: runARoutineNode,
  checkTheQuestion: checkTheQuestionNode,
  settleAYesOrNo: settleAYesOrNoNode,
  watchWhatLeaves: watchWhatLeavesNode,
  checkItMayRun: checkItMayRunNode,
  readTheHistory: readTheHistoryNode,
  openTheWeb: openTheWebNode,
  readTheSetup: readTheSetupNode,
  prepareBookkeeping: prepareBookkeepingNode,
  prepareTheAnswer: prepareTheAnswerNode,
  // The answer maker and what it reaches.
  fd: fdNode,
  tools: toolsNode,
  advisor: advisorNode,
  fallback: fallbackNode,
  planner: plannerNode,
  checks: checksNode,
  reviewer: reviewerNode,
  // The way out, and what runs behind it.
  send: sendNode,
  classifier: classifierNode,
  selfreview: selfreviewNode,
};
