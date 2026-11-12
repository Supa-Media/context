/**
 * Tex works on several things at once: a long ask becomes a background job
 * (owner, 2026-10-21; the gateway's half is `apps/mcp/src/agent/background.js`).
 *
 * A texted turn, in a 1:1 chat or a group, may start jobs. Each one runs in a
 * Durable Object of its own (named `job:<id>`, the same class as the inboxes),
 * with its own alarm and its own fifteen minutes, so three can run side by
 * side while the chat's own inbox goes on answering texts. Its result comes
 * back to the chat's inbox, which texts it under the ask it came from, and
 * the inbox keeps a small list of its jobs so every texted turn is told what
 * is running and "are you working on this?" gets real status.
 *
 * What it keeps, bounded like the inbox's queue:
 * - In the chat's inbox, `job:<id>`: the job's title (Tex's words), its
 *   state, a one-line status and times, plus the chat and message it answers.
 *   Never the ask. A finished job is shown to every texted turn for two hours,
 *   so "did you finish?" has an answer, and is kept seven days for the
 *   "What Tex is working on" page, then goes.
 * - In the job's own object, `jobrun`: what it needs to run, the ask's words
 *   included, only until it ends; then it is deleted.
 *
 * A job runs with a grant the control plane issues when it runs, exactly as a
 * text would get, never one carried over from the turn that started it.
 */

import type { JobNote } from "./jobNote";
import type { GroupMessage } from "./sendblueGroups";
import type { InboxStorage } from "./inbox";
import { cut, MAX_INBOUND_TEXT } from "./inbound";
import { readPictures, type OutgoingPicture } from "./outgoing";

/** What a turn asked to start, as the gateway wrote it. */
/** `mail`: one part of a split ask; the project note every part's job joins the mail of, and this part's name there. */
/** One of the person's own computers a job runs on (`machineTurn.ts`), as the gateway picked it (`apps/mcp/src/machines/forJobs.js`). */
export type JobMachine = { workspaceId: string; machineId: string; name: string; tool: "claude" | "codex"; folder: string; repo?: string };
export type StartedJob = { id?: string; title: string; brief: string; doneWhen?: string; /** Their earlier texts still open when it started, oldest first (the gateway's `openAsk.js`). */ asked?: string[]; tainted?: true; mail?: JobProject; machine?: JobMachine };
export type JobProject = { path: string; name: string; context?: string };
/** A step a job's turn took, as the gateway told it (`withJobSteps`): tool and target, never a note's text; a failed one, with the tool's short reason. */
export type JobStep = { at: number; text: string; failed?: true; why?: string };
/** Whether a streamed step failed, and why (`clients.ts`). */
export type StepHow = { failed?: true; why?: string };
/** One line of the chat's job list, sent with every texted turn, with its steps; `verdict`/`advice`: the advisor's last check (`apps/mcp/src/agent/jobCheck.js`); `result`: a finished job's report, for the chat's turns only. */
export type RunningJob = { id: string; title: string; state: JobState; startedAt: number; finishedAt?: number; status?: string; steps?: JobStep[]; verdict?: JobVerdict; advice?: string; result?: string; on?: string; resumeAt?: number };
/** The advisor's call on a job's part that just ended (`apps/mcp/src/agent/jobCheck.js`). */
export type JobVerdict = "done" | "keep_going" | "waiting" | "stuck";
/** What a job's own turn is asked with; `followUps`: the person's later texts about it, their own words. */
/** `draft`: the last part's answer, never texted because a later text changed the job, or (`unfinished`) because it stopped short of the ask; the next part builds on it. */
/** `mail`: note mail that came for it since its last part, oldest first (`jobMail.ts`), never among `followUps`. */
export type JobAsk = { roster?: string; project?: JobProject; id: string; title: string; brief: string; doneWhen?: string; /** Their own texts that started it, oldest first, the one it started from last. */ asked?: string[]; attempt: number; tainted?: true; followUps?: string[]; mail?: Array<JobMail & { text: string }>; draft?: string; unfinished?: true; advice?: string; cutOff?: string[] };
/** A later text handed to a running job (`jobRun.ts`): the person's own words and the event they came in; `stop` ends it. */
/** `resume`: pick an ended job back up where it stopped (`jobRun.ts` `resumeJob`), never a new copy of it. */
export type JobSteer = { id: string; text: string; stop?: true; resume?: true; mail?: JobMail; machine?: JobMachine };
/** Note mail delivered to a job (`jobMail.ts`): who sent it, its kind and the note it is on. Another agent's words, never the person's. */
export type JobMail = { from: string; app?: string; kind: "note" | "ask" | "interrupt"; path: string };
/** What a turn asked of a running job: the job, whether to stop it, and the coordinating turn's own instruction for it (`note`). */
export type JobSteerAsk = { id: string; stop?: true; note?: string; resume?: true; machine?: JobMachine };
/** What a job would have said, handed to its chat's own turn, which decides what is said (`jobTexts.ts`). */
/** `ask`: the gateway's own line asking a computer's owner for a 👍, texted as it is (`machineTurn.ts`). */
export type JobReport = { id?: string; title: string; state: JobState; texts: string[]; ask?: string };
/** `waiting`: it needs something only they can give; `stuck`: no way forward, or out of time (`jobRun.ts`). */
export type JobState = "running" | "done" | "failed" | "waiting" | "stuck";

