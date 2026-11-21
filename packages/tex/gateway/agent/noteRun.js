/**
 * Tex in a note (`graph/nodes/noteRun.js`; Dev2, 2026-11-20: headless Tex inside notes: reads the 1:1 and notes, writes
 * nothing to the chat; runs with the asker's own access). A person asks Tex from a note's comment thread about the
 * words they highlighted (or a point in the note). A model reads the note, the thread, the asker's own Tex chat and,
 * when it needs them, their notes, and answers in JSON: a sentence for the thread, and optionally the whole new text for
 * the highlighted words. The model only reads. Its dispatcher refuses a write, its ledger is read and never written, and
 * nothing here texts anyone: the route writes the thread's lines and the edit, and the person decides.
 *
 * Modelled on `noteConnect.js`: `runTurn` with the read door's tools only, its own dispatcher, the built-in meter, and
 * the calls kept through `observe`. Progress is told through `onStep`, started as each read starts and finished as
 * `observe` reports it.
 */

import { builtinMeter } from "./jobLog.js";
import { AgentRefusal, runTurn } from "./turn.js";
import { builtinModel, canRunBuiltin, hasBuiltinModel } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { TEX_CONFIG } from "./texConfig.js";
import { doorAllows, WEB_READS } from "./doorTools.js";
import { ONE_TO_ONE_CHAT } from "./ledger.js";
import { READ_DAY, weekTurn } from "./weekHistory.js";
import { DEFAULT_TIME_ZONE } from "./localNow.js";
import { carryKey } from "./stretch.js";
import { noteName } from "./noteConnect.js";

/** The caps a run's words are held to: the note, the Tex chat, the ask, one thread line, the words beside the highlight. */
export const RUN_NOTE_CHARS = 12_000;
export const RUN_CHAT_CHARS = 60_000;
export const RUN_ASK_CHARS = 2_000;
export const RUN_LINE_CHARS = 1_000;
export const RUN_SIDE_CHARS = 300;
/** The thread's newest lines the model is shown. */
const RUN_THREAD_LINES = 30;
/** The answer and the replacement the parse keeps. */
export const RUN_ANSWER_CHARS = 1_500;
export const RUN_REPLACE_CHARS = 20_000;
/** The model's rounds when the node says none. */
const RUN_ROUNDS = 6;
/** The longest the 1:1 history read may hold the run back. */
const RUN_CHAT_MS = 2_000;
/** How far back the run reads the asker's 1:1 chat: the week, and every day summary before it. */
export const RUN_READS = Object.freeze({ chat: Object.freeze({ days: 7, chars: 60_000 }), summaries: Object.freeze({ days: null, chars: 20_000 }) });
/** The one file in a person's own folder that holds their texts with Tex, read by a tool as the texts step. */
const TEXTS_FILE = "tex/history.ledger.json";
/** Replies and hand-overs a run never holds: a run answers in the thread, it does not text or pass the turn on. */
const RUN_OUT = new Set(["say_nothing", "tapback", "text_progress", "need_more_tools"]);

const str = (value) => (typeof value === "string" ? value : "");
const clip = (value, max) => str(value).slice(0, max);
const tail = (value, max) => str(value).slice(-max);

/** The offered tools a run may use: the read door's, minus the replies and the hand-over. Never a write. */
export function noteRunTools(offered) {
  return (Array.isArray(offered) ? offered : []).filter((tool) => typeof tool?.name === "string" && !RUN_OUT.has(tool.name) && doorAllows("read", tool.name, tool));
}

/**
 * The run's dispatcher: refuses any name not in `allowedNames` in band (the model reads the refusal and goes on), and
 * sends each call to the run's workspace (`workspaceContext`, "@name", or own when null). A workspace the model names
 * itself is passed on: the dispatcher's own access checks decide it.
 */
export function noteRunCallTool(dispatch, allowedNames, workspaceContext = null) {
  const allowed = new Set(Array.isArray(allowedNames) ? allowedNames : []);
  return async (name, args) => {
    if (!allowed.has(name)) return { isError: true, content: [{ type: "text", text: `The note run only reads: ${name} can't be used.` }] };
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const { context: named, ...rest } = given;
    const context = typeof named === "string" && named !== "" ? named : workspaceContext;
    return await dispatch(name, typeof context === "string" && context !== "" ? { ...rest, context } : rest);
  };
}

