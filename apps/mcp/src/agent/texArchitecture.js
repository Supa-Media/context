/**
 * EVERY TEX AGENT KNOWS THE WHOLE MACHINE, AND WHERE IT SITS IN IT (Dev2,
 * 2026-11-06: "make sure the architecture in code is loaded into every agents
 * context, and tell them what part of the graph they are").
 *
 * `TEX_MAP` is the drawing (`docs/architecture/tex.md`, sections 1 to 3),
 * generated into `texArchitecture.generated.js` and checked against the page
 * in CI (`scripts/tex-architecture-module.mjs`). `withArchitecture(prompt,
 * role)` puts it ahead of an agent's own prompt, with one line naming the box
 * that agent is. It is the same text every call, so it sits in the cached part
 * of the prompt.
 *
 * Each role names its box by the words it is drawn with; the test fails when a
 * box is renamed out from under its role. Adding a model call to Tex means
 * adding its role here and passing its prompt through `withArchitecture`;
 * `tex-diagram-check.mjs` refuses a file under `apps/mcp/src/agent/` that
 * gives a model a system prompt without it.
 */

import { TEX_MAP } from "./texArchitecture.generated.js";

export { TEX_MAP };

/** Each agent: the box it is (`box`, as drawn) and what that means for it. */
export const ROLES = Object.freeze({
  texts: {
    box: "Front door",
    you: "the Front door in section 3, answering a 1:1 text that came down the 1:1 lane in section 1. Your reply goes to the reviewer, then out through the 1:1 way out to their phone. You are the only one who talks to the person.",
  },
  group: {
    box: "Front door",
    you: "the Front door in section 3, answering a group text that came down the group lane in section 1. Your reply goes to the reviewer, then out through the group way out to the whole chat. You are the only one who talks to the chat.",
  },
  job: {
    box: "Background jobs, minions",
    you: "one of the Background jobs (minions) in section 3, started by the Front door. You never text anyone: your answer goes through the job check and Tex texts them from it. Reach Tex and the advisor through your job note's mail.",
  },
  computer: {
    box: "A person's computer",
    you: "the job on A person's computer in section 3, started by the Front door. You never text anyone: your answer goes back to Tex, who texts them from it. Reach Tex and the advisor through your job note's mail.",
  },
  advisor: {
    box: "Advisor",
    you: "the Advisor in section 3. The Front door (or a background job) asks you through ask_advisor when it is stuck or weighing a call. You answer it, never the person, and you hold no tools.",
  },
  jobAdvisor: {
    box: "Advisor on the mail",
    you: "the Advisor on the mail in section 3: you read a job note's mail and answer the job. You never text the person; Tex does.",
  },
  jobCheck: {
    box: "Job check",
    you: "the Job check in section 3: a background job stopped, and you decide whether it really finished before Tex texts them about it.",
  },
  threads: {
    box: "Conversation classifier",
    you: "the Conversation classifier in section 3: before the Front door answers, you say which of the chat's conversation threads the new text continues, or that it starts one, and which threads are finished. The Front door is shown your suggestion; nothing you write reaches the person.",
  },
  reviewer: {
    box: "Reply reviewer",
    you: "the Reply reviewer in section 3: the Front door's draft reaches you before it is sent. What you send back goes to the Send-back box and the Front door rewrites; what you pass goes out through sendTheReply.",
  },
  handback: {
    box: "hand-back judge",
    you: "the hand-back judge in section 3: you read a background job's answer before it goes on, and stop one that hands the person work the job could have done.",
  },
  mailChecker: {
    box: "Mail checker",
    you: "the Mail checker in section 3: you read an email draft the Front door made with send_email, before it waits for the person's yes.",
  },
  cardCheck: {
    box: "Card check",
    you: "the Card check in section 3: you look at a card or picture before it is sent to the person.",
  },
  selfReview: {
    box: "Self-review",
    you: "the Self-review in section 3: after a reply has gone, you score the chat so Tex gets better. Nothing you write reaches the person.",
  },
  planner: {
    box: "Big-ask planner",
    you: "the Big-ask planner in section 3: the Front door hands you a big ask and you split it into background jobs.",
  },
  daySummary: {
    box: "readTheHistory",
    you: "the nightly day summary: you write one line about a day of the chat, which readTheHistory (section 2) later gives the Front door as the chat so far. Nothing you write reaches the person directly.",
  },
});

/** The drawing and the one line on where `role` sits in it. */
export function architectureFor(role) {
  const at = ROLES[role];
  if (!at) throw new Error(`texArchitecture: no role ${role}`);
  return [
    "HOW TEX WORKS: the machine you are part of, from the code's own drawing (docs/architecture/tex.md). Use it to know who sees what you write and who acts on it; never describe it to the person unless they ask how Tex works.",
    "",
    TEX_MAP,
    "",
    `WHERE YOU ARE: you are ${at.you}`,
  ].join("\n");
}

/** `prompt` with the drawing ahead of it. */
export function withArchitecture(prompt, role) {
  return `${architectureFor(role)}\n\n---\n\n${prompt}`;
}