/** Where a job came from: a person's own chat, or a group. Kept only in the job's object. */
export type JobOrigin =
  | { kind: "phone"; phone: string; question: string; channel?: "simulator" }
  | { kind: "group"; message: GroupMessage; at: number };

/** Everything a job's object needs to run it. */
/** `note`: the job's note and who it is on its mail (`jobNote.ts`); `noteAsked`: the note was asked for once, made or not. */
export type JobRun = StartedJob & { id: string; inbox: string; origin: JobOrigin; attempt: number; tries: number; startedAt: number; draft?: string; /** One line per part carried on (`jobRun.ts` `partLine`), for the last word of a job that ends short. */ parts?: string[]; /** The steps of the last part, when it was cut off before it answered (`jobRun.ts`). */ cutOff?: string[]; unfinished?: true; advice?: string; resumes?: number; idle?: true; machineRun?: MachineRunRef; machineSession?: string; note?: JobNote; noteAsked?: true };
/** The part running on the machine now, kept so a pass that restarts reads the same run instead of assigning another. */
export type MachineRunRef = { runId: string; part: number; deadline: number };

/** The chat's record of a job: no ask, only where its answer goes. */
/** `resumeAt`: a job paused at the daily limit starts again then, by itself (`jobPause.ts`). */
export type JobEntry = RunningJob & { chatId?: string; messageId?: string; line?: string; groupId?: string; channel?: "simulator"; stopped?: true; finalPass?: string; machine?: true; onName?: string; onTool?: "claude" | "codex" };

/** What a job's object tells the chat's inbox. `first`: the job's count of texts before these, so a retry repeats none. */
/** `vaultWatch`: the phone a job's turn texted a link to save a login to, so its inbox watches for the save (`vaultWatch.ts`). */
/** `pictures`: the answer's pictures (a page's cover), sent before its texts and counted with them in `first`. */
/** `asked`: who asked for the job and their words, so the chat's turn on its report can start it again (`jobTexts.ts`). */
/** `pass`: the job's pass that sent it (`jobRun.ts` `PASS_KEY`); once one pass finished the job, no other pass's word is texted. */
export type JobUpdate = { id: string; state: JobState; status?: string; verdict?: JobVerdict; advice?: string; pictures?: OutgoingPicture[]; texts?: string[]; first?: number; step?: string; stepFailed?: true; stepWhy?: string; vaultWatch?: string; pass?: string; asked?: { from: string; text: string }; ask?: string; resumeAt?: number };

/** A job's answer texts at most this many pictures: a page's cover, a card or two. */
export const MAX_JOB_PICTURES = 2;
/**
 * Their bytes together, base64, stay under this: an update the inbox did not
 * take is kept in the job's object until it does, under the 2 MB value cap.
 */
export const MAX_JOB_PICTURE_CHARS = 1_500_000;

/** The pictures a job's update carries, in order, until the count or the size runs out. */
export function jobPictures(pictures: OutgoingPicture[]): OutgoingPicture[] {
  const kept: OutgoingPicture[] = [];
  let chars = 0;
  for (const picture of pictures) {
    if (kept.length === MAX_JOB_PICTURES) break;
    chars += "url" in picture ? picture.url.length : picture.data.length;
    if (chars > MAX_JOB_PICTURE_CHARS) break;
    kept.push(picture);
  }
  return kept;
}

/** Cloud jobs at once in a chat. A job on their computer counts against that computer's own slots instead (`apps/mcp/src/agent/jobSlots.js`). */
export const MAX_RUNNING_JOBS = 3;
/** The most jobs one computer runs for a chat (`slotCounts`'s most); its owner's own count is checked by the gateway and the workspace object. */
export const MAX_MACHINE_JOBS = 8;
/** The most jobs one turn may start or steer: the cloud's and one computer's. */
const MAX_TURN_JOBS = MAX_RUNNING_JOBS + MAX_MACHINE_JOBS;
/** The computer a job's entry runs on, by machine id; null in the cloud. An entry from before ids were kept is on an unnamed one. */
const machineOfEntry = (entry: { machine?: true; on?: string }): string | null => (typeof entry.on === "string" ? entry.on : entry.machine ? "machine" : null);
/** Whether one more job fits where it would run: the cloud's three, or that computer's own. */
const fits = (running: readonly { on?: string; machine?: true }[], on: string | null) =>
  on === null ? running.filter((entry) => machineOfEntry(entry) === null).length < MAX_RUNNING_JOBS : running.filter((entry) => machineOfEntry(entry) === on).length < MAX_MACHINE_JOBS;
