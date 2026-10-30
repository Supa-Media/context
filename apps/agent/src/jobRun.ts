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
import { JOB_LINES, jobPictures, log, MAX_JOB_ATTEMPTS, MAX_JOB_PICTURES, MAX_JOB_TRIES, RUN_KEY, type JobAsk, type JobRun, type JobSteer, type JobUpdate } from "./jobs";
import { shrinkPicture, type OutgoingPicture } from "./outgoing";
import type { ImagesLike } from "./attachments";
import { STEER_TIMEOUT_MS } from "./steer";

export type JobDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  whapi?: WhapiKeys | null;
  now: () => number;
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
/** The most of a replaced answer handed to the next part. */
const MAX_DRAFT = 4_000;

/** The turn running now, in memory only: its access token is a credential. */
type Live = { turn: string; accessToken?: string; fetch: Fetch; gatewayOrigin: string };
const live = new WeakMap<InboxStorage, Live>();

type Outcome =
  | { kind: "answer"; texts: string[]; pictures: OutgoingPicture[]; exhausted: boolean; unfinished: boolean; status: string; steered: string[]; vaultWatch?: true }
  /** Nothing ran: try the same turn again later. */
  | { kind: "retry" }
  /** It ran and broke: carry on in a new turn, if one is left. */
  | { kind: "broken" }
  /** Ends here, with this to say, or silently. */
  | { kind: "stop"; text?: string };

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

/** The workflow gave up on the job's pass: it ends, and the chat is told it couldn't finish. */
export async function failJob(storage: InboxStorage, deps: JobDeps): Promise<JobNext> {
  const run = await storage.get<Stored>(RUN_KEY);
  if (run === undefined) return { kind: "done" };
  const tell = (update: Omit<JobUpdate, "id" | "first">) => deps.report(run.inbox, { id: run.id, ...update, first: run.sent ?? 0 }).catch(() => false);
  return await finish(storage, run, { state: "failed", texts: [JOB_LINES.failed(run.title)] }, tell);
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
  if (!steers.some((kept) => kept.id === steer.id)) await storage.put(STEERS_KEY, [...steers, steer].slice(-MAX_STEERS));
  const running = live.get(storage);
  if (running?.accessToken !== undefined) {
    // Best effort: one the turn doesn't take is shown to the next turn.
    await post(running.fetch, "gateway", `${running.gatewayOrigin}/agent/steer`, running.accessToken, { turn: running.turn, ...steer }, STEER_TIMEOUT_MS).catch(
      () => null,
    );
  }
  return true;
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
  if (run === undefined) return { kind: "done" };
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
  if (run.owed !== undefined) return await finish(storage, run, run.owed, tell);
  // Stopped between turns: it ends here, saying nothing (the chat's turn already told them).
  if ((await storage.get<boolean>(STOP_KEY)) === true) return await finish(storage, run, { state: "failed", status: "Stopped" }, tell, pass);
  await storage.put(PASS_KEY, pass);
  const onProgress = async (text: string) => {
    // Only a line with a link is texted (a sign-in page): the rest is status, read when they ask.
    await tell({ state: "running", status: text, ...(HAS_LINK.test(text) ? { texts: [text] } : {}) });
  };
  // Each step, kept by the chat for "what is it doing?"; a step that failed to arrive costs only that line.
  const onStep = async (text: string) => void (await tell({ state: "running", step: text }));

  // Their later texts it hasn't seen yet are shown to this turn; ones sent while it runs are sent into it.
  const shown = (await storage.get<JobSteer[]>(STEERS_KEY)) ?? [];
  const turn: Live = { turn: crypto.randomUUID(), fetch: deps.fetch, gatewayOrigin: deps.gatewayOrigin };
  live.set(storage, turn);
  const asked = ask(run, shown.map((steer) => steer.text));
  let outcome: Outcome;
  try {
    outcome =
      run.origin.kind === "phone" ? await phoneTurn(run, asked, turn, deps, onProgress, onStep) : await groupTurn(run, asked, turn, deps, onStep);
  } catch (error) {
    outcome = error instanceof ServiceError ? { kind: "retry" } : { kind: "broken" };
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
    return await finish(storage, { ...run, sent }, { state: "failed", status: "Stopped" }, tell, pass);
  }
  if (outcome.kind === "retry" && run.tries + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, sent, tries: run.tries + 1 });
    log("retry", run.id);
    return { kind: "after", ms: RETRY_MS * 2 ** run.tries };
  }
  // It texted a link to save a login: the chat's inbox watches for the save, to carry the task on (`vaultWatch.ts`).
  const watch = outcome.kind === "answer" && outcome.vaultWatch && run.origin.kind === "phone" ? { vaultWatch: run.origin.phone } : {};
  // A text that came after the turn's last look changes the job: it is not texted the old way.
  const changed = outcome.kind === "answer" && left.length > 0;
  // An answer that stopped short of the ask (`apps/mcp/src/agent/stopsShort.js`) is not done: the next part finishes it.
  const unfinished = outcome.kind === "answer" && outcome.unfinished && !changed;
  const carryOn = (outcome.kind === "answer" && outcome.exhausted) || outcome.kind === "broken" || changed || unfinished;
  if (carryOn && run.attempt < MAX_JOB_ATTEMPTS) {
    // An answer a later text replaces is not texted; the next part builds on it, so the person gets one result, not two that disagree.
    const draft = (changed || unfinished) && outcome.kind === "answer" ? outcome.texts.join("\n\n").slice(0, MAX_DRAFT) || run.draft : run.draft;
    const { unfinished: _was, ...kept } = run;
    await storage.put<Stored>(RUN_KEY, { ...kept, sent, attempt: run.attempt + 1, tries: 0, ...(draft ? { draft } : {}), ...(unfinished ? { unfinished: true as const } : {}) });
    await tell({
      state: "running",
      ...watch,
      status: changed
        ? "Changing it to what you texted"
        : unfinished
          ? "Finishing what was still missing"
          : `Still going: part ${run.attempt + 1} of at most ${MAX_JOB_ATTEMPTS}`,
    });
    log("carry_on", run.id);
    return { kind: "now" };
  }

  const update: Omit<JobUpdate, "id" | "first"> =
    outcome.kind === "answer"
      ? {
          state: "done",
          status: outcome.status,
          // A page's cover goes first, in place of the link's name card (`jobTexts.ts`); not with an answer a later text changed.
          ...(changed ? {} : await sendable(outcome.pictures, deps.images)),
          texts: changed ? [...outcome.texts, JOB_LINES.missed] : outcome.texts,
          ...watch,
        }
      : outcome.kind === "stop"
        ? { state: "failed", ...(outcome.text ? { texts: [outcome.text] } : {}) }
        : { state: "failed", texts: [JOB_LINES.failed(run.title)] };
  return await finish(storage, { ...run, sent }, update, tell, pass);
}