/** The highlighted words with the words either side, or the point in the note when no words are highlighted. */
function anchorOf(anchor) {
  const text = clip(anchor?.text, RUN_ASK_CHARS);
  const before = tail(anchor?.before, RUN_SIDE_CHARS);
  const after = clip(anchor?.after, RUN_SIDE_CHARS);
  if (text === "") return `The person pointed at a point in the note, not at words. Just before it: "${before}". Just after it: "${after}".`;
  return `The person highlighted these words: "${text}". They sit in: "...${before}${text}${after}...".`;
}

/** The thread so far, the newest lines last, each line capped. */
function threadOf(history) {
  const lines = (Array.isArray(history) ? history : []).slice(-RUN_THREAD_LINES).map((line) => `- ${clip(line?.who, 80) || "someone"}: ${clip(line?.body, RUN_LINE_CHARS)}`);
  return lines.length > 0 ? lines.join("\n") : "(no comments yet)";
}

/**
 * What the model is asked: Tex inside a note's thread, the note, the highlight, the thread, the pending suggestion, the
 * asker's Tex chat, who reads the note, and the one shape the answer takes.
 */
export function noteRunQuestion({ path, noteText, anchor, ask, history, pending, chatHistory, audience }) {
  return [
    "This is Tex inside a note's comment thread, not a text from a person. Nobody is texted: your answer is posted in the thread for the people who read the note.",
    `The note is ${str(path)}. Its words as they are now (up to ${RUN_NOTE_CHARS} characters):\n\n${clip(noteText, RUN_NOTE_CHARS)}`,
    anchorOf(anchor),
    `What the person asks: "${clip(ask, RUN_ASK_CHARS)}"`,
    `The comment thread so far:\n\n${threadOf(history)}`,
    `The suggestion Tex has pending for these words, not yet taken: ${typeof pending === "string" && pending !== "" ? `"${clip(pending, RUN_REPLACE_CHARS)}"` : "(none)"}`,
    `The asker's own recent Tex chat, the newest last (their words with Tex; use it only where the ask needs it):\n\n${chatHistory ? tail(chatHistory, RUN_CHAT_CHARS) : "(not read)"}`,
    `Who reads this note: ${str(audience) || "only the asker"}. Everyone who reads it sees your answer, so quote their private notes or the Tex chat only where the ask needs them.`,
    "You can read their notes with the tools you are given (read_note, search_notes and the rest), and you cannot write anything. Read a note before you name it.",
    'Answer with only a JSON object, nothing before or after it: {"answer": "one or two plain sentences", "replace": null or "the whole new text for the highlighted words", "insert": null or "new text to add right after the highlighted words"}. ' +
      "Tag Tex on words to work on the note with you. When the ask wants something written (an outline, a list, a draft, a fix, the next part, more detail), do it in the note: " +
      "replace when the highlighted words themselves should change (give their whole new text, not a diff), insert when the new words belong after them and the highlighted words stay. " +
      "Only a question about the note or the world (who, why, when, is this right, how would we) gets an answer with both null. The answer then says what you did in a sentence; it never repeats the text you put in the note. " +
      "A follow-up such as \"add it to the note\" or \"put that in\" means the text you gave in the thread: insert it. " +
      "With a point in the note and no words highlighted, insert is the text to add at that point.",
    "Examples (invented people and words, for the shape only):\n" +
      '- Highlighted "Team offsite in March", asked "give me a rough agenda here": {"answer": "Added a rough agenda under it.", "replace": null, "insert": "1. Morning: where we are\\n2. Lunch\\n3. Afternoon: the next three bets"}\n' +
      '- Highlighted "recieve the keys on friday", asked "fix this": {"answer": "Fixed the spelling.", "replace": "receive the keys on Friday", "insert": null}\n' +
      '- Highlighted "Budget: $4,000", asked "who set this number?": {"answer": "Priya set it in the March planning note.", "replace": null, "insert": null}',
  ].join("\n\n");
}

/**
 * The model's answer as `{ answer, replace, insert }`. The JSON object is read from anywhere in the words; a string
 * answer of 1500 characters or fewer and a string replacement or insert of 20000 or fewer are kept, and anything else is
 * the raw words. An insert beside a replacement is dropped: the replacement already says the words' whole new text.
 */
export function parseNoteRun(answer) {
  const text = str(answer).trim();
  const raw = { answer: text.slice(0, RUN_ANSWER_CHARS), replace: null, insert: null };
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return raw;
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return raw;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return raw;
  const answerOk = typeof value.answer === "string" && value.answer.trim() !== "" && value.answer.length <= RUN_ANSWER_CHARS;
  const edit = (field) => field === undefined || field === null || (typeof field === "string" && field.length <= RUN_REPLACE_CHARS);
  if (!answerOk || !edit(value.replace) || !edit(value.insert)) return raw;
  const replace = typeof value.replace === "string" ? value.replace : null;
  const insert = replace === null && typeof value.insert === "string" && value.insert.trim() !== "" ? value.insert : null;
  return { answer: value.answer.trim(), replace, insert };
}

