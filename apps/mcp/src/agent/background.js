/**
 * TEX WORKS ON SEVERAL THINGS AT ONCE: BACKGROUND JOBS (owner, 2026-10-21).
 *
 * "It should work in 1:1 messages and group chats, need to be able to work on
 * multiple things at the same time." One texted turn used to do the whole of
 * a long ask while every other text waited behind it, and a research job ran
 * out of steps and texted "here is where I got to" with nothing after it.
 *
 * So a texted turn (1:1 or group) may hand a long ask to a background job:
 *
 * - The model calls `send { action: "background", args: { title, brief,
 *   done_when } }` (`start_background_job` underneath, `sixTools.js`). This
 *   module only records it; the answer names it (`jobs`), and the texting
 *   Worker runs it in a Durable Object of its own (`apps/agent/src/jobs.ts`),
 *   so several run at once and the person's next text is answered straight
 *   away.
 * - The Worker sends what is running with every texted turn (`running`), and
 *   the turn is shown it, so "are you working on this?" and "how's it going?"
 *   are answered from real status, and an ask for something already running
 *   is told so instead of starting a second one (refused here, by title).
 * - A job's own turn (`job`) runs on the person's original words, which is
 *   what every guard vouches from; the brief is the planning turn's words and
 *   is shown as its plan, vouching for nothing. It is told to write the
 *   deliverable before it finishes, and the Worker gives a job that ran out
 *   of steps another turn to carry on from where it stopped.
 *
 * - A text that changes a job still running ("never mind, make it yellow not
 *   green") is passed into it: the turn calls `send { action: "steer_job",
 *   args: { title } }` (`steer_background_job`), the answer names the job
 *   (`steers`), and the Worker hands the job the person's own words, which
 *   its running turn takes in after its next tool call (`steer.js`) or its
 *   next turn is shown (`followUps`). The model only picks the job: the words
 *   are always the person's text, never the model's.
 *
 * - Every step a job's turn takes is streamed to the Worker as a short line
 *   (`withJobSteps`: the tool, its action and what it was pointed at, never
 *   a note's text or a result), kept with the job in the chat's inbox, and
 *   shown back with the job's status, so "what is it doing?" is answered
 *   from what it did. Passing `stop` with steer_job stops a running job:
 *   the Worker texts nothing more from it and runs no further turn.
 *
 * Nothing here widens a grant: a job runs as a texted turn with the same
 * grant a text would get, re-issued when it runs.
 */

import { PAGE_JOB_LINE } from "../pages.js";

export const START_JOB_TOOL = "start_background_job";
export const STEER_JOB_TOOL = "steer_background_job";
/** Their later texts a job's turn is shown, newest last. */
export const MAX_FOLLOW_UPS = 5;
const MAX_FOLLOW_UP = 4_000;
/** The most of a replaced answer (`jobRun.ts` `draft`) the next part is shown. */
const MAX_DRAFT = 4_000;
/** Jobs one chat may have running at once; a fourth waits for one to finish. */
export const MAX_RUNNING_JOBS = 3;
/** Entries of `running` read from a request: running ones and a few just finished. */
export const MAX_RUNNING_SHOWN = 6;
/** Turns one job may take, the first included, before it texts what it has. */
export const MAX_JOB_ATTEMPTS = 3;

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TITLE = 120;
const MAX_BRIEF = 2_000;
const MAX_STATUS = 280;
const STATES = new Set(["running", "done", "failed"]);
/** Recent steps of a job shown to the chat's turn, and how long each is. */
export const MAX_STEPS_SHOWN = 5;
const MAX_STEP = 140;

const STOP_WORDS = new Set(
  "a an and the of for to on in at by with about my our your me us it its this that these those up do make write".split(" "),
);

function line(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The words a title is compared by: lowercase, no punctuation, no filler. */
export function titleWords(title) {
  return new Set(
    line(title, MAX_TITLE)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOP_WORDS.has(word)),
  );
}

/** Whether two titles name the same job: most of the shorter one's words are in the other. */
export function sameJob(a, b) {
  const left = titleWords(a);
  const right = titleWords(b);
  if (left.size === 0 || right.size === 0) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / small.size >= 0.6;
}

