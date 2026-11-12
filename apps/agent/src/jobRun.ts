/**
 * One background job's own Durable Object (`jobs.ts`): its alarm runs the
 * job's turn on the gateway, hands the result to the chat's inbox to text,
 * and gives a job that ran out of steps another turn to carry on, up to
 * `MAX_JOB_ATTEMPTS`.
 *
 * Every turn gets a fresh grant, issued the way a text's or a group's is:
 * a phone's from its link, a group's after the chat's members are read again,
 * so somebody who joined a group meanwhile never gets an answer drawn from a
 * workspace they are not in. A pass never schedules itself: it says what
 * comes next (`JobNext`), and its driver waits. With Workflows that is the
 * job's own instance (`jobWorkflow.ts`, Dev2, 2026-10-28); without them (a
 * self-hosted Worker, most tests) it is the object's alarm (`armJobNext`).
 *
 * A later text the chat's turn handed to the job (`steerJob`, "never mind,
 * make it yellow not green") is kept here as the person's own words. A turn
 * running when it arrives is sent it (`apps/mcp/src/agent/steer.js`) and
 * takes it in after its next tool call; one its turn never took is shown to
 * the next turn as a follow-up, and a job that answered without it gets that
 * turn rather than texting the old way. A text that stops it (`stop`) is
 * sent in the same way, so its turn winds up at its next step, and the job
 * texts nothing more and runs no further turn.
 *
 * Each step its turn takes streams back as a short line (tool and target,
 * never a note's text) and goes to the chat's inbox, which keeps the last
 * few to answer "what is it doing?".
 */

import { askAgent, askAgentStream, openSession, post, ServiceError, type AgentAnswer, type Fetch } from "./clients";
import { textsFromAnswer, textsWithExact } from "./format";
import { askControlPlane, GROUP_LINES } from "./groupInbox";
import { peopleHash, peopleOf, sha256Hex } from "./groupChat";
import { groupLineFor } from "./groupLine";
import type { SendblueKeys } from "./sendblue";
import type { WhapiKeys } from "./whapi";
import type { InboxStorage } from "./inbox";
import { machineTurn, type MachineLive, type MachineOutcome } from "./machineTurn";
import { JOB_SHOWN_MS, JOB_LIMIT_MS, jobAsked, JOB_LINES, MACHINE_JOB_LIMIT_MS, MAX_MACHINE_JOB_ATTEMPTS, PICKED_UP, jobPictures, log, MAX_JOB_ATTEMPTS, MAX_JOB_PICTURES, MAX_JOB_TRIES, RUN_KEY, type JobAsk, type JobMail, type JobRun, type JobSteer, type JobUpdate, type JobVerdict, type StepHow } from "./jobs";
import { shrinkPicture, type OutgoingPicture } from "./outgoing";
import type { ImagesLike } from "./attachments";
import { limitResetAt } from "./jobPause";
import { STEER_TIMEOUT_MS } from "./steer";
import { advisorVerdict, openJobNote } from "./jobNote";

export type JobDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  whapi?: WhapiKeys | null;
  now: () => number;
  /** How a part on their computer waits between reads (`machineTurn.ts`); tests pass one that only moves the clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Shrinks a big picture before it goes to the chat's inbox (`outgoing.ts`); absent, it goes as it is. */
  images?: ImagesLike;
  /** Tell the chat's inbox; true once it took the update (and sent its texts). */
  report: (inbox: string, update: JobUpdate) => Promise<boolean>;
};

/**
 * Kept with the run: how many texts went, so an update retried repeats none,
 * and a last update the inbox didn't take, offered again without running the
 * turn again.
 */
type Stored = JobRun & { sent?: number; owed?: Omit<JobUpdate, "id" | "first">; owedTries?: number };

const RETRY_MS = 20_000;
/** A progress line worth texting from a job: one with a link in it, like a sign-in page. Others only update the status. */
const HAS_LINK = /https?:\/\//i;
/** The person's later texts for this job, not yet taken in by a turn. Deleted with the run. */
export const STEERS_KEY = "jobsteers";
/** Set when they asked for the job to stop. Deleted with the run. */
export const STOP_KEY = "jobstop";
/**
 * The pass that holds the job now. A pass whose Durable Object was reset under
 * it can run on while its workflow retries the step, so two turns of one job
 * once ran side by side and both texted the chat, with opposite accounts of
 * one page save (Tex Devs, 2026-10-29). Each pass takes the lease when it
 * starts; one that finds it taken, or the job finished, when its turn returns
 * says nothing and stores nothing. Deleted with the run.
 */
export const PASS_KEY = "jobpass";
const MAX_STEERS = 5;
/** Note mail lines kept for a job's next part (`jobMail.ts`). */
const MAX_MAIL_KEPT = 20;
/**
 * A job that ended without finishing (stuck, waiting, stopped, failed) keeps
 * its run here for `JOB_SHOWN_MS`, as its chat keeps its entry, so "restart it"
 * picks it up where it stopped (`resumeJob`) instead of starting a new copy
 * from the restart text (Dev2, 2026-10-31). Dropped once that time is up.
 */