/**
 * The whole new text for the anchor when Tex adds after the highlighted words: the words as they are, then the
 * addition, on its own paragraph when either is a block (a line of its own, or more than one line), else after a
 * space. With no words highlighted the addition is the text at the point. The client keeps one suggestion shape, the
 * anchor's new text, and draws the kept words unstruck.
 */
export function withInsert(anchor, insert) {
  const words = str(anchor?.text);
  if (words === "") return insert;
  const after = str(anchor?.after);
  const block = /\n/.test(insert.trim()) || after === "" || after.startsWith("\n") || /^\s*([-*+]|\d+[.)]|#)\s/.test(insert);
  return `${words}${block ? "\n\n" : " "}${insert.replace(/^\s+/, "")}`;
}

/** A tool step as a person reads it: `{ label, source }`, where `source` is the note's path when a note was read. */
export function stepLabel(event) {
  const name = str(event?.name);
  const args = event?.args && typeof event.args === "object" && !Array.isArray(event.args) ? event.args : {};
  const target = str(args.path ?? args.id).replace(/^\/+/, "");
  if (target === TEXTS_FILE || name === READ_DAY) return { label: "Checking your texts", source: null };
  if (name === "read_note" && typeof args.path === "string" && args.path !== "") return { label: `Reading ${noteName(args.path)}`, source: args.path };
  if (name === "search_notes") return { label: "Searching your notes", source: null };
  if (name === "related_notes") return { label: "Looking at notes beside this one", source: null };
  if (/mail/i.test(name)) return { label: "Reading your email", source: null };
  if (/calendar/i.test(name)) return { label: "Checking your calendar", source: null };
  if (name === "search_web" || name === "open_page") return { label: "Looking on the web", source: null };
  if (WEB_READS.has(name)) return { label: "Looking things up", source: null };
  return { label: name === "" ? "Working" : `Using ${name.replaceAll("_", " ")}`.slice(0, 60), source: null };
}

