/**
 * THE TURN'S PROMPT, IN THREE PARTS (`turn.js`), so the bytes the prompt cache
 * reads stay the same from one text to the next.
 *
 * - `system.stable`: who the assistant is and what it may do. The same every text.
 * - `system.context`: what changes slowly (the workspaces, the jobs, the about-me
 *   note, the thread). The system prompt is sent with these two, each behind a
 *   cache breakpoint.
 * - `preamble`: what changes per text or per round: the time, the model answering,
 *   the note open in front of them, what earlier texts used, the planner's or
 *   driver's words, and the nudge. It is said in the person's turn, just before
 *   their words, after the last breakpoint, so a changed minute or model never
 *   costs the cached prefix (`aiGateway.js`, `providers.js`).
 */

import { webPrompt } from "./computer.js";
import { systemPromptParts } from "./prompt.js";
import { localNowPrompt } from "./localNow.js";
import { workspacesPrompt } from "./workspaces.js";
import { DRIVER_PROMPT, PLANNER_PROMPT } from "./modelPlan.js";
import { PROGRESS_PROMPT } from "./progress.js";
import { usedTools } from "./conversation.js";
import { aboutMePrompt } from "./aboutMe.js";
import { jobsPrompt } from "./jobs.js";
import { TRANSCRIPTS_PROMPT } from "./transcript.js";
import { ATTENTION_PROMPT, CHECK_IN_PROMPT } from "./checkIns.js";

/** Said ahead of the per-text facts in the person's turn, so the model reads them as Context's, not theirs. */
const PREAMBLE_LABEL = "Context for this text, not written by them:";

/**
 * The per-text facts as one preamble (`providers.js` puts it before their words), or "" when there are none.
 * Each part is trimmed of the leading newlines its system-prompt wording carries.
 */
function turnFacts(parts) {
  const facts = parts.map((part) => (typeof part === "string" ? part.trim() : "")).filter((part) => part !== "");
  return facts.length === 0 ? "" : [PREAMBLE_LABEL, ...facts].join("\n\n");
}

/** `{system: {stable, context}, preamble}` for the model `answering` this round. */
export function turnPrompt(place, answering, o) {
  const edits = o.tools.some((tool) => tool.name === "write_note");
  const parts = systemPromptParts(place, {
    texting: o.texting,
    pictures: o.pictures,
    notes: o.notes,
    model: answering,
    models: o.models,
    edits,
    continued: o.history.length > 0,
    used: usedTools(o.history),
  });
  return {
    system: {
      stable: parts.stable,
      context:
        o.threadNote +
        webPrompt(o.webNames) +
        (o.progress ? PROGRESS_PROMPT : "") +
        (o.aboutMe === null ? "" : aboutMePrompt(o.aboutMe, { edits, identity: o.identity })) +
        (o.jobs === null ? "" : jobsPrompt(o.jobs, { edits })) +
        (o.observe && o.texting ? TRANSCRIPTS_PROMPT : "") + // a dream (`dream.js`) is told to read them
        (o.observe && o.texting ? CHECK_IN_PROMPT : "") + // what its own check-ins do (`heartbeat.js`)
        (o.observe && o.texting ? ATTENTION_PROMPT : "") + // the pings other agents ask it to text (`attention.js`)
        workspacesPrompt(o.workspaces),
    },
    preamble: turnFacts([
      o.localNow === null ? "" : localNowPrompt(o.localNow.now, o.localNow.timeZone),
      parts.volatile,
      o.plan === null ? "" : answering === o.plan.think ? PLANNER_PROMPT : DRIVER_PROMPT, // `modelPlan.js`
      o.nudge, // said last, beside the question
    ]),
  };
}