export const ENDED_KEY = "jobended";
/** `keepUntil`: a job paused at the daily limit is kept past its restart, not two hours from its pause (`jobPause.ts`). */
type Ended = { run: JobRun; endedAt: number; keepUntil?: number };
const keptUntil = (ended: Ended) => ended.keepUntil ?? ended.endedAt + JOB_SHOWN_MS;
/** The most of a replaced answer handed to the next part. */
const MAX_DRAFT = 4_000;

/** The turn running now, in memory only: its access token is a credential. */
type Live = { turn: string; accessToken?: string; fetch: Fetch; gatewayOrigin: string; machine?: MachineLive | null };
const live = new WeakMap<InboxStorage, Live>();

type Outcome =
  | { kind: "answer"; texts: string[]; pictures: OutgoingPicture[]; exhausted: boolean; unfinished: boolean; status: string; steered: string[]; untrusted?: true; vaultWatch?: true; vaultLinks?: string[]; verdict?: JobVerdict; advice?: string; idle?: true }
  /** Nothing ran: try the same turn again later. `why` is kept for the job's last word if no try is left. */
  | { kind: "retry"; why?: string }
  /** It ran and broke: carry on in a new turn, if one is left. */
  | { kind: "broken" }
  /** Ends here, with this to say, or silently. */
  | { kind: "stop"; text?: string }
  /** The gateway refused to run it (`daily_limit`, `no_model`): it waits on them, and says why. */
  | { kind: "refused"; why: "daily_limit" | "no_model" }
  /** The gateway turned the part down before anything ran (`clients.ts` `refused`): the same ask is turned down again, so it ends here and says why. */
  | { kind: "rejected"; why: string };

/** What a job's driver does after a pass: nothing more, the next pass now, or the next pass after `ms`. */
export type JobNext = { kind: "done" } | { kind: "now" } | { kind: "after"; ms: number };

/**
 * Store a job to run. `POST /job-start`, from the chat's inbox. `start` starts
 * its workflow, which runs every pass; without one, the object's alarm does.
 */
export async function acceptJob(storage: InboxStorage, run: JobRun, now: number, start?: () => Promise<void>): Promise<void> {
  if ((await storage.get<JobRun>(RUN_KEY)) !== undefined) return;
  await storage.put<Stored>(RUN_KEY, { ...run, sent: 0 });
  if (start !== undefined) return await start();
  await storage.setAlarm(now);
}

/** The alarm as a job's driver, when no workflow runs it: the next pass when `next` says. */
export async function armJobNext(storage: InboxStorage, next: JobNext, now: number): Promise<void> {
  if (next.kind === "now") await storage.setAlarm(now);
  if (next.kind === "after") await storage.setAlarm(now + next.ms);
}

/**
 * The object's alarm. Without a workflow it runs each pass and arms the next. With one, its only alarm is the
 * one a job's end sets to drop the kept run (`finish`), and a run stored then is a resumed one its own instance
 * passes, so the alarm leaves it alone.
 */
export async function jobAlarm(storage: InboxStorage, deps: JobDeps, workflow: boolean): Promise<void> {
  if (workflow && (await storage.get<Stored>(RUN_KEY)) !== undefined) return;
  await armJobNext(storage, await runJob(storage, deps), deps.now());
}

/** The workflow gave up on the job's pass: it ends, and the chat is told it couldn't finish. */
export async function failJob(storage: InboxStorage, deps: JobDeps): Promise<JobNext> {
  const run = await storage.get<Stored>(RUN_KEY);
  if (run === undefined) return { kind: "done" };
  const tell = (update: Omit<JobUpdate, "id" | "first">) => deps.report(run.inbox, { id: run.id, ...update, first: run.sent ?? 0 }).catch(() => false);
  return await finish(storage, run, { state: "failed", texts: [JOB_LINES.failed(run.title)] }, tell, deps.now());
}

/**
 * `POST /job-steer` with `resume`: pick this object's ended job back up where
 * it stopped. The same ask, brief and finish line; its last answer and the
 * advisor's advice are what the first resumed part starts on, and its limit
 * starts again. `start` starts a new workflow for it (`jobWorkflow.ts`), named
 * by how many times it was resumed. False when nothing ended here in the last
 * `JOB_SHOWN_MS`, or a run is still going.
 */
