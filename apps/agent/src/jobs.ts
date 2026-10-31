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
 *   Never the ask. A finished job stays two hours, so "did you finish?" has
 *   an answer, then goes.
 * - In the job's own object, `jobrun`: what it needs to run, the ask's words
 *   included, only until it ends; then it is deleted.
 *
 * A job runs with a grant the control plane issues when it runs, exactly as a
 * text would get, never one carried over from the turn that started it.
 */

import type { GroupMessage } from "./sendblueGroups";
import type { InboxStorage } from "./inbox";
import { readPictures, type OutgoingPicture } from "./outgoing";

/** What a turn asked to start, as the gateway wrote it. */
export type StartedJob = { title: string; brief: string; doneWhen?: string; tainted?: true };
/** A step a job's turn took, as the gateway told it (`withJobSteps`): tool and target, never a note's text. */
export type JobStep = { at: number; text: string };
/** One line of the chat's job list, sent with every texted turn, with its last few steps. */
export type RunningJob = { id: string; title: string; state: JobState; startedAt: number; finishedAt?: number; status?: string; steps?: JobStep[] };
/** What a job's own turn is asked with; `followUps`: the person's later texts about it, their own words. */
/** `draft`: the last part's answer, never texted because a later text changed the job, or (`unfinished`) because it stopped short of the ask; the next part builds on it. */
export type JobAsk = { id: string; title: string; brief: string; doneWhen?: string; attempt: number; tainted?: true; followUps?: string[]; draft?: string; unfinished?: true };
/** A later text handed to a running job (`jobRun.ts`): the person's own words and the event they came in; `stop` ends it. */
export type JobSteer = { id: string; text: string; stop?: true };
/** What a turn asked of a running job: the job, whether to stop it, and the coordinating turn's own instruction for it (`note`). */
export type JobSteerAsk = { id: string; stop?: true; note?: string };
/** What a job would have said, handed to its chat's own turn, which decides what is said (`jobTexts.ts`). */
export type JobReport = { title: string; state: JobState; texts: string[] };
export type JobState = "running" | "done" | "failed";

/** Where a job came from: a person's own chat, or a group. Kept only in the job's object. */
export type JobOrigin =
  | { kind: "phone"; phone: string; question: string; channel?: "simulator" }
  | { kind: "group"; message: GroupMessage; at: number };

/** Everything a job's object needs to run it. */
export type JobRun = StartedJob & { id: string; inbox: string; origin: JobOrigin; attempt: number; tries: number; startedAt: number; draft?: string; unfinished?: true };

/** The chat's record of a job: no ask, only where its answer goes. */
export type JobEntry = RunningJob & { chatId?: string; messageId?: string; line?: string; groupId?: string; channel?: "simulator"; sent?: number; stopped?: true; finalPass?: string };

/** What a job's object tells the chat's inbox. `first`: the job's count of texts before these, so a retry repeats none. */
/** `vaultWatch`: the phone a job's turn texted a link to save a login to, so its inbox watches for the save (`vaultWatch.ts`). */
/** `pictures`: the answer's pictures (a page's cover), sent before its texts and counted with them in `first`. */
/** `asked`: who asked for the job and their words, so the chat's turn on its report can start it again (`jobTexts.ts`). */
/** `pass`: the job's pass that sent it (`jobRun.ts` `PASS_KEY`); once one pass finished the job, no other pass's word is texted. */
export type JobUpdate = { id: string; state: JobState; status?: string; pictures?: OutgoingPicture[]; texts?: string[]; first?: number; step?: string; vaultWatch?: string; pass?: string; asked?: { from: string; text: string } };

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