/** Parts one job may take before it reports what it has (the gateway clamps to the same); Dev2, 2026-10-31: 10 parts or 30 minutes. */
export const MAX_JOB_ATTEMPTS = 10;
/** How long a job keeps going after the advisor says "keep going" before it is reported stuck. */
export const JOB_LIMIT_MS = 30 * 60 * 1000;
/** Tries at a turn that could not start (a deploy, the control plane down) before the job gives up. */
export const MAX_JOB_TRIES = 3;
/** How long a finished job is kept at all: the "What Tex is working on" page reads it for this long. */
export const JOB_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a finished job is shown to every texted turn, and how long its run stays resumable: "did you finish?" has an answer for this long. */
export const JOB_SHOWN_MS = 2 * 60 * 60 * 1000;
/** A job still "running" this long after it started died with its object: it is marked stopped. */
export const JOB_STALE_MS = JOB_LIMIT_MS + 15 * 60 * 1000 + 5 * 60 * 1000; // its last part may start just inside the limit and run fifteen minutes
/** A job on the person's own computer runs four hours by default (owner, 2026-11-03), in fifteen-minute parts. */
export const MACHINE_JOB_LIMIT_MS = 4 * 60 * 60 * 1000;
/** Parts a machine job may take: twenty-four hours of them, the most a machine's owner may allow. */
export const MAX_MACHINE_JOB_ATTEMPTS = 96;
export const MACHINE_JOB_STALE_MS = MACHINE_JOB_LIMIT_MS + 20 * 60 * 1000 + 5 * 60 * 1000;
export const JOB_PREFIX = "job:";
export const RUN_KEY = "jobrun";
const MAX_SHOWN = 6;
/** Steps kept per job: what `job_status` answers "what is it doing?" from. The whole record is the person's Tex transcript. */
export const MAX_STEPS_KEPT = 40;
/** The most of a finished job's report kept with its entry, for the chat's turns (never the live view). */
/** Tex Devs, 2026-11-05: at 1,500 a ten-PR report was cut after the fourth, and Tex said "I only have the first four in full". */
export const MAX_RESULT = 8_000;
const MAX_ADVICE = 600;
const VERDICTS = new Set(["done", "keep_going", "waiting", "stuck"]);
const STATES = new Set(["running", "done", "failed", "waiting", "stuck"]);
const MAX_STATUS = 280;
/** The asker's words a report carries, as long as a text they could send. */
const MAX_ASKED = MAX_INBOUND_TEXT;
/** A computer owner's ask is one short line (`groupAsk.js` `machineAskLine`). */
const MAX_ASK = 400;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const JOB_LINES = {
  failed: (title: string, why?: string) => `I couldn't finish "${title}"${why ? `: ${why}` : ""}. Text me if you want me to try again.`,
  busy: "I'm already running three things for you; I'll take that one once one finishes.",
  missed: "You texted a change after I'd done most of it, and I ran out of room to redo it. Text me if you still want it changed.",
  /** A part the gateway refused to run (`jobRun.ts`): the job waits on them, and they're told why. */
  refused: (title: string, why: "daily_limit" | "no_model") =>
    why === "daily_limit"
      ? `I paused "${title}": I've hit today's limit for background work. I'll pick it back up by myself as soon as the limit resets, and tell you when it's done.`
      : `I paused "${title}": I can't reach my model right now. Text me in a bit and I'll pick it back up.`,
  /** A part the gateway turned down before it ran (`jobRun.ts` `rejected`): asking again is turned down the same way. */
  rejected: (title: string, why: string) => `I couldn't run "${title}": it was turned down before it started (${why}). Text me if you want me to try again.`,
  refusedStatus: { daily_limit: "Paused: today's limit for background work is used up; it starts again by itself once the limit resets", no_model: "Paused: no model could run it" },
} as const;

/** What came with a text besides its typed words, as the gateway read it (`clients.ts` `heard`, `sent`). */
export type JobSaid = { heard?: string; sent?: string };

/**
 * What a job is asked, or told by a later text: the person's own words, typed and said aloud, and the gateway's
 * line naming the files they sent (`clients.ts` `heard`, `sent`). The model only names a job; what it is handed is
 * always what they sent. A job's turn sees none of the chat, so before these a job started from a voice message was
 * asked nothing and every part was refused (2026-11-05, the Morocco trip job), and a change sent by voice or a
 * picture never reached a running job. At most as long as the gateway takes a question (`apps/mcp/src/agent/turn.js`).
 */
/** Their own texts that started a job, oldest first: the open ask before it, then the text it started from. */
export function jobAsked(run: Pick<JobRun, "asked" | "origin">): string[] {
  const started = run.origin.kind === "phone" ? run.origin.question : run.origin.message.text;
  return [...(run.asked ?? []), started].filter((words) => typeof words === "string" && words.trim() !== "");
}

export function jobQuestion(typed: string, said: JobSaid = {}): string {
  return cut([typed.trim(), (said.heard ?? "").trim(), (said.sent ?? "").trim()].filter(Boolean).join("\n\n"), MAX_ASKED);
}

const line = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A split ask's shared note, read strictly (the gateway checked it too: `jobMailOf`). */
export function readJobProject(value: unknown): JobProject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { path, name, context } = value as Record<string, unknown>;
  if (typeof path !== "string" || path === "" || path.length > 1024 || /[\u0000-\u001f]/.test(path) || !path.endsWith(".md")) return null;
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(name) || name === "everyone") return null;
  return { path, name, ...(typeof context === "string" && /^@[a-z0-9][a-z0-9-]{0,63}$/.test(context) ? { context } : {}) };
}

