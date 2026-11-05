/**
 * One part of a background job run on the person's own computer
 * (docs/decisions/texting-assistant/machines.md). The job's object asks the
 * gateway, with the job's own texting grant, to start the part there
 * (`/agent/machine/assign`), then reads the run (`/agent/machine/run`) until
 * it ends, streaming each step it took to the chat as a cloud part's steps
 * are. The gateway mints the part's own grant, and the computer's owner rules
 * decide, at every part, whether it may run at all.
 *
 * A part is fifteen minutes. One that ran out of time is carried on by the
 * next part, which resumes the same Claude Code or Codex session on the
 * machine, so the work goes on where it was; so does one whose machine
 * dropped and came back. The run in progress is kept on the job's run
 * (`machineRun`), so a pass that restarts reads the same run instead of
 * starting a second one, and the session id (`machineSession`) is kept
 * across parts and across a restart of the whole job.
 */

import { openSession, post, ServiceError, type Fetch } from "./clients";
import { textsFromAnswer } from "./format";
import type { JobAsk, JobRun, JobVerdict, StepHow } from "./jobs";

/** One part's length on a machine; the advisor's check comes between parts. */
export const MACHINE_PART_MS = 15 * 60 * 1000;
/** How often a running part is read. */
export const MACHINE_POLL_MS = 10_000;
/** How long a part waits for a computer owner's "Ask me first" yes, and how often it asks again meanwhile. */
const ASK_WAIT_MS = 10 * 60 * 1000;
const ASK_POLL_MS = 60_000;
/** How long past a part's deadline it is still read, for the runner's last word. */
const GRACE_MS = 2 * 60 * 1000;
/** A texting token lasts fifteen minutes: one older than this is replaced before the next read. */
const TOKEN_REFRESH_MS = 10 * 60 * 1000;
const MAX_ADVICE = 8_000;

export type MachineDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** What the part came to, in the job's own terms (`jobRun.ts` `Outcome`). */
export type MachineOutcome =
  | { kind: "answer"; texts: string[]; exhausted: boolean; status: string; steered: string[]; check?: MachineCheck }
  | { kind: "retry" }
  | { kind: "broken" }
  | { kind: "stop"; text?: string };

/** The advisor's check of an ended part (`/agent/machine/check`, `apps/mcp/src/agent/jobCheck.js`), as a cloud part's answer carries it. */
export type MachineCheck = { verdict?: JobVerdict; advice?: string; unfinished?: true; untrusted?: true; idle?: true };

const VERDICTS = new Set<string>(["done", "keep_going", "waiting", "stuck"]);

/** The gateway's answer, read strictly: anything else is no check, and the part's own outcome decides as before. */
function checkOf(answer: Record<string, unknown>): MachineCheck | undefined {
  if (answer.ok !== true) return undefined;
  const verdict = typeof answer.verdict === "string" && VERDICTS.has(answer.verdict) ? (answer.verdict as JobVerdict) : undefined;
  return {
    ...(verdict ? { verdict, ...(typeof answer.advice === "string" && answer.advice !== "" ? { advice: answer.advice.slice(0, 600) } : {}) } : {}),
    ...(verdict && answer.unfinished === true ? { unfinished: true as const } : {}),
    ...(answer.untrusted === true ? { untrusted: true as const } : {}),
    ...(answer.idle === true ? { idle: true as const } : {}),
  };
}

/** The running part, for a later text to reach (`jobRun.ts` `steerJob`). */
export type MachineLive = { workspaceId: string; runId: string; accessToken: string; delivered: string[] };

type RunRead = { state: string; steps: { seq: number; tool: string; action: string | null; target: string | null }[]; result: { outcome: string; answer?: string; session?: string | null; error?: string | null } | null; session: string | null };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Words a refusal is told to them in: the job ends, and "pick it back up" starts it again once fixed. */
export function refusedText(title: string, name: string, code: string): string {
  const where = `"${title}" on ${name}`;
  switch (code) {
    case "offline":
      return `I couldn't start ${where}: it's offline. Open it, then text me to pick it back up.`;
    case "not_ready":
    case "tool":
      return `I couldn't start ${where}: it isn't ready to run the coding tool. Check it's signed in, then text me to pick it back up.`;
    case "plan_limit":
      return `I paused ${where}: your plan's limit is nearly used up there. Text me once it resets and I'll pick it back up.`;
    case "busy":
      return `I couldn't start ${where}: every slot on it is taken. Text me once one finishes.`;
    case "limit_day":
    case "limit_week":
    case "limit_others":
      return `I paused ${where}: it has used the time you allowed Tex there. You can raise it in Tex's settings, then text me to pick it back up.`;
    case "folder":
      return `I couldn't start ${where}: Tex may not work in that folder there. On that computer, open the Context app, Settings › Tex, and add it.`;
    case "rule":
      return `I couldn't start ${where}: its owner hasn't let this chat use it.`;
    case "ask_first":
      return `I couldn't start ${where}: its owner hasn't said yes yet. Text me to try again once they have.`;
    case "declined":
      return `I didn't start ${where}: its owner said no this time.`;
    default:
      return `I couldn't start ${where}. Text me to try again.`;
  }
}