export const MAX_RUNNING_JOBS = 3;
/** Turns one job may take before it texts what it has (the gateway clamps to the same). */
export const MAX_JOB_ATTEMPTS = 3;
/** Tries at a turn that could not start (a deploy, the control plane down) before the job gives up. */
export const MAX_JOB_TRIES = 3;
/** How long a finished job stays in the list. */
export const JOB_KEPT_MS = 2 * 60 * 60 * 1000;
/** A job still "running" this long after it started died with its object: it is marked stopped. */
export const JOB_STALE_MS = MAX_JOB_ATTEMPTS * 15 * 60 * 1000 + 5 * 60 * 1000;
export const JOB_PREFIX = "job:";
export const RUN_KEY = "jobrun";
const MAX_SHOWN = 6;
/** Steps kept per job: what "what is it doing?" is answered from. The whole record is the person's Tex transcript. */
export const MAX_STEPS_KEPT = 5;
const MAX_STATUS = 280;
/** The asker's words a report carries, as long as a text they could send. */
const MAX_ASKED = 8_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const JOB_LINES = {
  failed: (title: string) => `I couldn't finish "${title}". Text me if you want me to try again.`,
  busy: "I'm already running three things for you; I'll take that one once one finishes.",
  missed: "You texted a change after I'd done most of it, and I ran out of room to redo it. Text me if you still want it changed.",
} as const;

const line = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** `jobs` from the gateway's answer, read strictly. */
export function readStartedJobs(value: unknown): StartedJob[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RUNNING_JOBS).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { title, brief, doneWhen, tainted } = entry as Record<string, unknown>;
    const job = { title: line(title, 120), brief: typeof brief === "string" ? brief.trim().slice(0, 2_000) : "", doneWhen: line(doneWhen, MAX_STATUS) };
    if (job.title === "" || job.brief === "") return [];
    return [{ ...job, ...(tainted === true ? { tainted: true as const } : {}) }];
  });
}

const entryKey = (id: string) => `${JOB_PREFIX}${id}`;

/** `steers` from the gateway's answer: the running jobs this text goes to, and whether to stop each. */
export function readSteers(value: unknown): JobSteerAsk[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      const { id, stop, note } = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const said = typeof note === "string" ? note.trim().slice(0, 4_000) : "";
      return typeof id === "string" && ID.test(id) ? [{ id, ...(stop === true ? { stop: true as const } : {}), ...(said ? { note: said } : {}) }] : [];
    })
    .slice(0, MAX_RUNNING_JOBS);
}

/** `POST /job-steer`'s body, read strictly. */
export function readJobSteer(value: unknown): JobSteer | null {
  if (!value || typeof value !== "object") return null;
  const { id, text, stop } = value as Record<string, unknown>;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id) || typeof text !== "string" || text.trim() === "") return null;
  return { id, text: text.trim().slice(0, 4_000), ...(stop === true ? { stop: true as const } : {}) };
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
  for (const { id, stop, note } of asks) {
    const entry = await storage.get<JobEntry>(entryKey(id));
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

/**
 * The chat's jobs as the next turn is shown them, running first. Finished
 * ones past `JOB_KEPT_MS` go, and a running one past `JOB_STALE_MS` is marked
 * stopped: its object is gone, so it never will say.
 */
export async function chatJobs(storage: InboxStorage, now: number): Promise<RunningJob[]> {
  const entries = await storage.list<JobEntry>({ prefix: JOB_PREFIX });
  const kept: JobEntry[] = [];
  for (const [key, entry] of entries) {
    if (entry.state !== "running" && now - (entry.finishedAt ?? entry.startedAt) > JOB_KEPT_MS) {
      await storage.delete(key);
      continue;
    }
    if (entry.state === "running" && now - entry.startedAt > JOB_STALE_MS) {
      const stopped = { ...entry, state: "failed" as const, finishedAt: now };
      await storage.put(key, stopped);
      kept.push(stopped);
      continue;
    }
    kept.push(entry);
  }
  return kept
    .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || b.startedAt - a.startedAt)
    .slice(0, MAX_SHOWN)
    .map(({ id, title, state, startedAt, finishedAt, status, steps }) => ({
      id,
      title,
      state,
      startedAt,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
      ...(status ? { status } : {}),
      ...(state === "running" && steps?.length ? { steps } : {}),
    }));
}