/** The computer a job runs on, read strictly; the gateway and the machine's owner rules check it again at every part. */
export function readJobMachine(value: unknown): JobMachine | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { workspaceId, machineId, name, tool, folder, repo } = value as Record<string, unknown>;
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  if (typeof workspaceId !== "string" || !id.test(workspaceId) || typeof machineId !== "string" || !id.test(machineId)) return null;
  if (tool !== "claude" && tool !== "codex") return null;
  if (typeof folder !== "string" || folder === "" || folder.length > 1024 || /[\u0000-\u001f]/.test(folder)) return null;
  return {
    workspaceId,
    machineId,
    name: line(name, 100) || "your computer",
    tool,
    folder,
    // A name under the folder, never a path that climbs out of it (`apps/mcp/src/machines/forJobs.js`).
    ...(typeof repo === "string" && /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99})?$/.test(repo) ? { repo } : {}),
  };
}

/** Their earlier open texts a job keeps (the gateway sends at most 6 before the one it started from). */
const MAX_OPEN_ASKED = 6;

/** `jobs` from the gateway's answer, read strictly. */
export function readStartedJobs(value: unknown): StartedJob[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_TURN_JOBS).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, title, brief, doneWhen, asked, tainted, mail, machine } = entry as Record<string, unknown>;
    const job = { title: line(title, 120), brief: typeof brief === "string" ? brief.trim().slice(0, 4_000) : "" /* the model's 2,000 and the pages the chat opened (`apps/mcp/src/agent/jobPages.js`) */, doneWhen: line(doneWhen, MAX_STATUS) };
    if (job.title === "" || job.brief === "") return [];
    const project = readJobProject(mail);
    const computer = readJobMachine(machine);
    const open = Array.isArray(asked) ? asked.filter((words): words is string => typeof words === "string" && words.trim() !== "").slice(-MAX_OPEN_ASKED).map((words) => words.trim().slice(0, 1_000)) : [];
    return [{ ...(typeof id === "string" && ID.test(id) ? { id } : {}), ...job, ...(open.length > 0 ? { asked: open } : {}), ...(tainted === true ? { tainted: true as const } : {}), ...(project ? { mail: project } : {}), ...(computer ? { machine: computer } : {}) }];
  });
}

const entryKey = (id: string) => `${JOB_PREFIX}${id}`;

/** `steers` from the gateway's answer: the running jobs this text goes to, and whether to stop each. */
export function readSteers(value: unknown): JobSteerAsk[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const { id, stop, note, resume, machine } = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const said = typeof note === "string" ? note.trim().slice(0, 4_000) : "";
      if (typeof id !== "string" || !ID.test(id)) return [];
      // A computer job picked back up carries the computer as its settings are now (`background.js` `repick`).
      const computer = resume === true ? readJobMachine(machine) : null;
      return [resume === true ? { id, resume: true as const, ...(computer ? { machine: computer } : {}) } : { id, ...(stop === true ? { stop: true as const } : {}), ...(said ? { note: said } : {}) }];
    })
    .slice(0, MAX_TURN_JOBS);
}

/** `POST /job-steer`'s body, read strictly. */
export function readJobSteer(value: unknown): JobSteer | null {
  if (!value || typeof value !== "object") return null;
  const { id, text, stop, resume, machine } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || typeof text !== "string" || text.trim() === "") return null;
  const computer = resume === true ? readJobMachine(machine) : null;
  return { id, text: text.trim().slice(0, 4_000), ...(stop === true ? { stop: true as const } : {}), ...(resume === true ? { resume: true as const } : {}), ...(computer ? { machine: computer } : {}) };
}

/**
 * Hand a text to the chat's running jobs the turn named: only ones this chat
 * started and still running, so a model-named id reaches nothing else.
 */
export async function steerJobs(
  storage: InboxStorage,
  asks: JobSteerAsk[],
  steer: JobSteer,
  send: (id: string, steer: JobSteer) => Promise<boolean>,
  now: number,
): Promise<number> {
  let count = 0;
  for (const { id, stop, note, resume } of asks) {
    if (resume) continue; // `resumeJobs`
    const entry = await storage.get<JobEntry>(entryKey(id));
    // Paused at the daily limit: a stop keeps it from starting again by itself (`jobPause.ts`); nothing else reaches it.
    if (entry?.state === "waiting" && entry.resumeAt !== undefined && stop) {
      const { resumeAt: _r, ...rest } = entry;
      await storage.put<JobEntry>(entryKey(id), { ...rest, state: "failed", status: "Stopped when they asked", finishedAt: now, stopped: true });
      count += 1;
      log("stopped_paused", id);
      continue;
    }
    if (entry?.state !== "running") continue;
    // The coordinating turn's own instruction goes as its, never as their words; a turn with no text of theirs passes only that, or a stop.
    const text = note ? `(From your coordinator, the chat's own turn, not their words: ${note})` : steer.text || (stop ? "(Stopped by your coordinator.)" : "");
    if (text === "") continue;
    const ok = await send(id, { ...steer, text, ...(stop ? { stop } : {}) }).catch(() => false);
    if (ok) count += 1;
    // A stopped job reads as stopped at once; it says nothing more.
    if (ok && stop) await storage.put<JobEntry>(entryKey(id), { ...entry, state: "failed", status: "Stopped when they asked", finishedAt: now, stopped: true });
    log(ok ? (stop ? "stopped" : "steered") : "not_steered", id);
  }
  return count;
}

