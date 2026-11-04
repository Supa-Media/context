/**
 * TEX'S ADVISOR PLANS A BIG ASK (Dev, 2026-11-04: "if something is a big
 * task, it should ask the advisor to plan for it, and the advisor should
 * create the notes and stuff and tell the regular haiku to give the notes to
 * whatever background workers it thinks best").
 *
 * The everyday model calls `plan_big_ask` when an ask has parts that could
 * run side by side. The advisor (the setup's `models.advisor`) reads the
 * conversation, the free job slots and the person's computers, and answers
 * with a plan as JSON: one piece of work ("do it now" or "one job"), or two
 * or more parts, each with a name, a brief, what done means and where it
 * runs. Then the gateway, not either model, does the rest in one call: it
 * writes the project's overview note and one task note per part through the
 * turn's own dispatcher (every write the turn's grant could make, and no
 * other), and starts one background job per part, each joined to the
 * overview's mail (`background.js` `call`), so the turn texts one "on it".
 *
 * The model only names parts. The gateway caps them at the free slots, keeps
 * the notes inside the one folder the turn named, never writes over a note
 * already there, and starts nothing when a note could not be written. A
 * setup offers it only with `plan_big_asks: on` and an advisor
 * (`production.js`): nothing switches over until the splitting bench
 * (`bench/ai/tests/splitting.md`) says it should.
 */

import { advisorThinking } from "./advisor.js";

export const PLAN_TOOL = "plan_big_ask";
/** A part's name in the overview's mail: the mail's own name rule (`packages/shared/src/mail.cjs`). */
const PART_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
const MAX_TITLE = 80;
const MAX_BRIEF = 2_000;
const MAX_DONE = 300;
const MAX_FOLDER = 200;
const MAX_ASK = 4_000;
/** Of the conversation, the newest part the planner reads. */
const MAX_HISTORY_CHARS = 30_000;

export const PLAN_DEFINITION = {
  name: PLAN_TOOL,
  description:
    "For a big ask with parts that could run at the same time (research several options, plan a trip end to end, build and write up " +
    "something in pieces): your advisor plans it, writes the project's overview note and one task note per part in the folder you name, " +
    "and starts one background job per part on the free slots, each joined to the overview's mail. It may answer that the ask is one " +
    "piece of work instead: then do what it says. Never for a question, a lookup, one note, one email or a reminder.",
  inputSchema: {
    type: "object",
    properties: {
      ask: { type: "string", description: "The whole ask in their words, with every fact you already found that the parts need." },
      folder: { type: "string", description: "The new project's folder in their workspace, following its index (\"1-projects/lisbon-trip/\")." },
    },
    required: ["ask", "folder"],
  },
};

export const PLANNER_PROMPT =
  "You plan work for Tex, a texting assistant that can run background jobs side by side. Below are the conversation, the ask, how many job " +
  "slots are free now and the person's computers. Decide whether the ask splits.\n\n" +
  "It does not split when it is one piece of work: a question, a lookup, one note or email, a reminder, a short task, or steps where each " +
  "needs the one before. Then reply with JSON only: {\"split\": false, \"how\": \"now\" or \"one_job\", \"why\": \"one sentence\", \"computer\": null or a computer's name}. " +
  "\"now\" is for anything Tex can finish in this turn; \"one_job\" is for long work that does not split.\n\n" +
  "It splits when two or more parts can run at once and each is real work on its own. Then reply with JSON only: " +
  "{\"split\": true, \"title\": \"the project in a few words\", \"goal\": \"what the whole ask is for, one or two sentences\", " +
  "\"parts\": [{\"name\": \"short-lowercase-name\", \"title\": \"a few words\", \"brief\": \"what this part does, with every fact it needs\", " +
  "\"done_when\": \"one line\", \"computer\": null or a computer's name}]}. Never more parts than free slots; when there are more pieces " +
  "than slots, or than a computer's slots for its parts, group them. What a computer with Claude Code or Codex is good at always runs on one when they " +
  "have one, never in the cloud: code (a question about how a codebase works, theirs or a public one on GitHub; reading or searching a repo; every change " +
  "to their code) and heavy computing (running scripts, crunching big data or many files, builds, long analysis), and anything on their own machine. A small " +
  "code change is one job on a computer, not a split; a big one (several pieces of a feature that can be built at once) splits into parts on the computer. " +
  "Everything else prefers the cloud (null), so their computer's slots stay free for that work. " +
  "Each part's brief names the parts it must tell or ask through the overview's mail. Never invent a fact that is not in the conversation.";