const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() === b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Where a job's answer goes in the chat, and its object's name. */
export type JobPlace = Pick<JobEntry, "chatId" | "messageId" | "line" | "groupId" | "channel">;

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
    const running = (await chatJobs(storage, context.now)).filter((entry) => entry.state === "running");
    // The same job already running is the one they asked for; a job over the limit was promised and never runs, so they hear so.
    if (running.some((entry) => sameTitle(entry.title, job.title))) continue;
    if (running.length >= MAX_RUNNING_JOBS) {
      notStarted.push(job.title);
      log("over_limit", "");
      continue;
    }
    const id = crypto.randomUUID();
    const entry: JobEntry = { id, title: job.title, state: "running", startedAt: context.now, ...context.place };
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
  const state: JobState = update.state === "done" || update.state === "failed" ? update.state : "running";
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
  const next: JobEntry = {
    ...entry,
    state,
    ...(status ? { status } : {}),
    ...(step ? { steps: [...(entry.steps ?? []), { at: now, text: step }].slice(-MAX_STEPS_KEPT) } : {}),
    ...(state !== "running" ? { finishedAt: now, ...(update.pass ? { finalPass: update.pass } : {}) } : {}),
  };
  await storage.put(entryKey(update.id), next);
  return next;
}

/** After a part of a job's texts went, so a retried update repeats none of them. */
export async function noteJobSent(storage: InboxStorage, id: string, sent: number): Promise<void> {
  const entry = await storage.get<JobEntry>(entryKey(id));
  if (entry !== undefined) await storage.put(entryKey(id), { ...entry, sent });
}

/** `POST /job-update`'s body, read strictly. */
export function readJobUpdate(value: unknown): JobUpdate | null {
  if (!value || typeof value !== "object") return null;
  const { id, state, status, pictures, texts, first, step, vaultWatch, pass, asked } = value as Record<string, unknown>;
  const by = asked && typeof asked === "object" ? (asked as Record<string, unknown>) : {};
  const read = jobPictures(readPictures(pictures));
  if (typeof id !== "string" || !ID.test(id) || (state !== "running" && state !== "done" && state !== "failed")) return null;
  return {
    id,
    state,
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof step === "string" ? { step } : {}),
    ...(typeof vaultWatch === "string" && vaultWatch !== "" ? { vaultWatch } : {}),
    ...(typeof pass === "string" && ID.test(pass) ? { pass } : {}),
    ...(typeof by.from === "string" && /^\+[1-9]\d{6,14}$/.test(by.from) && typeof by.text === "string" ? { asked: { from: by.from, text: by.text.slice(0, MAX_ASKED) } } : {}),
    ...(Number.isInteger(first) && (first as number) >= 0 ? { first: first as number } : {}),
    ...(read.length > 0 ? { pictures: read } : {}),
    ...(Array.isArray(texts) ? { texts: texts.filter((text): text is string => typeof text === "string" && text.trim() !== "").slice(0, 12) } : {}),
  };
}

/** One line per job event, ids only. */
export function log(outcome: string, id: string, reason?: string): void {
  console.log(JSON.stringify({ event: "background_job", outcome, job: id, ...(reason ? { reason } : {}) }));
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

/** The words that carry the view where there is no card to: a group, or a phone without the Context app. */
export function threadsLine(link: string): string {
  return `What I'm working on, live (tap one to see its steps): ${link}`;
}

/** The lines a group's answer ends with when it offered the view, or none. Never throws. */
export async function threadsLines(offers: readonly string[] | undefined, mint: (() => Promise<string>) | undefined): Promise<string[]> {
  if (!offers?.includes("threads") || mint === undefined) return [];
  try {
    return [threadsLine(await mint())];
  } catch {
    return [];
  }
}