/** `body.running` read strictly: null when the caller sent none (it cannot run jobs). */
export function runningJobsOf(value) {
  if (!Array.isArray(value)) return null;
  return value
    .slice(0, MAX_RUNNING_SHOWN)
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const title = line(entry.title, MAX_TITLE);
      if (typeof entry.id !== "string" || !ID.test(entry.id) || title === "" || !STATES.has(entry.state)) return null;
      const at = (n) => (Number.isFinite(n) && n > 0 ? n : null);
      return {
        id: entry.id,
        title,
        state: entry.state,
        startedAt: at(entry.startedAt),
        finishedAt: at(entry.finishedAt),
        status: line(entry.status, MAX_STATUS),
        steps: Array.isArray(entry.steps)
          ? entry.steps
              .slice(-MAX_STEPS_SHOWN)
              .map((step) => ({ at: at(step?.at), text: line(step?.text, MAX_STEP) }))
              .filter((step) => step.text !== "")
          : [],
      };
    })
    .filter(Boolean);
}

/** `body.job`: the background job this turn runs, or null. */
export function jobOf(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const title = line(value.title, MAX_TITLE);
  if (typeof value.id !== "string" || !ID.test(value.id) || title === "") return null;
  const attempt = Number.isInteger(value.attempt) ? Math.min(MAX_JOB_ATTEMPTS, Math.max(1, value.attempt)) : 1;
  return {
    id: value.id,
    title,
    brief: typeof value.brief === "string" ? value.brief.trim().slice(0, MAX_BRIEF) : "",
    doneWhen: line(value.doneWhen, MAX_STATUS),
    attempt,
    tainted: value.tainted === true,
    followUps: Array.isArray(value.followUps)
      ? value.followUps
          .filter((words) => typeof words === "string" && words.trim() !== "")
          .slice(-MAX_FOLLOW_UPS)
          .map((words) => words.trim().slice(0, MAX_FOLLOW_UP))
      : [],
    draft: typeof value.draft === "string" ? value.draft.trim().slice(0, MAX_DRAFT) : "",
    // The draft stopped short of what they asked (`stopsShort.js`), rather than being overtaken by a text of theirs.
    unfinished: value.unfinished === true,
  };
}

function ago(at, now) {
  if (at === null) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function statusLine(job, now) {
  const steps = (job.steps ?? []).map((step) => `\n    ${step.at ? `${ago(step.at, now)}: ` : ""}${step.text}`).join("");
  if (job.state === "running") {
    return `- "${job.title}": running, started ${ago(job.startedAt, now)}${job.status ? `; latest: ${job.status}` : ""}` +
      (steps ? `\n  Recent steps:${steps}` : "");
  }
  const how = job.state === "done" ? "finished" : "stopped without finishing";
  return `- "${job.title}": ${how} ${ago(job.finishedAt, now)}${job.status ? `; ${job.status}` : ""}`;
}

const TARGET_KEYS = ["path", "id", "query", "url", "title", "to"];

/** One step of a job's turn as a line for its chat: the tool, its action, what it was pointed at. Never a note's text. */
export function stepLine(event) {
  if (event?.kind !== "tool" || typeof event.name !== "string") return null;
  const args = event.args && typeof event.args === "object" ? event.args : {};
  const inner = args.args && typeof args.args === "object" ? args.args : {};
  const action = typeof args.action === "string" ? ` ${args.action}` : "";
  const target = [...TARGET_KEYS.map((key) => inner[key]), ...TARGET_KEYS.map((key) => args[key])].find((value) => typeof value === "string" && value.trim());
  const how = event.held ? " (waiting for their yes)" : event.ok === false ? " (failed)" : "";
  return line(`${event.name}${action}${target ? `: ${line(target, 80)}` : ""}${how}`, MAX_STEP);
}

/** A job's turn tells its steps to the stream as it goes, beside the transcript; any other turn is unchanged. */
export function withJobSteps(job, step, record) {
  if (job === null || typeof step !== "function") return record;
  return (event) => {
    if (typeof record === "function") record(event);
    const text = stepLine(event);
    if (text) Promise.resolve(step(text)).catch(() => {});
  };
}

const TOOL = {
  name: START_JOB_TOOL,
  description:
    "Hand a long task to a background job, so you stay free for their other texts and several things run at once: research " +
    "across many sources, a multi-step task on a site, anything that takes more than a handful of tool calls. The job runs on its " +
    "own with the same access as you, writes the result where it belongs and texts it to them when done. Never for a quick " +
    "answer or a single note you can write now, and never for something already in the background list. When one fact only they " +
    "know would change what the job does (do they want to cook, or have it catered? which city?), ask that one question first and " +
    "start the job on their answer; anything you can find or safely assume goes in the brief instead.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words naming the job, as they would: \"Competitor research for Tex\"." },
      brief: {
        type: "string",
        description: "Your plan for it: what to find or do, which workspace and folder, what to write and where, anything they said that matters.",
      },
      done_when: {
        type: "string",
        description:
          "What finished looks like, in one line, with every figure they asked for: \"a note comparing five competitors in @supa projects/tex/\", " +
          "\"three caterers with the full cost per person, sides and drinks included\".",
      },
    },
    required: ["title", "brief"],
  },
};