export async function resumeJob(
  storage: InboxStorage,
  now: number,
  start?: (id: string, resumes: number) => Promise<void>,
  steer?: JobSteer,
): Promise<boolean> {
  if ((await storage.get<JobRun>(RUN_KEY)) !== undefined) return false;
  const ended = await storage.get<Ended>(ENDED_KEY);
  if (ended === undefined || now > keptUntil(ended)) return false;
  // The text that restarted it is theirs and newer than the plan ("book with santana"): the first resumed part is shown it.
  if (steer !== undefined && steer.text.trim() !== "" && steer.text !== PICKED_UP) {
    const steers = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
    if (!steers.some((kept) => kept.id === steer.id)) await storage.put(STEERS_KEY, [...steers, { id: steer.id, text: steer.text }].slice(-MAX_STEERS));
  }
  const resumes = (ended.run.resumes ?? 0) + 1;
  // On a computer: its settings as they are now (`background.js` `repick`), never the folder it was first handed. A new
  // folder starts a new session there, since Claude Code keeps its sessions per folder.
  const was = ended.run.machine;
  const current = steer?.machine !== undefined && was !== undefined && steer.machine.machineId === was.machineId ? { ...steer.machine, ...(was.repo && !steer.machine.repo ? { repo: was.repo } : {}) } : was;
  const moved = current !== undefined && was !== undefined && current.folder !== was.folder;
  // Its earlier parts' lines start again with its parts: the last word recalls this run, not the one before.
  const { parts: _parts, ...restarted } = ended.run;
  const { machineSession: _session, machineRun: _run, ...run } = restarted;
  await storage.put<Stored>(RUN_KEY, { ...(moved ? run : restarted), ...(current ? { machine: current } : {}), attempt: 1, tries: 0, startedAt: now, resumes, sent: 0, ...(ended.run.draft ? { unfinished: true as const } : {}) });
  await storage.delete(ENDED_KEY);
  log("resumed", ended.run.id);
  if (start !== undefined) await start(ended.run.id, resumes);
  else await storage.setAlarm(now);
  return true;
}

/**
 * `POST /job-steer`: keep a later text for this job, and send it into the
 * turn running now. False when the job has ended (the chat's turn then
 * answers it on its own).
 */
export async function steerJob(storage: InboxStorage, steer: JobSteer): Promise<boolean> {
  if ((await storage.get<JobRun>(RUN_KEY)) === undefined) return false;
  if (steer.stop) await storage.put(STOP_KEY, true);
  const steers = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
  if (!steers.some((kept) => kept.id === steer.id)) await storage.put(STEERS_KEY, keptSteers([...steers, steer]));
  const running = live.get(storage);
  if (running?.machine) {
    // A part on their computer: the words go into its session, and a stop cancels it there (`machines/jobRoutes.js`).
    // Note mail goes in as its sender's, never as the person's.
    const { workspaceId, runId, accessToken, delivered } = running.machine;
    const messageId = steer.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    const path = steer.stop ? "/agent/machine/cancel" : "/agent/machine/deliver";
    const sent = await post(running.fetch, "gateway", `${running.gatewayOrigin}${path}`, accessToken, steer.stop ? { workspaceId, runId, reason: "stopped" } : { workspaceId, runId, messageId, text: steer.text, ...(steer.mail ? { mail: { from: steer.mail.from, kind: steer.mail.kind, path: steer.mail.path } } : {}) }, STEER_TIMEOUT_MS).catch(() => null);
    if (!steer.stop && (sent?.json as { ok?: unknown } | null)?.ok === true) delivered.push(steer.id);
  } else if (running?.accessToken !== undefined) {
    // Best effort: one the turn doesn't take is shown to the next turn.
    await post(running.fetch, "gateway", `${running.gatewayOrigin}/agent/steer`, running.accessToken, { turn: running.turn, ...steer }, STEER_TIMEOUT_MS).catch(
      () => null,
    );
  }
  return true;
}

/** The person's last few texts and the last note mail, each in its own room, oldest first: a busy note never pushes out a text. */
function keptSteers(steers: JobSteer[]): JobSteer[] {
  const texts = steers.filter((steer) => steer.mail === undefined).slice(-MAX_STEERS);
  const mail = steers.filter((steer) => steer.mail !== undefined).slice(-MAX_MAIL_KEPT);
  return steers.filter((steer) => texts.includes(steer) || mail.includes(steer));
}

/** After a turn: drop the texts it was shown or took in, and say what is left for the next one. */
async function settleSteers(storage: InboxStorage, done: Set<string>): Promise<JobSteer[]> {
  const steers = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
  const left = steers.filter((steer) => !done.has(steer.id));
  if (left.length !== steers.length) await storage.put(STEERS_KEY, left);
  return left;
}

