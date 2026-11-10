/**
 * THE TURN'S PROMPT, IN THREE PARTS (`turn.js`), so the bytes the prompt cache
 * reads stay the same from one text to the next.
 *
 * - `system.stable`: who the assistant is and what it may do. The same every text.
 * - `system.context`: what changes rarely (the workspaces, the jobs note, the about-me
 *   note, the chat's own setup). Nothing per text: a byte that changes here costs the
 *   history's cache too (`aiGateway.js`, tex-stable-prefix test). The system prompt is sent with these two, each behind a
 *   cache breakpoint.
 * - `preamble`: what changes per text or per round: the time, the model answering,
 *   who tagged it in a group, the thread it was typed in, the jobs running now, the calendar copy's age,
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
import { personVoicePrompt } from "./personVoice.js";
import { calendarAge, calendarPrompt } from "./calendarCache.js";
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
        (o.progress ? (o.progress.prompt ?? PROGRESS_PROMPT) : "") + // at the chat's progress level (`progress.js`)
        (o.aboutMe === null ? "" : aboutMePrompt(o.aboutMe, { edits, identity: o.identity })) +
        (o.calendar == null ? "" : calendarPrompt(o.calendar)) + // their next 7 days, a copy (`calendarCache.js`); its age is in the preamble
        (o.jobs === null ? "" : jobsPrompt(o.jobs, { edits })) +
        (o.voice == null ? "" : personVoicePrompt(o.voice, { edits })) + // how they talk, `tex/voice.md` (`personVoice.js`)
        (o.observe && o.texting ? TRANSCRIPTS_PROMPT : "") + // a dream (`dream.js`) is told to read them
        (o.observe && o.texting ? CHECK_IN_PROMPT : "") + // what its own check-ins do (`heartbeat.js`)
        (o.observe && o.texting ? ATTENTION_PROMPT : "") + // the pings other agents ask it to text (`attention.js`)
        workspacesPrompt(o.workspaces),
    },
    preamble: turnFacts([
      // Always the day: a caller with no clock of its own (the memory nudge, a reflection) gets now, in the routines' default zone, named (Dev2, 2026-11-10).
      o.localNow == null ? localNowPrompt(Date.now(), null) : localNowPrompt(o.localNow.now, o.localNow.timeZone),
      o.calendar == null ? "" : calendarAge(o.calendar, o.localNow?.now ?? Date.now()),
      o.turnNote, // per-text words from the entry point: who tagged it, the thread, the jobs running now (`runTheModel.js`)
      parts.volatile,
      o.plan === null ? "" : answering === o.plan.think ? PLANNER_PROMPT : DRIVER_PROMPT, // `modelPlan.js`
      o.nudge, // said last, beside the question
    ]),
  };
}