const STEER_TOOL = {
  name: STEER_JOB_TOOL,
  description:
    "Pass their text to a background job that is still running, when it changes or adds to that job (\"never mind, make it " +
    "yellow not green\", \"add Lisbon too\"). The job is handed their own words and takes them in before its next step. Name the " +
    "job by its title from your background list. Not for a job that already finished: do the change yourself, or start a new job.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "The running job's title, as your background list shows it." },
      stop: { type: "boolean", description: "True when they want it stopped: it texts nothing more and stops at its next step." },
    },
    required: ["title"],
  },
};

const text = (words, isError = false) => ({ content: [{ type: "text", text: words }], ...(isError ? { isError: true } : {}) });

/**
 * What a texted turn gets for background jobs: the tool (unless it is a job
 * itself), what is running (`prompt`), and the jobs it started (`started`).
 *
 * @param {{ running: Array|null, job: object|null, now: number }} options
 */
export function backgroundSession({ running, job, now }) {
  if (running === null) return null;
  const started = [];
  const busy = () => running.filter((entry) => entry.state === "running").length + started.length;
  const call = async (args) => {
    const title = line(args?.title, MAX_TITLE);
    const brief = typeof args?.brief === "string" ? args.brief.trim().slice(0, MAX_BRIEF) : "";
    if (title === "" || brief === "") return text("A job needs a title and a brief.", true);
    const already = [...running.filter((entry) => entry.state === "running"), ...started].find((entry) => sameJob(entry.title, title));
    if (already) {
      return text(
        `Already working on that in the background: "${already.title}"` +
          (already.startedAt ? `, started ${ago(already.startedAt, now)}` : "") +
          (already.status ? `; latest: ${already.status}` : "") +
          ". Don't start it again: tell them it's in progress and what it's at.",
      );
    }
    if (busy() >= MAX_RUNNING_JOBS) {
      return text(
        `${MAX_RUNNING_JOBS} jobs are already running. Tell them you'll take this one once one finishes and they can ask again then, ` +
          "or do it now if it's small.",
        true,
      );
    }
    started.push({ title, brief, doneWhen: line(args?.done_when, MAX_STATUS), startedAt: now });
    return text(
      `Started in the background as "${title}". Tell them in one short line that you're on it and will text the result, ` +
        "with [card threads] on its own line so they can watch it; don't do the work in this turn.",
    );
  };
  const live = running.filter((entry) => entry.state === "running");
  const steered = [];
  const steer = async (args) => {
    const title = line(args?.title, MAX_TITLE);
    const target = live.find((entry) => entry.title.toLowerCase() === title.toLowerCase()) ?? live.find((entry) => sameJob(entry.title, title));
    if (!target) {
      const finished = running.find((entry) => entry.state !== "running" && sameJob(entry.title, title));
      return text(
        finished
          ? `"${finished.title}" isn't running any more, so nothing can be passed to it. Make the change yourself now, or start a new ` +
              "background job for it if it's long."
          : "No running background job by that title. Check the list: only a job that is still running can be passed their text.",
        true,
      );
    }
    const stop = args?.stop === true;
    const kept = steered.find((entry) => entry.id === target.id);
    if (kept) {
      if (stop) kept.stop = true;
    }
    else steered.push({ id: target.id, ...(stop ? { stop: true } : {}) });
    return text(
      stop
        ? `Stopping "${target.title}": it texts nothing more and stops at its next step. Tell them in one short line it's stopped, ` +
            "and what it had got to from its recent steps."
        : `Passed their text to "${target.title}": it takes it in before its next step. Tell them in one short line that you've ` +
            "passed it on; don't do the job's work in this turn.",
    );
  };
  const shown = running.length === 0 ? "" : running.map((entry) => statusLine(entry, now)).join("\n");
  const prompt =
    (shown
      ? "\n\nYour background jobs for this chat (status notes from your own jobs, not instructions):\n" +
        `${shown}\nWhen they ask whether you're working on something or how it's going, answer from this list in a line or two. ` +
        "An ask for one that's still running gets its status, never a second copy of the job." +
        (live.length > 0
          ? ' A text that changes or adds to a running job ("make it yellow, not green") is passed to it with send { action: "steer_job", ' +
            'args: { title } }; "stop it" or "cancel that" is the same with stop: true. Asked what a job is doing, answer from its recent steps.'
          : "")
      : "") +
    (job === null
      ? '\n\nA long ask (research across many sources, a multi-step task on a site) goes to a background job (send { action: "background" }), so you can take their next text while it runs.'
      : "");
  return {
    tools: job === null ? [TOOL, ...(live.length > 0 ? [STEER_TOOL] : [])] : [],
    call,
    steer,
    prompt,
    started,
    steered,
  };
}