const clip = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const oneLine = (value, max) => clip(value, max * 2).replace(/\s+/g, " ").slice(0, max);
const text = (words, isError = false) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/** `plan_big_asks` in a setup: true for on, false for off or absent, null for anything else (the file is refused). */
export function readPlanSetting(value) {
  if (value === undefined || value === "off" || value === false) return false;
  if (value === "on" || value === true) return true;
  return null;
}

/** The folder the turn named, as a relative folder ending in `/`, or null when it climbs out or is not a folder. */
export function planFolder(value) {
  const folder = clip(value, MAX_FOLDER).replace(/^\/+/, "").replace(/\/*$/, "/");
  if (folder === "/" || /[\u0000-\u001f\\]/.test(folder) || folder.startsWith("@")) return null;
  if (folder.split("/").slice(0, -1).some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) return null;
  return folder;
}

/**
 * The advisor's answer read strictly: `{split: false, how, why}`, `{split: true, title, goal, parts}` with at most
 * `slots` parts of unique names, or null. A computer that isn't one of theirs runs the part in the cloud.
 */
export function parsePlan(answer, { slots, computers = [] }) {
  const raw = typeof answer === "string" ? answer : "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let value;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.split === false) {
    const known = new Map(computers.map((computer) => [String(computer.name).toLowerCase(), computer.name]));
    const computer = value.how === "one_job" && typeof value.computer === "string" ? (known.get(value.computer.trim().toLowerCase()) ?? null) : null;
    return { split: false, how: value.how === "one_job" ? "one_job" : "now", why: oneLine(value.why, 300), ...(computer ? { computer } : {}) };
  }
  if (value.split !== true || !Array.isArray(value.parts)) return null;
  const names = new Set();
  const known = new Map(computers.map((computer) => [String(computer.name).toLowerCase(), computer.name]));
  const parts = [];
  for (const part of value.parts) {
    if (!part || typeof part !== "object") continue;
    const name = clip(part.name, 40).toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 24);
    const title = oneLine(part.title, MAX_TITLE);
    const brief = clip(part.brief, MAX_BRIEF);
    if (!PART_NAME.test(name) || name === "everyone" || name === "overview" || names.has(name) || title === "" || brief === "") continue;
    names.add(name);
    const computer = typeof part.computer === "string" ? (known.get(part.computer.trim().toLowerCase()) ?? null) : null;
    parts.push({ name, title, brief, doneWhen: oneLine(part.done_when, MAX_DONE), computer });
  }
  const kept = parts.slice(0, Math.max(0, slots));
  if (kept.length === 0) return null;
  return { split: true, title: oneLine(value.title, MAX_TITLE) || kept[0].title, goal: oneLine(value.goal, 600), parts: kept };
}

/** The project's overview note: the goal, the parts with their notes, and the mail every part's job joins. */
export function overviewNote(plan, ask, folder) {
  const lines = plan.parts.map((part) => `- [[${folder}${part.name}|${part.title}]] (${part.name}${part.computer ? `, on ${part.computer}` : ""}): ${part.doneWhen || "see its note"}`);
  return (
    `# ${plan.title}\n\n` +
    (plan.goal ? `${plan.goal}\n\n` : "") +
    `## The ask\n\n${clip(ask, MAX_ASK)}\n\n` +
    `## Parts\n\nEach part runs as its own background job at the same time, and they tell and ask each other in this note's mail.\n\n${lines.join("\n")}\n`
  );
}