/** Hand the inbox the job's last word; one it didn't take is kept and offered again, never run again. */
async function finish(
  storage: InboxStorage,
  run: Stored,
  update: Omit<JobUpdate, "id" | "first">,
  tell: (update: Omit<JobUpdate, "id" | "first">) => Promise<boolean>,
  pass?: string,
): Promise<JobNext> {
  if (!(await tell(update)) && (run.owedTries ?? 0) + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, owed: pass === undefined ? update : { ...update, pass }, owedTries: (run.owedTries ?? 0) + 1 });
    log("report_retry", run.id);
    return { kind: "after", ms: RETRY_MS };
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
function ask(run: JobRun, followUps: string[]): JobAsk {
  return {
    ...(followUps.length > 0 ? { followUps } : {}),
    id: run.id,
    title: run.title,
    brief: run.brief,
    attempt: run.attempt,
    ...(run.doneWhen ? { doneWhen: run.doneWhen } : {}),
    ...(run.tainted ? { tainted: true as const } : {}),
    ...(run.draft ? { draft: run.draft } : {}),
    ...(run.draft && run.unfinished ? { unfinished: true as const } : {}),
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
      ...(answer.vaultWatch ? { vaultWatch: true as const } : {}),
    };
  }
  if (answer.kind === "not_started") return { kind: "retry" };
  if (answer.kind === "unavailable") return { kind: "broken" };
  return { kind: "stop", text: undefined };
}

async function phoneTurn(
  run: JobRun,
  job: JobAsk,
  turn: Live,
  deps: JobDeps,
  onProgress: (text: string) => Promise<void>,
  onStep: (text: string) => Promise<void>,
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

async function groupTurn(run: JobRun, job: JobAsk, turn: Live, deps: JobDeps, onStep: (text: string) => Promise<void>): Promise<Outcome> {
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
    ...(asked.guest ? { guest: asked.guest } : {}),
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
  if (answer.kind === "unavailable") return { kind: "broken" };
  const outcome = outcomeOf(answer, textsFromAnswer);
  if (outcome.kind !== "answer") return outcome;
  // Sent only to the people it was written for, as a group's answer is (`groupInbox.ts`).
  const now = await app.readMembers(place);
  if (now === null) return { kind: "stop", text: GROUP_LINES.failed };
  if (now.some((phone) => phone !== message.line && !people.includes(phone))) return { kind: "stop", text: GROUP_LINES.joined };
  return outcome;
}