/** Run the job's next pass, and say what comes next. Finds nothing in any other object. */
export async function runJob(storage: InboxStorage, deps: JobDeps): Promise<JobNext> {
  const run = await storage.get<Stored>(RUN_KEY);
  if (run === undefined) {
    // The alarm set when a job ended unfinished: its kept run goes once nobody can pick it up any more.
    const ended = await storage.get<Ended>(ENDED_KEY);
    if (ended !== undefined && deps.now() > keptUntil(ended)) await storage.delete(ENDED_KEY);
    return { kind: "done" };
  }
  let sent = run.sent ?? 0;
  // An owed update keeps the pass that wrote it, so the inbox takes it as that pass's word again.
  const pass = run.owed?.pass ?? crypto.randomUUID();
  const tell = async (update: Omit<JobUpdate, "id" | "first">): Promise<boolean> => {
    // Words for the chat go to its own turn with who asked and what, so that turn can start the job again (`jobTexts.ts`).
    const asked = update.texts?.length ? { asked: run.origin.kind === "phone" ? { from: run.origin.phone, text: run.origin.question } : { from: run.origin.message.from, text: run.origin.message.text } } : {};
    const ok = await deps.report(run.inbox, { id: run.id, pass, ...asked, ...update, first: sent }).catch(() => false);
    const count = (update.pictures?.length ?? 0) + (update.texts?.length ?? 0);
    // Counted only while this pass holds the job: a pass overtaken never writes the run back.
    if (ok && count > 0 && (await storage.get<string>(PASS_KEY)) === pass) {
      sent += count;
      await storage.put<Stored>(RUN_KEY, { ...run, sent });
    }
    return ok;
  };
  if (run.owed !== undefined) return await finish(storage, run, run.owed, tell, deps.now());
  // Stopped between turns: it ends here, saying nothing (the chat's turn already told them).
  if ((await storage.get<boolean>(STOP_KEY)) === true) return await finish(storage, run, { state: "failed", status: "Stopped" }, tell, deps.now(), pass);
  await storage.put(PASS_KEY, pass);
  // Its note, asked for once before its first part: the job, Tex and the advisor on its mail, and the job told who is there (`jobNote.ts`).
  // A group's job has a note only where Tex put it in a project (`apps/mcp/src/agent/jobNote.js`), so one without asks nothing.
  if (run.note === undefined && run.noteAsked !== true && (run.origin.kind === "phone" || run.mail !== undefined)) {
    const token = await jobToken(run, deps).catch(() => null);
    const note = token === null ? null : await openJobNote(deps, token, run);
    run.noteAsked = true;
    if (note !== null) run.note = note;
    await storage.put<Stored>(RUN_KEY, { ...run, sent });
  }
  const onProgress = async (text: string) => {
    // Only a line with a link is texted (a sign-in page): the rest is status, read when they ask.
    await tell({ state: "running", status: text, ...(HAS_LINK.test(text) ? { texts: [text] } : {}) });
  };
  // Each step, kept by the chat for "what is it doing?"; a step that failed to arrive costs only that line.
  // The part's steps, also kept here: a part cut off before it answered hands them to the next one (`cutOff`).
  const took: string[] = [];
  const onStep = async (text: string, how?: StepHow) => {
    if (took.length < MAX_CUT_OFF_STEPS) took.push(how?.failed ? `${text} (failed)` : text);
    await tell({ state: "running", step: text, ...(how?.failed ? { stepFailed: true as const, ...(how.why ? { stepWhy: how.why } : {}) } : {}) });
  };

  // Their later texts it hasn't seen yet are shown to this turn; ones sent while it runs are sent into it.
  const shown = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
  const turn: Live = { turn: crypto.randomUUID(), fetch: deps.fetch, gatewayOrigin: deps.gatewayOrigin };
  live.set(storage, turn);
  const asked = ask(
    run,
    shown.filter((steer) => steer.mail === undefined).map((steer) => steer.text),
    shown.flatMap((steer) => (steer.mail === undefined ? [] : [{ ...steer.mail, text: steer.text }])),
  );
  let outcome: Outcome;
  try {
    outcome =
      run.machine !== undefined
        ? fromMachine(await machineTurn(run, asked, deps, { keep: (patch) => storage.put<Stored>(RUN_KEY, { ...run, ...patch, sent }), onStep, askOwner: async (line) => void (await tell({ state: "running", status: "Waiting for the computer's owner to say yes", texts: [line], ask: line })), live: (machine) => void (turn.machine = machine), steerIds: shown.map((steer) => steer.id), groupGrant: () => groupGrant(run, deps) }))
        : run.origin.kind === "phone"
          ? await phoneTurn(run, asked, turn, deps, onProgress, onStep)
          : await groupTurn(run, asked, turn, deps, onStep);
  } catch (error) {
    outcome = error instanceof ServiceError ? { kind: "retry", why: unreachable(error) } : { kind: "broken" };
  } finally {
    if (live.get(storage) === turn) live.delete(storage);
  }
  // Another pass took the job meanwhile, or already finished it: that one's word is the only one the chat gets.
  if ((await storage.get<string>(PASS_KEY)) !== pass) {
    log("stale_pass", run.id);
    return { kind: "done" };
  }
  // Nothing ran on a retry, so what it was shown is shown again.
  const left =
    outcome.kind === "retry"
      ? shown
      : await settleSteers(storage, new Set([...shown.map((steer) => steer.id), ...(outcome.kind === "answer" ? outcome.steered : [])]));

  if ((await storage.get<boolean>(STOP_KEY)) === true) {
    return await finish(storage, { ...run, sent }, { state: "failed", status: "Stopped" }, tell, deps.now(), pass);
  }
  if (outcome.kind === "retry" && run.tries + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, sent, tries: run.tries + 1 });
    log("retry", run.id);
    return { kind: "after", ms: RETRY_MS * 2 ** run.tries };
  }
  // It texted a link to save a login: the chat's inbox watches for the save, to carry the task on (`vaultWatch.ts`).
  // In a group chat too, as its asker's tag (Dev2, 2026-11-12), on the links it texted.
  const asker = run.origin.kind === "phone" ? run.origin.phone : run.origin.message.from;
  const watch = outcome.kind === "answer" && outcome.vaultWatch ? { vaultWatch: asker, ...(outcome.vaultLinks ? { vaultLinks: outcome.vaultLinks } : {}) } : {};
  // A text that came after the turn's last look changes the job: it is not texted the old way. So does an ask or an
  // interrupt mailed to it; a plain note mailed to it is shown to a next part if there is one, and is in the note anyway.
  const changed = outcome.kind === "answer" && left.some((steer) => steer.mail === undefined || steer.mail.kind !== "note");
  const mailed = changed && left.every((steer) => steer.mail !== undefined);
  // An answer the advisor says isn't finished (`apps/mcp/src/agent/jobCheck.js`; without it, `stopsShort.js`) is not done: the next part finishes it, on its advice.
  const unfinished = outcome.kind === "answer" && outcome.unfinished && !changed;
  const carryOn = (outcome.kind === "answer" && outcome.exhausted) || outcome.kind === "broken" || changed || unfinished;
  const advice = outcome.kind === "answer" ? outcome.advice : undefined;
  const checked = outcome.kind === "answer" && outcome.verdict ? { verdict: outcome.verdict, ...(advice ? { advice } : {}) } : {};
  // The advisor's judgement of the part, said on the job's note too, so everyone on its mail sees it (`jobNote.ts`).
  if (outcome.kind === "answer" && outcome.verdict && run.note?.advisor) {
    const token = await jobToken(run, deps).catch(() => null);
    if (token !== null) await advisorVerdict(run, deps, token, `My check of part ${run.attempt}: ${outcome.verdict.replace("_", " ")}.${advice ? ` ${advice}` : ""}`);
  }
  // Dev2, 2026-10-31: a job keeps going for at most 30 minutes or 10 parts, then reports where it got to.
  // A job on their own computer runs for hours, in fifteen-minute parts (`machineTurn.ts`).
  const roomLeft = run.machine !== undefined ? run.attempt < MAX_MACHINE_JOB_ATTEMPTS && deps.now() - run.startedAt < MACHINE_JOB_LIMIT_MS : run.attempt < MAX_JOB_ATTEMPTS && deps.now() - run.startedAt < JOB_LIMIT_MS;
  // Two parts in a row that called no tool and still weren't done are going nowhere (2026-10-31: three restarted jobs
  // answered "it's running again" eight times each): it ends stuck and says so, instead of spending more parts.
  const idle = outcome.kind === "answer" && outcome.idle === true && unfinished;
  const spinning = idle && run.idle === true;
  if (carryOn && roomLeft && !spinning) {
    // An answer a later text replaces is not texted; the next part builds on it, so the person gets one result, not two that disagree.
    const draft = (changed || unfinished) && outcome.kind === "answer" ? outcome.texts.join("\n\n").slice(0, MAX_DRAFT) || run.draft : run.draft;
    const { unfinished: _was, advice: _said, idle: _idle, cutOff: _cut, ...kept } = run;
    // Cut off before it answered (2026-11-08: the gateway ran out of memory after a part had written its page, and the
    // next part, told nothing, did it all again): the next part is shown what this one had done, to check before redoing.
    const cutOff = outcome.kind === "broken" && took.length > 0 ? took : undefined;
    // What this part did, one line, so a job that ends short reports every part and not only its last (2026-11-06:
    // a cloud reviewer's tenth part answered a screenshot, and that alone became its report: "nothing from it is built").
    const said = outcome.kind === "answer" ? partLine(run.attempt, outcome.texts, outcome.status) : null;
    const parts = said === null ? run.parts : [...(run.parts ?? []), said].slice(-MAX_PARTS_KEPT);
    await storage.put<Stored>(RUN_KEY, { ...kept, sent, attempt: run.attempt + 1, tries: 0, ...(parts?.length ? { parts } : {}), ...(draft ? { draft } : {}), ...(unfinished ? { unfinished: true as const } : {}), ...(advice && !changed ? { advice } : {}), ...(idle ? { idle: true as const } : {}), ...(cutOff ? { cutOff } : {}), ...(outcome.kind === "answer" && outcome.untrusted ? { tainted: true as const } : {}) });
    await tell({
      state: "running",
      ...watch,
      ...checked,
      status: mailed
        ? `Answering mail from ${left.find((steer) => steer.mail)?.mail?.from ?? "another agent"}`
        : changed
        ? "Changing it to what you texted"
        : unfinished
          ? advice ? `Not done yet; next: ${advice}`.slice(0, 280) : "Finishing what was still missing"
          : `Still going: part ${run.attempt + 1} of at most ${MAX_JOB_ATTEMPTS}`,
    });
    // Why it carried on, so a part that ran again can be explained from the log alone (2026-11-08: it could not).
    log("carry_on", run.id, outcome.kind === "broken" ? "broken" : changed ? "changed" : unfinished ? "unfinished" : "exhausted");
    return { kind: "now" };
  }

  // What the advisor said decides how it ended: waiting on them, stuck, or (still short when its room ran out) stuck too; else done.
  if (outcome.kind === "rejected") log("rejected", run.id, outcome.why); // 2026-11-05: a voice-only ask gave a job no question, and ten refused parts went in eight seconds, with no reason kept
  const ended = outcome.kind !== "answer" || changed ? "done" : outcome.verdict === "waiting" ? "waiting" : outcome.verdict === "stuck" || outcome.verdict === "keep_going" || unfinished ? "stuck" : "done";
  if (ended !== "done") log(spinning ? "ended_spinning" : `ended_${ended}`, run.id);
  const why = spinning ? "Two parts in a row did none of the work. " : ended === "stuck" && outcome.kind === "answer" && outcome.verdict !== "stuck" ? "Ran out of time. " : "";
  const update: Omit<JobUpdate, "id" | "first"> =
    outcome.kind === "answer"
      ? {
          state: ended,
          ...checked,
          status: ended === "done" ? outcome.status : `${why}${advice || outcome.status}`.slice(0, 280),
          // A page's cover goes first, in place of the link's name card (`jobTexts.ts`); not with an answer a later text changed.
          ...(changed ? {} : await sendable(outcome.pictures, deps.images)),
          texts: changed && !mailed ? [...outcome.texts, JOB_LINES.missed] : ended !== "done" && run.parts?.length ? [...outcome.texts, earlierParts(run.parts)] : outcome.texts,
          ...watch,
        }
      : outcome.kind === "refused"
        ? { state: "waiting", status: JOB_LINES.refusedStatus[outcome.why], texts: [JOB_LINES.refused(run.title, outcome.why)], ...(outcome.why === "daily_limit" ? { resumeAt: limitResetAt(deps.now()) } : {}) } // starts again by itself (`jobPause.ts`)
        : outcome.kind === "rejected"
          ? { state: "failed", status: `Stopped: turned down before it ran (${outcome.why})`.slice(0, 280), texts: [JOB_LINES.rejected(run.title, outcome.why)] }
        : outcome.kind === "stop"
          ? { state: "failed", ...(outcome.text ? { texts: [outcome.text] } : {}) }
          : outcome.kind === "retry" && outcome.why
            ? // Out of tries at a service that didn't answer: said, so neither Tex nor the person is left guessing (2026-11-06).
              { state: "failed", status: `Stopped: ${outcome.why}`.slice(0, 280), texts: [JOB_LINES.failed(run.title, outcome.why)] }
            : { state: "failed", texts: [JOB_LINES.failed(run.title)] };
  // What it had got to is what a restart starts on (`resumeJob`).
  const got = outcome.kind === "answer" && !changed ? outcome.texts.join("\n\n").slice(0, MAX_DRAFT) : "";
  return await finish(storage, { ...run, sent, ...(got ? { draft: got } : {}), ...(advice ? { advice } : {}) }, update, tell, deps.now(), pass);
}