/** A waiting job's status once its wait ran out: its run is gone, so their answer can no longer pick it up (`jobRun.ts` `resumeJob`). */
export const WAIT_ENDED_STATUS = "Stopped waiting: no answer within two hours. Ask me to start it fresh.";

/**
 * Every job the chat's inbox keeps, with what has run out settled first, the
 * one place both the chat's turns (`chatJobs`) and the Tex page
 * (`texPage.ts` `pageJobsOf`) read them through, so the two never disagree:
 * - a finished one older than `JOB_KEPT_MS` is deleted;
 * - a running one past `JOB_STALE_MS` died with its object, so it never will
 *   say: it is marked failed;
 * - a waiting one whose `JOB_SHOWN_MS` has passed can no longer be picked up
 *   (its object deleted the run it was waiting in), so it is marked stuck at
 *   the moment the wait ran out. Before 2026-11-04 it stayed "waiting" for
 *   seven days and held a minion on the page the whole time, long after the
 *   chat's own turns had stopped being shown it.
 */
export async function sweptJobs(storage: InboxStorage, now: number): Promise<JobEntry[]> {
  const entries = await storage.list<JobEntry>({ prefix: JOB_PREFIX });
  const kept: JobEntry[] = [];
  for (const [key, entry] of entries) {
    const ended = entry.finishedAt ?? entry.startedAt;
    if (entry.state !== "running" && now - ended > JOB_KEPT_MS) {
      await storage.delete(key);
      continue;
    }
    if (entry.state === "running" && now - entry.startedAt > (entry.machine ? MACHINE_JOB_STALE_MS : JOB_STALE_MS)) {
      const stopped = { ...entry, state: "failed" as const, finishedAt: now };
      await storage.put(key, stopped);
      kept.push(stopped);
      continue;
    }
    // A job paused at the daily limit waits until two hours past its restart (`jobPause.ts`), as its object keeps the run.
    const waitEnds = (entry.resumeAt ?? ended) + JOB_SHOWN_MS;
    if (entry.state === "waiting" && now > waitEnds) {
      const { verdict: _v, advice: _a, resumeAt: _r, ...rest } = entry;
      const lapsed: JobEntry = { ...rest, state: "stuck", status: WAIT_ENDED_STATUS, finishedAt: waitEnds };
      await storage.put(key, lapsed);
      log("wait_ended", entry.id);
      kept.push(lapsed);
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

/**
 * The chat's jobs as the next turn is shown them, running first: every
 * running one, and a finished one for `JOB_SHOWN_MS` after it finished
 * (`sweptJobs` settles what has run out).
 */
export async function chatJobs(storage: InboxStorage, now: number, { results = false, all = false }: { results?: boolean; all?: boolean } = {}): Promise<RunningJob[]> {
  // A paused job is shown until it starts again, however long that is (`jobPause.ts`).
  const kept = (await sweptJobs(storage, now)).filter((entry) => entry.state === "running" || (entry.state === "waiting" && entry.resumeAt !== undefined) || now - (entry.finishedAt ?? entry.startedAt) <= JOB_SHOWN_MS);
  return kept
    .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt)
    // Every running one, so the gateway counts each place's slots right; finished ones fill what is left of six. `all`: every job.
    .filter((entry, index) => all || entry.state === "running" || index < MAX_SHOWN)
    .map(({ id, title, state, startedAt, finishedAt, status, steps, verdict, advice, result, on, resumeAt }) => ({
      id,
      title,
      state,
      startedAt,
      // Paused at the daily limit, to start again by itself: the gateway lets a turn stop it (`jobPause.ts`).
      ...(state === "waiting" && resumeAt !== undefined ? { resumeAt } : {}),
      // The computer it runs on, so the gateway counts it against that computer's slots, not the cloud's.
      ...(typeof on === "string" ? { on } : {}),
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(status ? { status } : {}),
      // A finished job keeps its steps: what it did is all it will ever do (2026-10-31: the chat called a stopped job running).
      ...(steps?.length ? { steps } : {}),
      // The advisor's call and a finished job's report go to the chat's own turns only, never the live view anyone with its link can open.
      ...(results && verdict ? { verdict } : {}),
      ...(results && advice ? { advice } : {}),
      ...(results && state !== "running" && result ? { result } : {}),
    }));
}

const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Where a job's answer goes in the chat, and its object's name. */
export type JobPlace = Pick<JobEntry, "chatId" | "messageId" | "line" | "groupId" | "channel">;

/**
 * Pick ended jobs back up where they stopped (Dev2, 2026-10-31: "restart all 3"
 * started three fresh copies, one per text, each working from the restart text
 * instead of the task). Each job's own object still holds its run for two hours
 * after it ended (`jobRun.ts` `resumeJob`): the same ask, brief, finish line and
 * what it had got to. Only this chat's jobs that ended without finishing, and
 * never past the running limit. Says which could not be picked up. Their text
 * goes with it (2026-11-03: "book with santana, mens adult style cut" restarted
 * a job that was handed "(Picked back up.)" and never saw the barber or cut).
 */
export async function resumeJobs(
  storage: InboxStorage,
  asks: JobSteerAsk[],
  steer: Pick<JobSteer, "id" | "text">,
  send: (id: string, steer: JobSteer) => Promise<boolean>,
  now: number,
): Promise<string[]> {
  const missed: string[] = [];
  for (const { id, machine } of asks.filter((ask) => ask.resume)) {
    const entry = await storage.get<JobEntry>(entryKey(id));
    if (entry === undefined || entry.state === "running") continue;
    const running = (await chatJobs(storage, now, { all: true })).filter((job) => job.state === "running");
    // A finished job has nothing to pick up: its object kept no run (`resumeJob`).
    const ok = entry.state !== "done" && fits(running, machineOfEntry(entry)) && (await send(id, { id: steer.id, text: steer.text.trim() || PICKED_UP, resume: true, ...(machine && machine.machineId === entry.on ? { machine } : {}) }).catch(() => false));
    if (ok) {
      const { finishedAt: _f, finalPass: _p, verdict: _v, advice: _a, result: _r, stopped: _s, resumeAt: _ra, ...kept } = entry;
      await storage.put<JobEntry>(entryKey(id), { ...kept, state: "running", startedAt: now, status: "Picking up where it stopped" });
    } else missed.push(entry.title);
    log(ok ? "resumed" : "not_resumed", id);
  }
  return missed;
}

/** A restart's text when no words of theirs came with it (a turn by code): shown to the job as nothing. */
export const PICKED_UP = "(Picked back up.)";

/** What they're told about jobs that could not be picked back up: too long ago, or three already running. */
export function notResumedText(titles: readonly string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const named = titles.map((title) => `"${title}"`).join(" and ");
  return `I couldn't pick ${named} back up: it finished, stopped over two hours ago, or ${MAX_RUNNING_JOBS} jobs are already running. Ask me to start it fresh if you still want it.`;
}

/**
 * Start the jobs a turn asked for: each gets an entry here and an object of
 * its own. The gateway already refused a near-duplicate and a fourth job; this
 * holds to the same when two turns raced, by title and by count.
 */
export async function startJobs(
  storage: InboxStorage,
  started: StartedJob[],
  context: { now: number; inbox: string; origin: JobOrigin; place: JobPlace; spawn: (id: string, run: JobRun) => Promise<void> },
): Promise<{ started: number; notStarted: string[] }> {
  let count = 0;
  const notStarted: string[] = [];
  for (const job of started) {
    const running = (await chatJobs(storage, context.now, { all: true })).filter((entry) => entry.state === "running");
    // The same job already running is the one they asked for; a job over the limit was promised and never runs, so they hear so.
    if (running.some((entry) => sameTitle(entry.title, job.title))) continue;
    if (!fits(running, job.machine?.machineId ?? null)) {
      notStarted.push(job.title);
      log("over_limit", "");
      continue;
    }
    // The gateway's id is used when it is well formed and no entry holds it yet; otherwise a fresh one.
    const gatewayId = job.id !== undefined && ID.test(job.id) && (await storage.get(entryKey(job.id))) === undefined ? job.id : undefined;
    const id = gatewayId ?? crypto.randomUUID();
    const entry: JobEntry = { id, title: job.title, state: "running", startedAt: context.now, ...context.place, ...(job.machine ? { machine: true as const, on: job.machine.machineId, onName: job.machine.name, onTool: job.machine.tool } : {}) };
    await storage.put(entryKey(id), entry);
    try {
      await context.spawn(id, { ...job, id, inbox: context.inbox, origin: context.origin, attempt: 1, tries: 0, startedAt: context.now });
      count += 1;
      log("started", id);
    } catch {
      await storage.delete(entryKey(id));
      notStarted.push(job.title);
      log("not_started", id);
    }
  }
  return { started: count, notStarted };
}

/**
 * What the person is told about jobs Tex said it started that never did: two
 * texts raced past the limit the gateway checks, or the job could not be
 * handed off. Without it, "on it" was the last they heard (Dev2 asked on
 * 2026-10-29 whether people are told about the limit).
 */
export function notStartedText(titles: readonly string[]): string | undefined {
  if (titles.length === 0) return undefined;
  const named = titles.map((title) => `"${title}"`).join(" and ");
  return `I couldn't start ${named} after all. I can run ${MAX_RUNNING_JOBS} jobs at once in this chat, so ask me again once one finishes.`;
}

/** A job's word about itself: its entry updated, and what to text, which the caller sends; nothing at all (`quiet`) from a stopped one. */
export async function noteJobUpdate(storage: InboxStorage, update: JobUpdate, now: number): Promise<(JobEntry & { quiet?: true }) | null> {
  if (typeof update?.id !== "string" || !ID.test(update.id)) return null;
  const entry = await storage.get<JobEntry>(entryKey(update.id));
  if (entry === undefined) return null;
  const state: JobState = STATES.has(update.state) ? update.state : "running";
  // A job stopped at their ask stays stopped, whatever its object says on its way out.
  if (entry.stopped) return { ...entry, quiet: true };
  // A job reports its result once: after one pass finished it, another pass's word (a turn overtaken by a retry)
  // is dropped, so the chat never gets two answers that disagree. The same pass offering its last word again goes on.
  if (entry.state !== "running" && entry.finalPass !== undefined && update.pass !== entry.finalPass) {
    log("second_result_dropped", update.id);
    return { ...entry, quiet: true };
  }
  const status = line(update.status, MAX_STATUS);
  const step = line(update.step, 140);
  // A job that ended without a fresh check drops the last part's: "keep going" is not what a finished job's advisor said.
  const { verdict: _was, advice: _said, ...earlier } = entry;
  const next: JobEntry = {
    ...(update.verdict || state === "running" ? entry : earlier),
    state,
    ...(status ? { status } : {}),
    ...(update.verdict ? { verdict: update.verdict, advice: line(update.advice, MAX_ADVICE) } : {}),
    ...(step ? { steps: [...(entry.steps ?? []), stepOf(update, step, now)].slice(-MAX_STEPS_KEPT) } : {}),
    ...(state !== "running" ? { finishedAt: now, ...(update.pass ? { finalPass: update.pass } : {}), ...resultOf(update) } : {}),
    ...(state === "waiting" && update.resumeAt !== undefined ? { resumeAt: update.resumeAt } : {}),
  };
  // Paused for the daily limit only while this word says so (`jobPause.ts`).
  if (state !== "waiting" || update.resumeAt === undefined) delete next.resumeAt;
  await storage.put(entryKey(update.id), next);
  return next;
}

/** One step as the chat keeps it: a failed one marked, with its reason. */
function stepOf(update: JobUpdate, text: string, now: number): JobStep {
  const why = update.stepFailed ? line(update.stepWhy, 160) : "";
  return { at: now, text, ...(update.stepFailed ? { failed: true as const } : {}), ...(why ? { why } : {}) };
}

/** A finished job's report as its entry keeps it: its words, bounded. */
function resultOf(update: JobUpdate): { result?: string } {
  const result = (update.texts ?? []).join("\n\n").trim().slice(0, MAX_RESULT);
  return result ? { result } : {};
}

/** `POST /job-update`'s body, read strictly. */
export function readJobUpdate(value: unknown): JobUpdate | null {
  if (!value || typeof value !== "object") return null;
  const { id, state, status, pictures, texts, first, step, stepFailed, stepWhy, vaultWatch, pass, asked, verdict, advice, ask, resumeAt } = value as Record<string, unknown>;
  const by = asked && typeof asked === "object" ? (asked as Record<string, unknown>) : {};
  const read = jobPictures(readPictures(pictures));
  if (typeof id !== "string" || !ID.test(id) || typeof state !== "string" || !STATES.has(state)) return null;
  return {
    id,
    state: state as JobState,
    ...(typeof verdict === "string" && VERDICTS.has(verdict) ? { verdict: verdict as JobVerdict, ...(typeof advice === "string" ? { advice: advice.slice(0, MAX_ADVICE) } : {}) } : {}),
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof step === "string" ? { step, ...(stepFailed === true ? { stepFailed: true as const, ...(typeof stepWhy === "string" ? { stepWhy } : {}) } : {}) } : {}),
    ...(typeof vaultWatch === "string" && vaultWatch !== "" ? { vaultWatch } : {}),
    ...(typeof ask === "string" && ask.trim() !== "" ? { ask: ask.slice(0, MAX_ASK) } : {}),
    ...(typeof pass === "string" && ID.test(pass) ? { pass } : {}),
    ...(typeof by.from === "string" && /^\+[1-9]\d{6,14}$/.test(by.from) && typeof by.text === "string" ? { asked: { from: by.from, text: by.text.slice(0, MAX_ASKED) } } : {}),
    ...(Number.isInteger(first) && (first as number) >= 0 ? { first: first as number } : {}),
    ...(Number.isSafeInteger(resumeAt) && (resumeAt as number) > 0 ? { resumeAt: resumeAt as number } : {}),
    ...(read.length > 0 ? { pictures: read } : {}),
    ...(Array.isArray(texts) ? { texts: texts.filter((text): text is string => typeof text === "string" && text.trim() !== "").slice(0, 12) } : {}),
  };
}

/** One line per job event: the job by its tag (`jobTag`), never its id. */
export function log(outcome: string, id: string, reason?: string): void {
  console.log(JSON.stringify({ event: "background_job", outcome, job: jobTag(id), ...(reason ? { reason } : {}) }));
}

/**
 * A short tag that ties a job's log lines together without printing its id (2026-11-01: three jobs' lines
 * ran together on the log page). FNV-1a, synchronous so a line is never lost to an unfinished digest;
 * the id is a random UUID, so the tag says nothing about anyone.
 */
export function jobTag(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  return `j${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The chat's running jobs, live, behind a link only the chat is sent (Dev2,
 * 2026-10-29: a card that shows the running threads, tapped to see what each
 * is doing, in groups too). Tex adds `[card threads]` when it starts a job or
 * is asked what it is working on; a one-to-one chat with Context cards gets a
 * card that opens the view in the Messages extension, and anyone else, a group
 * included, gets the link. The page itself is `infra/router/src/messagesThreads.ts`
 * at `https://context.lc/messages/threads?k=<object id>.<token>`, which reads
 * this object through the router's binding to this Worker.
 *
 * The token is 256 random bits, kept here for `THREADS_FOR_MS`, and the newest
 * `MAX_THREADS_LINKS` per chat; every miss is the same 404. What it shows is
 * what every texted turn of this chat is already told: each job's title,
 * state, status line and last steps (tool and target, never a note's text),
 * so the link reveals nothing the chat could not ask Tex for.
 */
export const THREADS_FOR_MS = 6 * 60 * 60 * 1000;
export const MAX_THREADS_LINKS = 4;
const THREADS_PREFIX = "threads-link:";
const THREADS_TOKEN = /^[0-9a-f]{64}$/;
const THREADS_OBJECT = /^[0-9a-f]{64}$/;
export const THREADS_PAGE = "https://context.lc/messages/threads";

/** A new link to this chat's live view, dropping links that expired and all but the newest few. */
export async function mintThreadsLink(storage: InboxStorage, objectId: string, now: number): Promise<string> {
  if (!THREADS_OBJECT.test(objectId)) throw new Error("not an object id");
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const kept = [...(await storage.list<number>({ prefix: THREADS_PREFIX }))].sort(([, a], [, b]) => b - a);
  for (const [index, [key, at]] of kept.entries()) {
    if (index >= MAX_THREADS_LINKS - 1 || now - at > THREADS_FOR_MS) await storage.delete(key);
  }
  await storage.put<number>(`${THREADS_PREFIX}${token}`, now);
  return `${THREADS_PAGE}?k=${objectId}.${token}`;
}

/** The view's data for a live token, as JSON; the same 404 for every miss. */
export async function serveThreads(storage: InboxStorage, token: string, now: number): Promise<Response> {
  const at = THREADS_TOKEN.test(token) ? await storage.get<number>(`${THREADS_PREFIX}${token}`) : undefined;
  if (typeof at !== "number" || now - at > THREADS_FOR_MS) return new Response(null, { status: 404 });
  return Response.json({ now, max: MAX_RUNNING_JOBS, jobs: await chatJobs(storage, now) }, { headers: { "cache-control": "private, no-store" } });
}

/** `<object id>.<token>` from a view link's `k`, or null for anything else. */
export function threadsKey(value: string | null): { objectId: string; token: string } | null {
  const [objectId, token, extra] = (value ?? "").split(".");
  return extra === undefined && THREADS_OBJECT.test(objectId ?? "") && THREADS_TOKEN.test(token ?? "") ? { objectId: objectId!, token: token! } : null;
}

/**
 * The signed-in Tex hub the gateway names beside an answer that offered the
 * view (`apps/mcp/src/agent/hubLinks.js`; the owner, 2026-11-03: "it should
 * show the hubs context.lc/tex/@user or context.lc/tex/group/<words> ...
 * instead of random thread pages"): `/tex/@<handle>` for a person's own chat,
 * `/tex/group/<words>` for a group's. Read strictly, so the gateway's answer
 * can never put anything else in a text; null for anything else, and the
 * chat's own short-lived view is minted instead.
 */
const HUB_PATH = /^\/tex\/(?:@[a-z0-9-]{2,32}|group\/[a-z]+(?:-[a-z]+){1,4})$/;
export function readHub(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const clean = url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === "";
  return clean && HUB_PATH.test(url.pathname) && url.href === value ? value : null;
}

/** The link "what I'm working on" sends: the chat's hub when the gateway named one, else a fresh link to its own view. */
export function viewLink(hub: string | null | undefined, mint: (() => Promise<string>) | undefined): (() => Promise<string>) | undefined {
  const named = readHub(hub);
  return named !== null ? async () => named : mint;
}

/** The words that carry the view where there is no card to: a group, or a phone without the Context app. Short (the owner, 2026-11-03: "shorter link, and put it in the first text"). */
export function threadsLine(link: string): string {
  // The link sits inside the sentence, never at its end, where Messages would split it off (`linkPreviews.ts`).
  return `Watch it live at ${link} while I work.`;
}

/**
 * The texts with the view's line added to the first one that is not an exact text (an ask texted as written,
 * `format.ts` `textsWithExact`), so it rides in the "On it" text rather than a bubble of its own (the owner,
 * 2026-11-03). With no such text, it goes on its own after them.
 */
export function withViewLine<T>(texts: readonly T[], line: string, exact: (text: string) => boolean): (T | string)[] {
  const at = texts.findIndex((text) => typeof text === "string" && text.trim() !== "" && !exact(text));
  if (at === -1) return [...texts, line];
  return texts.map((text, index) => (index === at ? `${text as string}\n\n${line}` : text));
}

/** A group's texts with the view's line in the first, when it was offered; as they were otherwise. Never throws. */
export async function withThreadsLine(
  texts: string[],
  offers: readonly string[] | undefined,
  mint: (() => Promise<string>) | undefined,
  exact: readonly string[] = [],
): Promise<string[]> {
  if (!offers?.includes("threads") || mint === undefined) return texts;
  try {
    const kept = new Set(exact.map((text) => text.trim()));
    return withViewLine(texts, threadsLine(await mint()), (text) => kept.has(text.trim())) as string[];
  } catch {
    return texts;
  }
}
