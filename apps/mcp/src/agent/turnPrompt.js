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
import { FROZEN_MODULES, FROZEN_NAMES } from "./frozenModuleNames.js";
import { jobsPrompt } from "./jobs.js";
import { personVoicePrompt } from "./personVoice.js";
import { calendarAge, calendarPrompt } from "./calendarCache.js";
import { TRANSCRIPTS_PROMPT } from "./transcript.js";
import { ATTENTION_PROMPT, CHECK_IN_PROMPT } from "./checkIns.js";
import { keptWordsOf, manifestOf } from "./promptManifest.js";
import { mailAccountsFacts, mailAccountsPrompt } from "./mailAccounts.js";

/** The repo's fixed paragraphs: the commit's catalogue holds their words, so a turn never keeps them (`keptWordsOf`). */
const REPO_WORDS = new Set([TRANSCRIPTS_PROMPT, CHECK_IN_PROMPT, ATTENTION_PROMPT, PLANNER_PROMPT, DRIVER_PROMPT, PROGRESS_PROMPT].map((text) => text.trim()));

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

/**
 * Puts the day's words of each frozen module (`frozenModules.js` `FROZEN_MODULES`) in `threadParts` and `context`, in
 * place, and answers the ones whose words now differ: `[{id, now}]`. On the day's first turn it keeps these words instead.
 */
function freezeModules(freeze, threadParts, context) {
  const slots = [
    ...threadParts.map((part, at) => [part[0] === "" ? "context/thread" : `context/thread/${part[0]}`, (text) => (threadParts[at] = [part[0], text]), part[1] ?? ""]),
    ...context.filter(([id]) => id !== "thread").map((entry) => [`context/${entry[0]}`, (text) => (entry[1] = text), entry[1] ?? ""]),
  ].filter(([id]) => FROZEN_MODULES.includes(id));
  if (freeze.modules === null) {
    freeze.see?.(Object.fromEntries(slots.map(([id, , now]) => [id, now])));
    return [];
  }
  const changed = [];
  for (const [id, put, now] of slots) {
    const kept = typeof freeze.modules[id] === "string" ? freeze.modules[id] : "";
    if (kept === now) continue;
    put(kept);
    // A module with no words this turn was most often not read (a store that failed), not emptied: the day's words stand.
    if (now.trim() !== "") changed.push({ id, now });
  }
  if (changed.length > 0 && typeof context[0][1] === "string") context[0][1] = threadParts.map(([, text]) => text ?? "").join("");
  return changed;
}

/** What changed in the frozen modules since the day's first turn: each module's words now, which win over the ones above the history. */
function frozenNote(changed) {
  if (changed.length === 0) return "";
  return [
    "Since this chat's first text today, these parts of your instructions changed. The words above the history are from then; these are now, and win:",
    ...changed.map(({ id, now }) => `${FROZEN_NAMES[id] ?? id} now reads:\n${now.trim()}`),
  ].join("\n\n");
}