/** Earlier parts' lines a job keeps for its last word. */
const MAX_PARTS_KEPT = 8;
const MAX_PART_LINE = 300;

/** One part as its job's last word recalls it: its answer's first line, or its status. Null when it said nothing. */
/** The most steps of a part cut off before it answered that the next part is shown (`cutOff`). */
export const MAX_CUT_OFF_STEPS = 40;

export function partLine(attempt: number, texts: string[], status: string): string | null {
  const first = texts.join("\n").split("\n").find((line) => line.trim() !== "")?.trim() ?? status.trim();
  return first === "" ? null : `Part ${attempt}: ${first}`.slice(0, MAX_PART_LINE);
}

/** The earlier parts, said after a job's last part when it ended short. */
export function earlierParts(parts: string[]): string {
  return `What the earlier parts did:\n${parts.join("\n")}`;
}

/** Why a pass couldn't run, in words for the job's last line: which service didn't answer, and how. */
export function unreachable(error: ServiceError): string {
  const who = error.service === "gateway" ? "Context" : error.service === "control_plane" ? "Context's accounts" : "the texting service";
  return `${who} didn't answer ${MAX_JOB_TRIES} times in a row${error.status === null ? "" : ` (error ${error.status})`}`;
}

/** Hand the inbox the job's last word; one it didn't take is kept and offered again, never run again. */
async function finish(
  storage: InboxStorage,
  run: Stored,
  update: Omit<JobUpdate, "id" | "first">,
  tell: (update: Omit<JobUpdate, "id" | "first">) => Promise<boolean>,
  now: number,
  pass?: string,
): Promise<JobNext> {
  if (!(await tell(update)) && (run.owedTries ?? 0) + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, owed: pass === undefined ? update : { ...update, pass }, owedTries: (run.owedTries ?? 0) + 1 });
    log("report_retry", run.id);
    return { kind: "after", ms: RETRY_MS };
  }
  if (update.state === "done") await storage.delete(ENDED_KEY);
  else {
    const { sent: _s, owed: _o, owedTries: _t, unfinished: _u, idle: _i, ...kept } = run;
    const keepUntil = update.resumeAt === undefined ? undefined : update.resumeAt + JOB_SHOWN_MS;
    await storage.put<Ended>(ENDED_KEY, { run: kept, endedAt: now, ...(keepUntil !== undefined ? { keepUntil } : {}) });
    await storage.setAlarm((keepUntil ?? now + JOB_SHOWN_MS) + 60_000);
  }
  await storage.delete(RUN_KEY);
  await storage.delete(STEERS_KEY);
  await storage.delete(STOP_KEY);
  await storage.delete(PASS_KEY);
  log(update.state, run.id);
  return { kind: "done" };
}

