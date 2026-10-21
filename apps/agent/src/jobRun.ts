/**
 * One background job's own Durable Object (`jobs.ts`): its alarm runs the
 * job's turn on the gateway, hands the result to the chat's inbox to text,
 * and gives a job that ran out of steps another turn to carry on, up to
 * `MAX_JOB_ATTEMPTS`.
 *
 * Every turn gets a fresh grant, issued the way a text's or a group's is:
 * a phone's from its link, a group's after the chat's members are read again,
 * so somebody who joined a group meanwhile never gets an answer drawn from a
 * workspace they are not in. Nothing here is retried by the platform: the
 * alarm catches everything and sets its own next try.
 */

import { agentAnswer, askAgent, openSession, post, ServiceError, type AgentAnswer, type Fetch } from "./clients";
import { textsFromAnswer, textsWithExact } from "./format";
import { askControlPlane, GROUP_LINES } from "./groupInbox";
import { peopleOf, sha256Hex } from "./groupChat";
import { readGroupMembers } from "./sendblueGroups";
import type { SendblueKeys } from "./sendblue";
import type { InboxStorage } from "./inbox";
import { JOB_LINES, log, MAX_JOB_ATTEMPTS, MAX_JOB_TRIES, RUN_KEY, type JobAsk, type JobRun, type JobUpdate } from "./jobs";

export type JobDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  now: () => number;
  /** Tell the chat's inbox; true once it took the update (and sent its texts). */
  report: (inbox: string, update: JobUpdate) => Promise<boolean>;
};

/**
 * Kept with the run: how many texts went, so an update retried repeats none,
 * and a last update the inbox didn't take, offered again without running the
 * turn again.
 */
type Stored = JobRun & { sent?: number; owed?: Omit<JobUpdate, "id" | "first">; owedTries?: number };

/** A group job's turn is asked for whole, inside the alarm's fifteen minutes. */
export const GROUP_JOB_TIMEOUT_MS = 12 * 60_000;
const RETRY_MS = 20_000;
/** A progress line worth texting from a job: one with a link in it, like a sign-in page. Others only update the status. */
const HAS_LINK = /https?:\/\//i;

type Outcome =
  | { kind: "answer"; texts: string[]; exhausted: boolean; status: string }
  /** Nothing ran: try the same turn again later. */
  | { kind: "retry" }
  /** It ran and broke: carry on in a new turn, if one is left. */
  | { kind: "broken" }
  /** Ends here, with this to say, or silently. */
  | { kind: "stop"; text?: string };

/** Store a job to run and set its alarm. `POST /job-start`, from the chat's inbox. */
export async function acceptJob(storage: InboxStorage, run: JobRun, now: number): Promise<void> {
  if ((await storage.get<JobRun>(RUN_KEY)) !== undefined) return;
  await storage.put<Stored>(RUN_KEY, { ...run, sent: 0 });
  await storage.setAlarm(now);
}

/** Run the job's next turn. Called from the alarm; finds nothing in any other object. */
export async function runJob(storage: InboxStorage, deps: JobDeps): Promise<void> {
  const run = await storage.get<Stored>(RUN_KEY);
  if (run === undefined) return;
  let sent = run.sent ?? 0;
  const tell = async (update: Omit<JobUpdate, "id" | "first">): Promise<boolean> => {
    const ok = await deps.report(run.inbox, { id: run.id, ...update, first: sent }).catch(() => false);
    if (ok && update.texts) {
      sent += update.texts.length;
      await storage.put<Stored>(RUN_KEY, { ...run, sent });
    }
    return ok;
  };
  if (run.owed !== undefined) return void (await finish(storage, run, run.owed, tell, deps));
  const onProgress = async (text: string) => {
    // Only a line with a link is texted (a sign-in page): the rest is status, read when they ask.
    await tell({ state: "running", status: text, ...(HAS_LINK.test(text) ? { texts: [text] } : {}) });
  };

  let outcome: Outcome;
  try {
    outcome = run.origin.kind === "phone" ? await phoneTurn(run, deps, onProgress) : await groupTurn(run, deps);
  } catch (error) {
    outcome = error instanceof ServiceError ? { kind: "retry" } : { kind: "broken" };
  }

  if (outcome.kind === "retry" && run.tries + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, sent, tries: run.tries + 1 });
    await storage.setAlarm(deps.now() + RETRY_MS * 2 ** run.tries);
    return log("retry", run.id);
  }
  const carryOn = (outcome.kind === "answer" && outcome.exhausted) || outcome.kind === "broken";
  if (carryOn && run.attempt < MAX_JOB_ATTEMPTS) {
    await storage.put<Stored>(RUN_KEY, { ...run, sent, attempt: run.attempt + 1, tries: 0 });
    await tell({ state: "running", status: `Still going: part ${run.attempt + 1} of at most ${MAX_JOB_ATTEMPTS}` });
    await storage.setAlarm(deps.now());
    return log("carry_on", run.id);
  }

  const update: Omit<JobUpdate, "id" | "first"> =
    outcome.kind === "answer"
      ? { state: "done", status: outcome.status, texts: outcome.texts }
      : outcome.kind === "stop"
        ? { state: "failed", ...(outcome.text ? { texts: [outcome.text] } : {}) }
        : { state: "failed", texts: [JOB_LINES.failed(run.title)] };
  await finish(storage, { ...run, sent }, update, tell, deps);
}