/** `{system: {stable, context}, preamble, prompt}` for the model `answering` this round; `prompt` is its manifest (`promptManifest.js`). */
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
  // Each module in the order it is sent, named, so the call's manifest (`promptManifest.js`) says which ran.
  // The thread note may come in named parts (`runTheModel.js`): sent as one block, each named in the manifest.
  // Copied: a frozen module is put in place below, and the caller builds every round from the same parts.
  const threadParts = (Array.isArray(o.threadNote) ? o.threadNote : [["", o.threadNote ?? ""]]).map(([part, text]) => [part, text]);
  const context = [
    ["thread", threadParts.map(([, text]) => text ?? "").join("")],
    ["web", webPrompt(o.webNames)],
    ["progress", o.progress ? (o.progress.prompt ?? PROGRESS_PROMPT) : ""], // at the chat's progress level (`progress.js`)
    ["aboutMe", o.aboutMe === null ? "" : aboutMePrompt(o.aboutMe, { edits, identity: o.identity })],
    ["jobs", o.jobs === null ? "" : jobsPrompt(o.jobs, { edits })],
    ["voice", o.voice == null ? "" : personVoicePrompt(o.voice, { edits })], // how they talk, `tex/voice.md` (`personVoice.js`)
    // The person's own 1:1 record, its check-ins and the pings other agents send it: never a group's (Dev2, 2026-11-17:
    // every group turn was told its history is in "their personal workspace"; a group's is in its home, `groupTurn.js`).
    ["transcripts", o.observe && o.texting && !o.inGroup ? TRANSCRIPTS_PROMPT : ""], // a dream (`dream.js`) is told to read them
    ["checkIns", o.observe && o.texting && !o.inGroup ? CHECK_IN_PROMPT : ""], // what its own check-ins do (`heartbeat.js`)
    ["attention", o.observe && o.texting && !o.inGroup ? ATTENTION_PROMPT : ""], // the pings other agents ask it to text (`attention.js`)
    ["workspaces", workspacesPrompt(o.workspaces)],
    ["groups", typeof o.groups === "string" ? o.groups : ""], // the group chats they are in, read from their 1:1 (`groupChats.js`)
    ["devShare", typeof o.devShare === "string" ? o.devShare : ""], // a group chat's sharing with the developers (`devShare.js`)
    ["mail", mailAccountsPrompt(o.mail)], // the mailboxes a mail search reaches (`mailAccounts.js`); their states are per text, below
  ];
  // The day's words of the rarely-changing modules, when the step freezes them (`frozenModules.js`): sent above the
  // history unchanged until the next summary; what changed since is said after it, in `frozen`, and wins.
  const changed = o.freeze ? freezeModules(o.freeze, threadParts, context) : [];
  // Always the day: a caller with no clock of its own (the memory nudge, a reflection) gets now, in the routines' default zone, named (Dev2, 2026-11-10).
  const now = o.localNow == null ? Date.now() : o.localNow.now;
  const facts = [
    ["now", o.localNow == null ? localNowPrompt(now, null) : localNowPrompt(now, o.localNow.timeZone)],
    // Their next 7 days, a copy (`calendarCache.js`), said in their turn: the copy is refreshed between texts, and in the
    // cached system prompt every refresh wrote the history after it to the cache again (2026-11-14 21:26Z: 79,000 tokens).
    ["calendar", o.calendar == null ? "" : calendarPrompt(o.calendar)],
    ["calendarAge", o.calendar == null ? "" : calendarAge(o.calendar, o.localNow?.now ?? Date.now())],
    ["frozen", frozenNote(changed)], // the frozen modules' words now, where they changed since the day's first turn
    ["examples", o.examples ?? ""], // the Training moments nearest to this text (`nodes/examples.js`), "" unless the front door is wired to them
    ["turnNote", o.turnNote], // per-text words from the entry point: who tagged it, the thread, the jobs running now (`runTheModel.js`)
    ["mailStates", mailAccountsFacts(o.mail)], // only a mailbox that is not fine right now
    ["volatile", parts.volatile],
    ["plan", o.plan === null ? "" : answering === o.plan.think ? PLANNER_PROMPT : DRIVER_PROMPT], // `modelPlan.js`
    ["nudge", o.nudge], // said last, beside the question
  ];
  const preamble = turnFacts(facts.map(([, text]) => text));
  const stableId = ["stable", o.texting ? "texting" : "notes", ...(o.pictures ? ["pictures"] : []), ...(edits ? ["edits"] : []), ...(parts.production ? ["production"] : [])].join("/");
  const sent = [[stableId, parts.stable], ...context.flatMap(([id, text]) => (id === "thread" ? threadParts.map(([part, words]) => [part === "" ? "context/thread" : `context/thread/${part}`, words]) : [[`context/${id}`, text]])), ...facts.map(([id, text]) => [`preamble/${id}`, typeof text === "string" ? text.trim() : text])];
  return {
    system: { stable: parts.stable, context: context.map(([, text]) => text ?? "").join("") },
    preamble,
    prompt: {
      modules: manifestOf(sent),
      words: keptWordsOf(sent.filter(([, text]) => !REPO_WORDS.has(typeof text === "string" ? text.trim() : text))), // the words a rebuild at this commit can't make (`promptManifest.js` `keptWordsOf`)
      // The builder inputs a rebuild cannot read from the notes: when, where, and which model it was said to.
      inputs: { at: Math.round(now), ...(o.localNow?.timeZone ? { timeZone: o.localNow.timeZone } : {}), ...(typeof answering === "string" ? { model: answering } : {}), history: o.history.length },
    },
  };
}