/** An answer's pictures as its update carries them: shrunk, then as many as fit (`jobPictures`). */
async function sendable(pictures: OutgoingPicture[], images: ImagesLike | undefined): Promise<{ pictures?: OutgoingPicture[] }> {
  const shrunk = await Promise.all(pictures.slice(0, MAX_JOB_PICTURES).map((picture) => ("url" in picture ? picture : shrinkPicture(images, picture))));
  const kept = jobPictures(shrunk);
  return kept.length > 0 ? { pictures: kept } : {};
}

/** What the job's turn is asked with. */
function ask(run: JobRun, followUps: string[], mail: Array<JobMail & { text: string }> = []): JobAsk {
  return {
    ...(followUps.length > 0 ? { followUps } : {}),
    ...(mail.length > 0 ? { mail } : {}),
    id: run.id,
    title: run.title,
    brief: run.brief,
    asked: jobAsked(run),
    attempt: run.attempt,
    ...(run.doneWhen ? { doneWhen: run.doneWhen } : {}),
    ...(run.mail ? { project: run.mail } : {}),
    ...(run.note ? { roster: run.note.roster } : {}),
    ...(run.tainted ? { tainted: true as const } : {}),
    ...(run.draft ? { draft: run.draft } : {}),
    ...(run.draft && run.unfinished ? { unfinished: true as const } : {}),
    ...(run.advice ? { advice: run.advice } : {}),
    ...(run.cutOff?.length ? { cutOff: run.cutOff } : {}),
  };
}