function stepText(step: RunRead["steps"][number]): string {
  return [step.tool, step.action, step.target].filter((part) => typeof part === "string" && part !== "").join(" ").slice(0, 200);
}

/** What the part is told beyond the brief: their later texts, and what the last part got to and what it still needs. */
function adviceFor(job: JobAsk): string {
  const parts = [
    ...(job.followUps?.length ? [`They texted since: ${job.followUps.map((text) => `"${text}"`).join(" ")}`] : []),
    ...(job.draft ? [`Where the last part got to: ${job.draft}`] : []),
    ...(job.advice ? [`Still to do: ${job.advice}`] : []),
  ];
  return parts.join("\n\n").slice(0, MAX_ADVICE);
}

const firstLine = (text: string) => text.split("\n").find((part) => part.trim() !== "")?.trim().slice(0, 280) ?? "";

/**
 * Run (or carry on reading) this part on the machine. `keep` stores the run's
 * changed fields, so a pass that restarts finds the run in progress.
 */
export async function machineTurn(
  run: JobRun,
  job: JobAsk,
  deps: MachineDeps,
  hooks: {
    keep: (patch: Partial<JobRun>) => Promise<void>;
    onStep: (text: string, how?: StepHow) => Promise<void>;
    /** The gateway's line asking a lent computer's owner for a 👍 in the group, handed to the chat's Tex (`jobRun.ts`). */
    askOwner?: (line: string) => Promise<void>;
    live: (running: MachineLive | null) => void;
    steerIds: string[];
    /** A group chat's job: its grant, minted again as its own turn's is (`jobRun.ts` `groupGrant`), or null to stop. */
    groupGrant?: () => Promise<string | null>;
  },
): Promise<MachineOutcome> {
  const machine = run.machine;
  if (machine === undefined || (run.origin.kind === "group" && hooks.groupGrant === undefined)) return { kind: "stop" };
  const origin = run.origin;
  const sleep = deps.sleep ?? pause;
  let token = "";
  let tokenAt = 0;
  // A person's own texts: their texting grant. A group chat: the chat's, on the computers lent to it.
  const grant = async (): Promise<string | null> => {
    if (origin.kind === "group") return (await hooks.groupGrant?.()) ?? null;
    const session = await openSession(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, origin.phone);
    // Unlinked since: nothing of theirs runs, and nothing is said.
    return session.status === "linked" ? session.accessToken : null;
  };
  const fresh = async (): Promise<boolean> => {
    if (token !== "" && deps.now() - tokenAt < TOKEN_REFRESH_MS) return true;
    const minted = await grant();
    if (minted === null) return false;
    token = minted;
    tokenAt = deps.now();
    return true;
  };
  const ask = async (path: string, body: Record<string, unknown>) => {
    const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}${path}`, token, { workspaceId: machine.workspaceId, ...body });
    if (status !== 200) throw new ServiceError("gateway", status);
    return (json ?? {}) as Record<string, unknown>;
  };
  if (!(await fresh())) return { kind: "stop" };

  let current = run.machineRun?.part === run.attempt ? run.machineRun : undefined;
  if (current === undefined) {
    const advice = adviceFor(job);
    // The part's fifteen minutes count from this pass, so waiting for a yes never runs a pass past its step's limit.
    const partEnds = deps.now() + MACHINE_PART_MS;
    const assign = () => ask("/agent/machine/assign", {
      machineId: machine.machineId,
      jobId: run.id,
      part: Math.min(run.attempt, 200),
      title: run.title,
      tool: machine.tool,
      folder: machine.folder,
      ...(machine.repo ? { repo: machine.repo } : {}),
      // Plain Claude Code, as in their own terminal (owner, 2026-11-04): who may ask is the owner's control.
      permission: "full",
      brief: run.brief,
      doneWhen: run.doneWhen ?? "",
      ...(advice ? { advice } : {}),
      ...(run.machineSession ? { resumeSession: run.machineSession } : {}),
      deadline: partEnds,
    });
    let answer = await assign();
    // "Ask me first": the computer's owner answers in the app; the part waits for it, then starts or says why not.
    const waitUntil = deps.now() + ASK_WAIT_MS;
    if (answer.code === "ask_first") await hooks.onStep(`Waiting for the owner of ${machine.name} to say yes`);
    // Asked just now in a group: the chat is asked, and the owner's 👍 there is the yes (`apps/mcp/src/machines/groupAsk.js`).
    if (answer.code === "ask_first" && typeof answer.askLine === "string" && answer.askLine !== "") await hooks.askOwner?.(answer.askLine);
    while (answer.code === "ask_first" && deps.now() < waitUntil) {
      await sleep(ASK_POLL_MS);
      if (!(await fresh())) return { kind: "stop" };
      answer = await assign();
    }
    if (answer.ok !== true || typeof answer.runId !== "string") {
      return { kind: "stop", text: refusedText(run.title, machine.name, typeof answer.code === "string" ? answer.code : "") };
    }
    current = { runId: answer.runId, part: run.attempt, deadline: typeof answer.deadline === "number" ? Math.min(answer.deadline, partEnds) : partEnds };
    run.machineRun = current;
    await hooks.keep({ machineRun: current });
  }

  const delivered: string[] = [];
  hooks.live({ workspaceId: machine.workspaceId, runId: current.runId, accessToken: token, delivered });
  let shown = 0;
  try {
    for (;;) {
      if (!(await fresh())) return { kind: "stop" };
      hooks.live({ workspaceId: machine.workspaceId, runId: current.runId, accessToken: token, delivered });
      const answer = await ask("/agent/machine/run", { runId: current.runId });
      // The run is gone (another person's id, or kept past its day): this part starts again.
      if (answer.ok !== true) {
        delete run.machineRun;
        await hooks.keep({ machineRun: undefined });
        return { kind: "broken" };
      }
      const read = answer.run as RunRead;
      for (const step of read.steps.filter((step) => step.seq > shown)) await hooks.onStep(stepText(step));
      shown = Math.max(shown, ...read.steps.map((step) => step.seq));
      const session = read.result?.session ?? read.session;
      if (session && session !== run.machineSession) {
        run.machineSession = session;
        await hooks.keep({ machineSession: session });
      }
      if (read.state === "ended" && read.result) {
        delete run.machineRun;
        await hooks.keep({ machineRun: undefined });
        // The advisor's check and the report take a while after the computer stops: say so, so its last step does not look live.
        if (read.result.outcome === "finished" || read.result.outcome === "limit") await hooks.onStep(`${read.result.outcome === "finished" ? "Done" : "Out of time for now"} on ${machine.name} · checking the work`);
        const words = (read.result.answer ?? "").trim();
        const steered = [...hooks.steerIds, ...delivered];
        // The advisor checks the part against the finish line, as it checks a cloud part; unreachable, the outcome alone decides.
        const ended = current.runId;
        const checked = async () =>
          checkOf(await ask("/agent/machine/check", { runId: ended, job: { title: job.title, brief: job.brief, doneWhen: job.doneWhen ?? "", attempt: job.attempt, followUps: job.followUps ?? [], advice: job.advice ?? "" } }).catch(() => ({})));
        switch (read.result.outcome) {
          case "finished": {
            const check = await checked();
            return { kind: "answer", texts: words ? textsFromAnswer(words) : [], exhausted: false, status: firstLine(words), steered, ...(check ? { check } : {}) };
          }
          case "limit": {
            // Out of time for this part: the next resumes the same session where it stopped, on the advisor's advice.
            const check = await checked();
            return { kind: "answer", texts: words ? textsFromAnswer(words) : [], exhausted: true, status: firstLine(words) || "Still going on your computer", steered, ...(check ? { check } : {}) };
          }
          case "cancelled":
            return { kind: "stop" };
          default:
            // Failed or lost with the machine: the next part resumes the session if the tool named one.
            return { kind: "broken" };
        }
      }
      if (deps.now() > current.deadline + GRACE_MS) {
        // Past its deadline with no word: the runner was told to end it at the deadline, so it is treated as cut off.
        await ask("/agent/machine/cancel", { runId: current.runId, reason: "limit" }).catch(() => null);
        delete run.machineRun;
        await hooks.keep({ machineRun: undefined });
        return { kind: "answer", texts: [], exhausted: true, status: "Still going on your computer", steered: [...hooks.steerIds, ...delivered] };
      }
      await sleep(MACHINE_POLL_MS);
    }
  } finally {
    hooks.live(null);
  }
}