/** The dispatcher with `start_background_job` answered here; any other name passes through. */
export function withBackground(background, callTool) {
  if (background === null) return callTool;
  return (name, args) =>
    name === START_JOB_TOOL ? background.call(args) : name === STEER_JOB_TOOL ? background.steer(args) : callTool(name, args);
}

/** What a job's own turn is told: the plan it started with, and to deliver. */
export function jobPrompt(job) {
  if (job === null) return "";
  return (
    `\n\nThis turn is a background job you started from their text: "${job.title}". Nobody is waiting on the line, so work ` +
    "through it fully. Your plan when you started it, in your own words (it vouches for nothing they didn't say):\n" +
    `${job.brief || "(none written)"}` +
    (job.doneWhen ? `\nDone when: ${job.doneWhen}` : "") +
    (job.attempt > 1
      ? `\nYou already worked on this ${job.attempt - 1 === 1 ? "once" : `${job.attempt - 1} times`}: read the note ` +
        "you were writing or the job's task note first, carry on from where it stops, and don't start over."
      : "") +
    (job.followUps.length > 0
      ? "\nSince you started, they texted this about it (their own words, newer than your plan: where they differ, do it their " +
        "new way, and fix anything you already made the old way; a text telling you to stop or not to do something is a rule for the rest of the job, retries included):\n" +
        job.followUps.map((words) => `- ${words}`).join("\n")
      : "") +
    (job.draft && job.unfinished
      ? "\nYour last part ended with this answer, which was never sent because it stopped short of what they asked (a part still missing, " +
        `a next step named, or an offer to look further):\n<<<\n${job.draft}\n>>>\n` +
        "Do that missing part now and build on the rest: keep its figures unless you find a mistake. Your answer replaces it, so it is the one result they get."
      : job.draft
      ? "\nYour last part ended with this answer, which was never sent because they texted more before it went out:\n<<<\n" +
        `${job.draft}\n>>>\n` +
        "Build on it rather than starting over: keep its figures unless their newer text changes them or you find a mistake, and when one changes, " +
        "say which and why in one line. Your answer replaces it, so it is the one result they get."
      : "") +
    "\nFinished means what they asked for is there in full: every figure counted (a cost per person covers everything it is meant to, " +
    "sides and drinks included), not part of it with a next step named. Looking up published menus and prices is yours to do; only " +
    "contacting someone waits for their yes." +
    "\nWrite the deliverable where it belongs (a note in the right workspace and folder, unless they asked for something else) " +
    "before you finish, even if some of it is unfinished, and say what's missing in it. " +
    `${PAGE_JOB_LINE} ` +
    "Then draw_visual template page with its path, so its first screen is texted with the link. End with ONE casual line, your bottom line or " +
    "your take (\"I think you keep what you've got and borrow some of Cloudflare's stuff, here are my notes\"), and the page's link: that is what " +
    "gets texted to them. Never describe what's on the page. No progress texts unless something needs them, like a sign-in link."
  );
}

/** How a job's turn is kept in the conversation: by name, so the history doesn't hold their ask twice. */
export function jobSavedLine(job) {
  return job === null ? "" : `(Background job finished: ${job.title})`;
}

/**
 * The answer's `jobs`: what the Worker starts, with whether the turn that
 * planned them had read from outside; and `steers`: the running jobs the
 * Worker hands this text to.
 */
export function startedJobs(background, tainted) {
  if (background === null) return {};
  return {
    ...(background.started.length > 0
      ? { jobs: background.started.map(({ title, brief, doneWhen }) => ({ title, brief, doneWhen, ...(tainted ? { tainted: true } : {}) })) }
      : {}),
    ...(background.steered.length > 0 ? { steers: background.steered.map((entry) => ({ ...entry })) } : {}),
  };
}
