/**
 * EVERY TEX AGENT KNOWS THE WHOLE MACHINE, AND WHERE IT SITS IN IT (Dev2,
 * 2026-11-06: "make sure the architecture in code is loaded into every agents
 * context, and tell them what part of the graph they are"; 2026-11-14: Tex is
 * told its own structure from the config).
 *
 * `TEX_MAP` is Tex's graph in words: every node of
 * `packages/shared/src/texConfig.json`, what it does and where its wires go,
 * generated into `texArchitecture.generated.js` by
 * `scripts/tex-architecture.mjs` and checked against the config in CI.
 * `withArchitecture(prompt, role)` puts it ahead of an agent's own prompt,
 * with one line naming the node that agent is. It is the same text every
 * call, so it sits in the cached part of the prompt.
 *
 * Each role names its node by the config's id; the test fails when a node is
 * renamed or removed out from under its role. Adding a model call to Tex means
 * adding its node to the config, its role here, and passing its prompt through
 * `withArchitecture`; `tex-diagram-check.mjs` refuses a file under
 * `apps/mcp/src/agent/` that gives a model a system prompt without it.
 */

import { TEX_MAP } from "./texArchitecture.generated.js";
import { capabilitiesFor } from "./capabilities.js";
import { texStep } from "./texConfig.js";
import GENERATED_TRAINING from "../../../../packages/shared/src/texTraining.generated.json" with { type: "json" };
import { trainingOf, trainingText } from "../../../../packages/shared/src/texTraining.cjs";

/** Every Training conversation, less what a bench process scores of it (`texTraining.cjs` `trainingOf`; production reads all). */
const TRAINING = trainingOf(GENERATED_TRAINING);

export { TEX_MAP };

/** Each agent: the config node it is (`node`, by id) and what that means for it. */
export const ROLES = Object.freeze({
  texts: {
    node: "fd",
    you: "the Front door, answering a 1:1 text that came through Decide, the Queue and the Door steps. Your reply goes through the Answer checks and the Reply reviewer, then Text them sends it to their phone. You are the only one who talks to the person.",
  },
  group: {
    node: "fd",
    you: "the Front door, answering a group text that came through Decide, the Queue and the Door steps. Your reply goes through the Answer checks and the Reply reviewer, then Text them sends it to the whole chat. You are the only one who talks to the chat.",
  },
  job: {
    node: "job",
    you: "a Background job, started by the Front door. You never text anyone: your answer goes through the Job check and the Hand-back judge, and Tex texts them from it. Reach Tex and the advisor through your job note's mail.",
  },
  computer: {
    node: "job",
    you: "a Background job running on a person's computer, started by the Front door. You never text anyone: your answer goes back to Tex, who texts them from it. Reach Tex and the advisor through your job note's mail.",
  },
  advisor: {
    node: "advisor",
    you: "the Advisor. The Front door (or a Background job) asks you through ask_advisor when it is stuck or weighing a call. You answer it, never the person, and you hold no tools.",
  },
  jobAdvisor: {
    node: "mailadv",
    you: "the Advisor on job mail: you read a job note's mail and answer the job. You never text the person; Tex does.",
  },
  jobCheck: {
    node: "jobadv",
    you: "the Job check: a Background job stopped, and you decide whether it really finished before Tex texts them about it.",
  },
  threads: {
    node: "classifier",
    you: "the Classifier: you say which of the chat's conversation threads a text continues, or that it starts one, and which threads are finished. The Front door is shown your suggestion; nothing you write reaches the person.",
  },
  reviewer: {
    node: "reviewer",
    you: "the Reply reviewer: the Front door's draft reaches you before it is sent. What you send back goes to the Front door, which rewrites; what you pass goes to Text them.",
  },
  handback: {
    node: "handback",
    you: "the Hand-back judge: you read a Background job's answer before it goes on, and stop one that hands the person work the job could have done.",
  },
  mailChecker: {
    node: "mail",
    you: "the Mail checker: you read an email draft the Front door made with send_email, before it waits for the person's yes.",
  },
  cardCheck: {
    node: "card",
    you: "the Card check: you look at a card or picture before it is sent to the person.",
  },
  selfReview: {
    node: "selfreview",
    you: "the Self-review: after a reply has gone, you score the chat so Tex gets better. Nothing you write reaches the person.",
  },
  planner: {
    node: "planner",
    you: "the Big-ask planner: the Front door hands you a big ask and you split it into background jobs.",
  },
  moveJudge: {
    node: "tools",
    you: "the Move judge: before the Front door's tools move or archive a note of theirs, you read their recent texts and Tex's own offer and say whether they asked for it. Nothing you write reaches the person.",
  },
  checkIn: {
    node: "checkin",
    you: "the Check-in: nobody texted you; you look at what changed in their workspace, mail and calendar and text them only what can't wait. Your text goes through the Reply reviewer, then Text them sends it.",
  },
  daySummary: {
    node: "readTheHistory",
    you: "the nightly day summary: you write one line about a day of the chat, which Read the history later gives the Front door as the chat so far. Nothing you write reaches the person directly.",
  },
});

/** The drawing and the one line on where `role` sits in it. */
export function architectureFor(role) {
  const at = ROLES[role];
  if (!at) throw new Error(`texArchitecture: no role ${role}`);
  return [
    "HOW TEX WORKS: the machine you are part of, from Tex's config, which is what runs: each step is code, and every wire between steps (who goes next, who waits, what runs in the background) is set in that config, so this map is exactly how your turn flows. Use it to know who sees what you write and who acts on it; never describe it to the person unless they ask how Tex works.",
    "",
    TEX_MAP,
    "",
    `WHERE YOU ARE: you are ${at.you}`,
    // What Tex can do, and where (`capabilities.js`; Dev2, 2026-11-08): the roles that talk to people or guide or check what Tex says.
    ...(capabilitiesFor(role) === "" ? [] : ["", capabilitiesFor(role)]),
  ].join("\n");
}

/**
 * The steps that are given their Training modules as prompt modules, where their context puts them (`texConfig.js`
 * `texModules`), so the drawing never adds them a second time.
 */
const TRAINED_AS_MODULES = new Set(["fd", "job"]);

/**
 * The Training examples a role's step reads (`train:<nodeId>` entries of its config context, `texTraining.cjs`), or
 * "" when it names none or they have no labels yet, so an empty Training Set changes no prompt by a byte.
 */
export function trainingFor(role) {
  const node = ROLES[role]?.node;
  if (!node || TRAINED_AS_MODULES.has(node)) return "";
  return trainingText(texStep(node), TRAINING);
}

/** `prompt` with the drawing ahead of it and, when its step reads Training labels that exist, their examples after it. */
export function withArchitecture(prompt, role) {
  const training = trainingFor(role);
  return `${architectureFor(role)}\n\n---\n\n${prompt}${training === "" ? "" : `\n\n---\n\n${training}`}`;
}
