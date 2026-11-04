/**
 * A chat's background jobs, for its Tex page: read from the chat's inbox in
 * the texting Worker over the `TEXTING` binding (`TexRoutines.pageJobs`,
 * `apps/agent/src/texPage.ts`), and shaped as the page shows them. Used by the
 * page's routes and by the chat's Tex object while a page is open
 * (`texStore/pageLive.js`), so both say the same thing.
 *
 * Every word is Tex's own (a job's title, its status line, its steps: tool and
 * target, never a note's text).
 */

/** How many jobs run at once (`MAX_RUNNING_JOBS`, `apps/agent/src/jobs.ts`): the page's minion slots. */
export const SLOTS = 3;
/** The finished jobs the overview shows under "Earlier today". */
export const EARLIER_SHOWN = 2;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WORDS = 300;
const MAX_STEPS = 40;

const words = (value, max = MAX_WORDS) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const instant = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** The page's state words for the inbox's: a stuck job is shown as failed. */
function stateOf(job) {
  if (job.stopped === true) return "stopped";
  switch (job.state) {
    case "running":
    case "waiting":
    case "done":
    case "failed":
      return job.state;
    case "stuck":
      return "failed";
    default:
      return null;
  }
}

function stepsOf(job) {
  return (Array.isArray(job.steps) ? job.steps : [])
    .flatMap((step) => {
      const at = instant(step?.at);
      const text = words(step?.text);
      if (at === null || !text) return [];
      const failed = step.failed === true;
      const why = failed ? words(step.why, 160) : "";
      return [{ at, text, ...(failed ? { failed: true } : {}), ...(why ? { why } : {}) }];
    })
    .slice(-MAX_STEPS);
}

/** One job as the texting Worker answered it, checked field by field; null when it is not one. */
export function readJob(raw) {
  if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id)) return null;
  const title = words(raw.title, 160);
  const startedAt = instant(raw.startedAt);
  const state = stateOf(raw);
  if (!title || startedAt === null || state === null) return null;
  const endedAt = instant(raw.finishedAt);
  const status = words(raw.status, 200);
  const who = words(raw.for, 40);
  const result = words(raw.result, 1500);
  const on = machineOf(raw.on);
  return { id: raw.id, title, state, startedAt, ...(endedAt !== null ? { endedAt } : {}), ...(status ? { status } : {}), ...(who ? { for: who } : {}), ...(result ? { result } : {}), ...(on ? { on } : {}), steps: stepsOf(raw) };
}

const TOOL_NAMES = { claude: "Claude Code", codex: "Codex" };

/** The person's computer a job runs on, as the inbox names it (`{id, name, tool?}`); null in Tex's cloud. */
function machineOf(raw) {
  if (raw === null || typeof raw !== "object" || typeof raw.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(raw.id)) return null;
  const name = words(raw.name, 100) || "your computer";
  return { id: raw.id, name, ...(TOOL_NAMES[raw.tool] ? { tool: TOOL_NAMES[raw.tool] } : {}) };
}

/** The page's `JobSummary` for a read job (`slot` when it holds one). */
export function jobSummary(job, slot = null) {
  const failedSteps = job.steps.filter((step) => step.failed).length;
  const last = job.steps[job.steps.length - 1];
  return {
    id: job.id,
    title: job.title,
    state: job.state,
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    failedSteps,
    ...(job.state === "waiting" && job.status ? { needs: job.status } : {}),
    ...(job.state === "running" && last ? { now: last.text } : {}),
    ...(job.for ? { for: job.for } : {}),
    // Where it runs: the page's place key for the computer, and its name in words (`On Cloud VM`).
    ...(job.on ? { machine: job.on.id, machineName: job.on.name, ranOn: `On ${job.on.name}`, ...(job.on.tool ? { tool: job.on.tool } : {}) } : {}),
    ...(slot !== null ? { slot } : {}),
  };
}

/** The job page: the summary, every step, and what it came back with. */
export function jobDetail(job, slot = null) {
  return { ...jobSummary(job, slot), steps: job.steps, ...(job.result ? { result: { summary: job.result } } : {}) };
}

const live = (job) => job.state === "running" || job.state === "waiting";