/** A part on their computer, as a cloud part's outcome. */
function fromMachine(outcome: MachineOutcome): Outcome {
  if (outcome.kind !== "answer") return outcome;
  const check = outcome.check ?? {};
  return {
    kind: "answer",
    texts: outcome.texts,
    pictures: [],
    exhausted: outcome.exhausted,
    // The advisor's `keep_going` on a finished part: the next part resumes the session on its advice (`jobCheck.js`).
    unfinished: check.unfinished === true,
    status: outcome.status,
    steered: outcome.steered,
    ...(check.verdict ? { verdict: check.verdict, ...(check.advice ? { advice: check.advice } : {}) } : {}),
    ...(check.untrusted ? { untrusted: true as const } : {}),
    ...(check.idle ? { idle: true as const } : {}),
  };
}

/** The first line of an answer, as the job's status once it is done. */
function firstLine(text: string): string {
  return text.split("\n").find((part) => part.trim() !== "")?.trim().slice(0, 280) ?? "";
}

function outcomeOf(answer: AgentAnswer, texts: (text: string) => string[]): Outcome {
  if (answer.kind === "answer") {
    return {
      kind: "answer",
      texts: answer.text ? texts(answer.text) : [],
      pictures: answer.pictures,
      exhausted: answer.exhausted === true,
      unfinished: answer.unfinished === true,
      status: firstLine(answer.text),
      steered: answer.steered ?? [],
      // It read from outside: every part after it is built on its words, so they carry the same mark (`ask`'s `tainted`).
      ...(answer.untrusted ? { untrusted: true as const } : {}),
      ...(answer.vaultWatch ? { vaultWatch: true as const, ...(answer.vaultLinks ? { vaultLinks: answer.vaultLinks } : {}) } : {}),
      ...(answer.verdict ? { verdict: answer.verdict, ...(answer.advice ? { advice: answer.advice } : {}) } : {}),
      ...(answer.idle ? { idle: true as const } : {}),
    };
  }
  if (answer.kind === "not_started") return { kind: "retry" };
  if (answer.kind === "unavailable") return answer.refused ? { kind: "rejected", why: answer.refused } : { kind: "broken" };
  // Refused before anything ran: never a silent failure (Dev2, 2026-10-31, the day three jobs ran into the cap).
  if (answer.kind === "daily_limit" || answer.kind === "no_model") return { kind: "refused", why: answer.kind };
  return { kind: "stop", text: undefined };
}