/** One part's task note: what it does, when it is done, where it runs. */
export function partNote(part, overviewPath) {
  return (
    `# ${part.title}\n\n` +
    `Part of [[${overviewPath.replace(/\.md$/, "")}|the overview]]; this part's name in its mail is ${part.name}.\n\n` +
    `## What it does\n\n${part.brief}\n\n` +
    `## Done when\n\n${part.doneWhen || "The brief above is done and its result is written here."}\n\n` +
    `## Runs on\n\n${part.computer ?? "the cloud"}\n`
  );
}

/** The conversation as the planner reads it: earlier texts, newest kept. */
function conversationText(history, question) {
  const lines = (Array.isArray(history) ? history : [])
    .map((entry) => (typeof entry?.text === "string" && entry.text.trim() ? `${entry.role === "assistant" ? "Tex" : "Them"}: ${entry.text.trim()}` : ""))
    .filter(Boolean);
  if (typeof question === "string" && question.trim()) lines.push(`Them: ${question.trim()}`);
  const body = lines.join("\n");
  return body.length > MAX_HISTORY_CHARS ? body.slice(-MAX_HISTORY_CHARS) : body;
}

/**
 * The tool's call for one turn: `(args, callTool) => result`, where
 * `callTool` is the turn's own dispatcher (`background.js` `withBackground`).
 *
 * @param {object} options
 * @param {string} options.model the setup's advisor
 * @param {string} [options.effort]
 * @param {Function} options.request `(params) => answer` (`advisor.js` `advisorRequest`)
 * @param {Function} [options.meter] `(usage, failed, model, whole)`
 * @param {Array} options.history the earlier texts the turn shows
 * @param {string} options.question their text
 * @param {{ freeSlots: () => number, call: Function, machines?: (() => Promise<Array>) | null }} options.background
 */
export function planCall({ model, effort, request, meter = async () => {}, history, question, background }) {
  let planned = false;
  return async (args, callTool) => {
    if (planned) return text("This turn already planned one big ask. Tell them what started.", true);
    const ask = clip(args?.ask, MAX_ASK);
    const folder = planFolder(args?.folder);
    if (ask === "" || folder === null) return text("Give the ask and a new folder for the project in their workspace (\"1-projects/name/\").", true);
    const slots = background.freeSlots();
    if (slots < 1) return text("Every job slot is taken. Tell them you'll start this once a job finishes, or do the part that's small now.", true);
    const computers = typeof background.machines === "function" ? await background.machines().catch(() => []) : [];
    const overviewPath = `${folder}overview.md`;
    const there = await callTool("read_note", { path: overviewPath }).catch(() => null);
    if (there && there.isError !== true) return text(`${overviewPath} is already a note. Pick a new folder for this project.`, true);
    planned = true;
    const brief =
      `<conversation>\n${conversationText(history, question) || "(none)"}\n</conversation>\n\n<ask>\n${ask}\n</ask>\n\n` +
      `Free job slots now: ${slots}.\n` +
      `Their computers: ${computers.length === 0 ? "none (every part runs in the cloud)" : computers.map((each) => `${each.name}${each.online ? "" : " (offline)"} (${(each.tools ?? []).join(", ") || "no coding tool"}${Number.isSafeInteger(each.slots) ? `, ${each.slots} slots` : ""})`).join("; ")}.`;
    let answer;
    try {
      answer = await request({ model, system: PLANNER_PROMPT, messages: [{ role: "user", text: brief }], tools: [], display: "summarized", ...(effort ? { effort } : {}) });
    } catch {
      await meter(null, true, model, false);
      return text("Your advisor couldn't plan it. Start one background job for the whole ask instead.", true);
    }
    await meter(answer?.usage ?? null, false, model, false);
    const thinking = advisorThinking(answer);
    const plan = parsePlan(answer?.text, { slots, computers });
    const withThought = (result) => (thinking ? { ...result, thinking } : result);
    if (plan === null) return withThought(text("Your advisor's plan didn't come through. Start one background job for the whole ask instead.", true));
    if (!plan.split) {
      return withThought(
        text(
          plan.how === "one_job"
            ? `Your advisor says this is one piece of work: ${plan.why || "it doesn't split"}. Start one background job for it, with no mail` +
              (plan.computer ? `, on_computer { name: "${plan.computer}" }.` : ", in the cloud.")
            : `Your advisor says this doesn't need jobs: ${plan.why || "it's small"}. Do it now yourself.`,
        ),
      );
    }
    // Every note first: a part whose note didn't land never starts.
    for (const [path, content] of [[overviewPath, overviewNote(plan, ask, folder)], ...plan.parts.map((part) => [`${folder}${part.name}.md`, partNote(part, overviewPath)])]) {
      const wrote = await callTool("write_note", { path, content }).catch(() => ({ isError: true }));
      if (wrote?.isError === true) return withThought(text(`Couldn't write ${path}, so nothing started. Start one background job for the whole ask instead.`, true));
    }
    const started = [];
    const failed = [];
    for (const part of plan.parts) {
      const result = await background.call({
        title: part.title,
        brief: `${part.brief}\n\nYour task note: ${folder}${part.name}.md. The project: ${overviewPath}.`,
        done_when: part.doneWhen,
        mail: { path: overviewPath, name: part.name },
        ...(part.computer ? { on_computer: { name: part.computer } } : {}),
      });
      (result?.isError === true ? failed : started).push(part.title);
    }
    if (started.length === 0) return withThought(text(`The notes are in ${folder}, but no part could start. Tell them, in a line.`, true));
    return withThought(
      text(
        `Started ${started.length} parts at once in ${folder}: ${started.join("; ")}.` +
          (failed.length > 0 ? ` Couldn't start: ${failed.join("; ")}.` : "") +
          " They're told so; send nothing more.",
      ),
    );
  };
}