/** Hand the inbox the job's last word; one it didn't take is kept and offered again, never run again. */
async function finish(
  storage: InboxStorage,
  run: Stored,
  update: Omit<JobUpdate, "id" | "first">,
  tell: (update: Omit<JobUpdate, "id" | "first">) => Promise<boolean>,
  deps: JobDeps,
): Promise<void> {
  if (!(await tell(update)) && (run.owedTries ?? 0) + 1 < MAX_JOB_TRIES) {
    await storage.put<Stored>(RUN_KEY, { ...run, owed: update, owedTries: (run.owedTries ?? 0) + 1 });
    await storage.setAlarm(deps.now() + RETRY_MS);
    return log("report_retry", run.id);
  }
  await storage.delete(RUN_KEY);
  log(update.state, run.id);
}

/** What the job's turn is asked with. */
function ask(run: JobRun): JobAsk {
  return {
    id: run.id,
    title: run.title,
    brief: run.brief,
    attempt: run.attempt,
    ...(run.doneWhen ? { doneWhen: run.doneWhen } : {}),
    ...(run.tainted ? { tainted: true as const } : {}),
  };
}

/** The first line of an answer, as the job's status once it is done. */
function firstLine(text: string): string {
  return text.split("\n").find((part) => part.trim() !== "")?.trim().slice(0, 280) ?? "";
}

function outcomeOf(answer: AgentAnswer, texts: (text: string) => string[]): Outcome {
  if (answer.kind === "answer") {
    return { kind: "answer", texts: answer.text ? texts(answer.text) : [], exhausted: answer.exhausted === true, status: firstLine(answer.text) };
  }
  if (answer.kind === "not_started") return { kind: "retry" };
  if (answer.kind === "unavailable") return { kind: "broken" };
  return { kind: "stop", text: undefined };
}

async function phoneTurn(run: JobRun, deps: JobDeps, onProgress: (text: string) => Promise<void>): Promise<Outcome> {
  if (run.origin.kind !== "phone") return { kind: "stop" };
  const session = await openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, run.origin.phone);
  // Unlinked since: nothing of theirs is read, and nothing is said.
  if (session.status !== "linked") return { kind: "stop" };
  const answer = await askAgent(
    deps.fetch,
    deps.gatewayOrigin,
    session.accessToken,
    run.origin.question,
    onProgress,
    session.timeZone,
    [],
    undefined,
    [],
    undefined,
    { job: ask(run) },
  );
  const outcome = outcomeOf(answer, (text) => textsWithExact(text, answer.kind === "answer" ? answer.verbatim : []));
  if (outcome.kind === "stop") return { kind: "stop", text: JOB_LINES.failed(run.title) };
  return outcome;
}

async function groupTurn(run: JobRun, deps: JobDeps): Promise<Outcome> {
  if (run.origin.kind !== "group" || !deps.sendblue) return { kind: "stop" };
  const message = run.origin.message;
  // Read again now: more people only ever narrow what Tex may use.
  const members = await readGroupMembers(deps.fetch, deps.sendblue, message.groupId);
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane({ ...deps, sendblue: deps.sendblue }, message, people, null);
  // Muted, stopped or no longer shared: the chat said so, and the job ends quietly.
  if (asked.status !== "ready" || asked.accessToken === undefined) return { kind: "stop" };
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await sha256Hex(people.join(",")),
    ...(asked.handle ? { from: asked.handle } : {}),
    chat: [],
  };
  const result = await post(
    deps.fetch,
    "gateway",
    `${deps.gatewayOrigin}/agent`,
    asked.accessToken,
    { question: message.text, group, job: ask(run), ...(asked.timeZone ? { timeZone: asked.timeZone } : {}) },
    GROUP_JOB_TIMEOUT_MS,
  ).catch(() => null);
  if (result === null) return { kind: "broken" };
  const outcome = outcomeOf(agentAnswer(result.status, result.json), textsFromAnswer);
  if (outcome.kind !== "answer") return outcome;
  // Sent only to the people it was written for, as a group's answer is (`groupInbox.ts`).
  const now = await readGroupMembers(deps.fetch, deps.sendblue, message.groupId);
  if (now === null) return { kind: "stop", text: GROUP_LINES.failed };
  if (now.some((phone) => phone !== message.line && !people.includes(phone))) return { kind: "stop", text: GROUP_LINES.joined };
  return outcome;
}