async function phoneTurn(
  run: JobRun,
  job: JobAsk,
  turn: Live,
  deps: JobDeps,
  onProgress: (text: string) => Promise<void>,
  onStep: (text: string, how?: StepHow) => Promise<void>,
): Promise<Outcome> {
  if (run.origin.kind !== "phone") return { kind: "stop" };
  const session = await openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, run.origin.phone);
  // Unlinked since: nothing of theirs is read, and nothing is said.
  if (session.status !== "linked") return { kind: "stop" };
  turn.accessToken = session.accessToken;
  const answer = await askAgent(
    deps.fetch,
    deps.gatewayOrigin,
    session.accessToken,
    run.origin.question,
    onProgress,
    session.timeZone,
    [],
    undefined,
    undefined,
    { job, turn: turn.turn, onStep },
  );
  const outcome = outcomeOf(answer, (text) => textsWithExact(text, answer.kind === "answer" ? answer.verbatim : []));
  if (outcome.kind === "stop") return { kind: "stop", text: JOB_LINES.failed(run.title) };
  return outcome;
}

/** The job's own grant now, a person's or its group chat's, for a call of its own beside a part; null when it may not run. */
export async function jobToken(run: JobRun, deps: JobDeps): Promise<string | null> {
  if (run.origin.kind === "group") return await groupGrant(run, deps);
  const session = await openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, run.origin.phone);
  return session.status === "linked" ? session.accessToken : null;
}

/** A group job's grant, minted as its own turn's is: the chat's people read again, so somebody who joined since narrows it. Null when it may not run. */
async function groupGrant(run: JobRun, deps: JobDeps): Promise<string | null> {
  if (run.origin.kind !== "group") return null;
  const message = run.origin.message;
  const app = groupLineFor(deps, message.groupId);
  const members = await app.readMembers({ line: message.line, groupId: message.groupId });
  const asked = await askControlPlane(deps, message, peopleOf(message.line, message.participants, members), null);
  return asked.status === "ready" && asked.accessToken !== undefined ? asked.accessToken : null;
}

async function groupTurn(run: JobRun, job: JobAsk, turn: Live, deps: JobDeps, onStep: (text: string, how?: StepHow) => Promise<void>): Promise<Outcome> {
  if (run.origin.kind !== "group") return { kind: "stop" };
  const message = run.origin.message;
  const app = groupLineFor(deps, message.groupId);
  const place = { line: message.line, groupId: message.groupId };
  // Read again now: more people only ever narrow what Tex may use.
  const members = await app.readMembers(place);
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane(deps, message, people, null);
  // Muted, stopped or no longer shared: the chat said so, and the job ends quietly.
  if (asked.status !== "ready" || asked.accessToken === undefined) return { kind: "stop" };
  turn.accessToken = asked.accessToken;
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await peopleHash(message.line, people),
    ...(asked.handle ? { from: asked.handle } : {}),
    // Who is here and what the chat may read, as its own turn is told (`groupInbox.ts`): a job that drops `mail`
    // can't open the inbox shared with the chat it is working for.
    people: [...new Set((asked.names ?? []).map(({ handle }) => handle))].filter(Boolean),
    ...(asked.mail?.length ? { mail: asked.mail } : {}),
    chat: [],
  };
  // Streamed, so its steps reach the chat as it takes them; a group's turn texts no progress of its own.
  const answer = await askAgentStream(
    deps.fetch,
    deps.gatewayOrigin,
    asked.accessToken,
    { question: message.text, group, job, turn: turn.turn, ...(asked.timeZone ? { timeZone: asked.timeZone } : {}) },
    async () => {},
    onStep,
  );
  if (answer.kind === "unavailable" && !answer.refused) return { kind: "broken" };
  const outcome = outcomeOf(answer, textsFromAnswer);
  if (outcome.kind !== "answer") return outcome;
  // Sent only to the people it was written for, as a group's answer is (`groupInbox.ts`).
  const now = await app.readMembers(place);
  if (now === null) return { kind: "stop", text: GROUP_LINES.failed };
  if (now.some((phone) => phone !== message.line && !people.includes(phone))) return { kind: "stop", text: GROUP_LINES.joined };
  return outcome;
}