/** Machine jobs a computer's slots are numbered for at most (its owner sets up to eight). */
const MACHINE_SLOTS = 8;

/**
 * Which slot each live job holds, numbered from 1 in the place it runs: Tex's
 * cloud's three, or each computer's own (a job on a computer never takes a
 * cloud slot: `apps/agent/src/jobs.ts`). The oldest first, as they were started.
 */
export function slotsOf(jobs) {
  const held = new Map();
  const taken = new Map();
  for (const job of jobs.filter(live).sort((a, b) => a.startedAt - b.startedAt)) {
    const place = job.on?.id ?? null;
    const next = (taken.get(place) ?? 0) + 1;
    if (next > (place === null ? SLOTS : MACHINE_SLOTS)) continue;
    taken.set(place, next);
    held.set(job.id, next);
  }
  return held;
}

/** `YYYY-MM-DD` in the zone, or in UTC when the zone is not one. */
export function dayOf(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * The overview's job parts: `status` (live jobs, and how many need the
 * person, with `waitingMail` emails waiting for their yes), the three cloud
 * `minions` and each computer's busy ones, `earlier` (the latest jobs finished today) and `earlierWeek`.
 */
export function jobsOverview(jobs, now, { timeZone = null, waitingMail = 0 } = {}) {
  const slots = slotsOf(jobs);
  const cloud = new Map(jobs.filter((job) => !job.on && slots.has(job.id)).map((job) => [slots.get(job.id), job]));
  const minions = [];
  for (let slot = 1; slot <= SLOTS; slot += 1) {
    const job = cloud.get(slot);
    minions.push({ slot, job: job ? jobSummary(job, slot) : null });
  }
  // A computer's busy slots follow, each with its place (the computer's id); the page draws its free ones from the computer's own count.
  for (const job of jobs.filter((candidate) => candidate.on && slots.has(candidate.id))) {
    minions.push({ slot: slots.get(job.id), place: job.on.id, job: jobSummary(job, slots.get(job.id)) });
  }
  const today = dayOf(now, timeZone);
  const ended = jobs
    .filter((job) => !live(job) && now - (job.endedAt ?? job.startedAt) < WEEK_MS)
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  const endedToday = ended.filter((job) => dayOf(job.endedAt ?? job.startedAt, timeZone) === today);
  const waiting = jobs.filter((job) => job.state === "waiting").length;
  return {
    status: { jobs: slots.size, needsYou: waiting + Math.max(0, waitingMail) },
    minions,
    earlier: endedToday.slice(0, EARLIER_SHOWN).map((job) => jobSummary(job)),
    earlierWeek: ended.length,
  };
}

/**
 * The chat's jobs from the texting Worker: `chat` is `{phone}` or `{groupKey}`,
 * and for a group the people hash its browser is tagged by (`people`).
 * `{now, jobs: []}` when there is no binding, no phone, or the Worker fails:
 * the page then shows free slots, never an error.
 */
export async function fetchPageJobs(env, chat, now = Date.now()) {
  const texting = env?.TEXTING;
  if (!texting || typeof texting.pageJobs !== "function" || chat === null) return { now, jobs: [] };
  try {
    const answer = await texting.pageJobs({ chat });
    const jobs = (Array.isArray(answer?.jobs) ? answer.jobs : []).map(readJob).filter((job) => job !== null);
    // A group's people hash, which its browser is tagged by (`texPage/browser.js`).
    const people = typeof answer?.people === "string" && /^[0-9a-f]{64}$/.test(answer.people) ? answer.people : null;
    return { now: instant(answer?.now) ?? now, jobs, ...(people !== null ? { people } : {}) };
  } catch {
    return { now, jobs: [] };
  }
}

/** Asks the chat's inbox to steer or stop one of its own jobs; true when it took it. */
export async function steerPageJob(env, chat, { id, text, stop = false }) {
  const texting = env?.TEXTING;
  if (!texting || typeof texting.pageSteer !== "function" || chat === null) return false;
  try {
    const answer = await texting.pageSteer({ chat, id, ...(typeof text === "string" ? { text } : {}), ...(stop ? { stop: true } : {}) });
    return answer?.taken === true;
  } catch {
    return false;
  }
}