/** The asker's 1:1 Tex chat, read the way the front door reads its week, or "" when it is not there or not read in time. */
async function chatOf(ledger, { now, timeZone, session }) {
  if (ledger === null || ledger === undefined) return "";
  let timer;
  const week = await Promise.race([
    Promise.resolve()
      .then(() => weekTurn({ ledger, chat: ONE_TO_ONE_CHAT, now, timeZone: timeZone ?? DEFAULT_TIME_ZONE, reads: RUN_READS, grant: carryKey(session), log: () => {} }))
      .catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), RUN_CHAT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  return typeof week?.history?.text === "string" ? week.history.text : "";
}

/**
 * May this run spend the built-in model? As `openProvider` (`turn.js`) asks for a text, but said as a note run: the
 * app's own grant may spend one (`apps/convex/functions/builtinModel.ts`), counted on the same cap.
 */
async function openNoteRunModel(controlPlane, session, env) {
  if (!hasBuiltinModel(env)) throw new AgentRefusal("no_provider", "No model is available for this run.");
  const verdict = await controlPlane.startBuiltinTurn(session.accessToken, session.workspaceId, { noteRun: true });
  if (verdict?.allowed === true) return;
  if (verdict?.reason === "daily_cap") throw new AgentRefusal("daily_limit", "Today's questions are used up.");
  throw new AgentRefusal("no_provider", "No model is available for this run.");
}

/**
 * Run Tex in a note: `{ outcome, answer, replace, sources, calls, model, usage, ms }`, where outcome is "answered", or a
 * refusal ("daily_limit", "no_provider", "model_unavailable"). Writes nothing: not the note, not the thread, not the
 * ledger. `onStep({ id, label, state, ms?, source? })` is told as each read starts ("running") and ends ("done").
 * `workspace` is the run's workspace ("@name"), or null for the asker's own.
 */
export async function runNoteRun({ env, controlPlane, session, dispatch, offered, ledger = null, workspace = null, path, noteText, anchor, ask, history = [], pending = null, audience, node = null, now = Date.now(), timeZone, onStep = null, noteReadMs = null }) {
  const started = Date.now();
  try {
    await openNoteRunModel(controlPlane, session, env);
  } catch (error) {
    if (error instanceof AgentRefusal) return { outcome: error.code === "daily_limit" ? "daily_limit" : "no_provider" };
    return { outcome: "model_unavailable" };
  }
  const wanted = typeof node?.model === "string" ? TEX_CONFIG.models?.[node.model] : null;
  const chosen = typeof wanted === "string" && canRunBuiltin(wanted, env) ? wanted : null;
  const model = chosen ?? builtinModel(env);
  const meter = builtinMeter(controlPlane, session, model, now, { noteRun: true });
  const rounds = node?.rounds ?? RUN_ROUNDS;
  const say = (step) => {
    if (typeof onStep !== "function") return;
    try {
      onStep(step);
    } catch {
      // A step that failed to show costs the step, never the run.
    }
  };
  // Every step said is one that ran: the note (read by the caller, with its own time), the Tex chat and the model's work.
  const noteLabel = `Reading ${noteName(path)}`;
  say({ id: "step-note", label: noteLabel, state: "running", source: path });
  say({ id: "step-note", label: noteLabel, state: "done", ms: Number.isFinite(noteReadMs) ? noteReadMs : 0, source: path });
  let chatHistory = "";
  if (ledger !== null && ledger !== undefined) {
    const chatStarted = Date.now();
    say({ id: "step-chat", label: "Checking your texts", state: "running" });
    chatHistory = await chatOf(ledger, { now, timeZone, session });
    say({ id: "step-chat", label: "Checking your texts", state: "done", ms: Date.now() - chatStarted });
  }

  // Steps: a read starts here ("running") and `observe` reports it finished ("done"), matched by name in order.
  const allowed = noteRunTools(offered).map((tool) => tool.name);
  const callTool = noteRunCallTool(dispatch, allowed, workspace);
  const open = [];
  const readPaths = [];
  const calls = [];
  let counter = 0;
  const tracked = async (name, args) => {
    if (!allowed.includes(name)) return callTool(name, args);
    const { label, source } = stepLabel({ name, args });
    const id = `step-${++counter}`;
    open.push({ id, name, label, source });
    say({ id, label, state: "running", ...(source ? { source } : {}) });
    return callTool(name, args);
  };
  const observe = (event) => {
    if (event?.kind !== "tool") return;
    const name = str(event.name);
    calls.push({ tool: name, args: JSON.stringify(event.args ?? {}).slice(0, 300), ok: event.ok !== false });
    if (name === "read_note" && event.ok !== false && typeof event.args?.path === "string") readPaths.push(event.args.path);
    const at = open.findIndex((entry) => entry.name === name);
    if (at === -1) return;
    const [entry] = open.splice(at, 1);
    say({ id: entry.id, label: entry.label, state: "done", ms: Number.isFinite(event.ms) ? event.ms : 0, ...(entry.source ? { source: entry.source } : {}) });
  };
  const sourcesOf = () => [...new Set([path, ...readPaths, ...(chatHistory !== "" ? ["Tex chat"] : [])])].filter((source) => typeof source === "string" && source !== "");

  let turn;
  const thinking = Date.now();
  say({ id: "step-think", label: "Thinking", state: "running" });
  try {
    turn = await runTurn({
      question: noteRunQuestion({ path, noteText, anchor, ask, history, pending, chatHistory, audience: audience ?? "only the asker" }),
      tools: noteRunTools(offered),
      grants: { write: [] },
      callTool: tracked,
      sandboxedBelow: true, // reads only, refused above before the session's dispatcher
      env,
      builtinModelOverride: chosen,
      providerOptions: { ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "note_run" } },
      localNow: { now, timeZone },
      observe,
      maxRounds: rounds,
      roundCap: Math.max(rounds, RUN_ROUNDS),
    });
  } catch (error) {
    say({ id: "step-think", label: "Thinking", state: "done", ms: Date.now() - thinking });
    await meter(null, true, error instanceof ProviderError ? error.model : model);
    if (!(error instanceof ProviderError)) throw error;
    return { outcome: "model_unavailable", model: error.model ?? model, sources: sourcesOf(), calls, ms: Date.now() - started };
  }
  await meter(turn.usage, false, turn.model);
  const parsed = parseNoteRun(turn.answer);
  const replace = parsed.replace ?? (parsed.insert !== null ? withInsert(anchor, parsed.insert) : null);
  const label = parsed.replace !== null ? "Editing the selected words" : parsed.insert !== null ? (str(anchor?.text) === "" ? "Writing it into the note" : "Adding below the selected words") : "Writing the answer";
  say({ id: "step-think", label, state: "done", ms: Date.now() - thinking });
  return { outcome: "answered", answer: parsed.answer, replace, sources: sourcesOf(), calls, model: turn.model, usage: turn.usage ?? null, ms: Date.now() - started };
}