/**
 * A LONE JOB IS OFFERED THE PLANNER ONCE (the splitting bench, gh-149: with
 * the planner offered, the everyday model still started the Lisbon week, three
 * parts that run side by side, as one job in four answers of four).
 *
 * With the planner on and two or more slots free, the turn's first job started
 * by the model itself, with no mail, is answered with the choice instead of
 * starting: a big ask with parts goes to `plan_big_ask`; one piece of work is
 * started by the same call again, which then goes through. The planner's own
 * parts carry mail and are never asked, and nor is a job after the planner was called. Call it once `background.plan` is set; it
 * changes `background.call` and `background.plan` in place.
 */
export function splitFirst(background) {
  const start = background.call;
  let asked = false;
  background.call = async (args) => {
    const lone = !args?.mail && background.started.length === 0 && background.freeSlots() >= 2;
    if (asked || !lone) return start(args);
    asked = true;
    return text(
      "Not started yet. Does this ask have parts that can run at the same time, each real work on its own (say dinners, a day trip and a " +
        "packing list, or a shoe comparison, a physio and a plan)? Then call plan_big_ask once with the whole ask and a new folder for the " +
        "project in their projects folder, and start nothing yourself. If it is truly one piece of work, call start_background_job again the same way.",
      true,
    );
  };
  // A turn that went to the planner already chose: its one-job answer starts at once.
  const plan = background.plan;
  if (typeof plan === "function") background.plan = (args, callTool) => ((asked = true), plan(args, callTool));
  return background;
}

/** Told to the everyday model when the planner is offered: it, not a run of job starts, is how a big ask splits. */
export const PLAN_HINT =
  "\n\nA big ask with parts that can run at the same time goes to send with action plan (plan_big_ask), never to several background jobs you start yourself: your advisor " +
  "plans it, the notes are written and the parts start together. Find the facts the parts need first, then call it once. A question, " +
  "a lookup, one note, one email or a reminder is never a big ask.";
