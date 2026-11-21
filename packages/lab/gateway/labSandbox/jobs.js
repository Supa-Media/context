/**
 * BACKGROUND JOBS IN A LAB TEST CHAT (Dev2, 2026-11-16: "It actually does the research things and sends messages and
 * subagent responses to the sandbox chat"; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * A turn that starts a job does what production does: the chat object spawns the job's own object (`/job-start`,
 * `packages/tex/worker/jobs.ts` `startJobs`), and each pass of it runs through the config graph's job node (`job`,
 * `graph/nodes/job.js`), exactly as the gateway's `TexJob` runs one (`texJob.js` `pass`): the node calls the texting
 * Worker's `runJob` on the job's object, which asks `/agent` for the job's turn (on the test chat's fences: reads real,
 * writes kept in the test chat) and reports to the chat object (`/job-update`), whose own turn and line text the
 * result. Hand-back judge, Job check and the Advisor on job mail are reached through the job node's wires.
 *
 * Where the gateway has the `LAB_JOB` binding, the job is born in a real job box (`jobBox.js`): the gateway's `TexJob`
 * class on its own Durable Object, its own alarm driving every pass (`jobDrive.ts`), its calls out answered here on this
 * text's fences, and this file only watches it (`runBox`) until it is done or the limit is up, then stops it. Every node
 * its passes run is a step as it starts and ends. A job on a computer, one past `MAX_JOBS`, and a deployment without the
 * binding take the path below.
 *
 * Without a box, the job's object is the Worker's `SenderInbox` on storage in memory,
 * reached through `sandboxInboxes`, a namespace that holds this text's chat object and its jobs and nothing else, and
 * the passes are driven here (the Worker's workflow is not reached), one after another, until the job says done or
 * `JOB_LIMIT_MS` runs out. A job that would run on one of the person's computers is never run: its pass is refused, the
 * refusal is a step, and the job's failure (`/job-failed`) tells the chat as production would.
 */

import { gatewayGraph } from "../fromGateway/agent_graph_gatewayGraph.js";
import { TEX_CONFIG, withDraft } from "../fromGateway/agent_texConfig.js";
import { LAB_STATE_PATH, LAB_STOP_PATH } from "./jobBox.js";

/** A job's passes in a test chat stop after this long (production's limit is 30 minutes, `jobRun.ts`). */
export const JOB_LIMIT_MS = 15 * 60_000;
/** The most passes one job runs here (production: 10 parts and its retries). */
export const MAX_PASSES = 14;
/**
 * The most jobs one test text runs, a job's report turn's own included: a turn that starts a job on every report would
 * otherwise never end. One more is refused, as a step, and listed.
 */
export const MAX_JOBS = 6;
/** The longest wait between passes a test chat keeps (a retry's backoff, `jobRun.ts`). */
const MAX_WAIT_MS = 60_000;
/** The key the texting Worker keeps a job's run under (`packages/tex/worker/jobs.ts` `RUN_KEY`). */
const RUN_KEY = "jobrun";
/** A job's text keeps its running mark fresh at least this often, so a long job is never taken for a dead turn. */
export const BEAT_MS = 60_000;
/** How often a job box is looked at while it runs. */
export const BOX_POLL_MS = 1_500;

/**
 * `sleep`, in pieces no longer than `everyMs` with `beat()` before each: a job's wait (and its whole run, up to 15
 * minutes) outlasts `harness.js` `RUNNING_STALE_MS`, and a mark left unrefreshed that long would let a new text in.
 */
export function beatingSleep(sleep, beat, everyMs = BEAT_MS) {
  return async (ms) => {
    let left = Math.max(0, ms);
    do {
      beat();
      const piece = Math.min(left, everyMs);
      await sleep(piece);
      left -= piece;
    } while (left > 0);
    beat();
  };
}
const NAME_HEADER = "x-inbox-name";

/** An object's name as the Worker's stubs carry it: its own name, never the place prefix. */
const nameOf = (request, id) => request.headers.get(NAME_HEADER) ?? String(id?.name ?? "").replace(/^enam:/, "");

/** A call as the inner object takes it: the name header off, as `texJob.js` takes it off (the move gate never runs). */
function inner(request) {
  const headers = new Headers(request.headers);
  headers.delete(NAME_HEADER);
  return new Request(request.url, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? null : request.body, duplex: "half" });
}

/**
 * The `SENDER_INBOX` a test text's chat object and its jobs see: its own chat object, its own jobs (made on their
 * `/job-start` by `makeJob(name)`), a group's directory entry answered as kept, and nothing else. A call to any other
 * object is refused and listed. `jobs` keeps each job's `{ name, inbox, storage, parent }`; `chat` is set once the chat
 * object exists.
 */
export function sandboxInboxes({ gate, makeJob, parentOfJob = () => null, makeBox = null }) {
  const jobs = new Map();
  /** The names a job reports to: its `run.inbox`, as the chat object gave it at `/job-start`. */
  const chats = new Set();
  /** Asks and answers this text's turn sent another chat (`crossChat.ts`), carried by the route afterwards (`crossRuns.js`). */
  const crossOut = [];
  const registry = { chat: null, jobs, chats, crossOut };
  const reach = async (name, request) => {
    const path = new URL(request.url).pathname;
    // Another group chat's directory entry: a test chat answers with the chat's own key, which the route opens a linked
    // test chat on (`crossRuns.js`), so an ask from here never reaches the real chat.
    if (path === "/chat-where") return Response.json(name.startsWith("group-key:") ? { ok: true, groupId: name.slice("group-key:".length), line: "lab" } : { ok: true });
    if ((path === "/cross-ask" || path === "/cross-answer") && request.method === "POST" && !chats.has(name)) {
      const body = await request.clone().json().catch(() => null);
      if (body === null || typeof body !== "object") return Response.json({ outcome: "bad" }, { status: 400 });
      crossOut.push({ to: name, path, body });
      gate.record({ kind: "Chat", summary: path === "/cross-ask" ? `asked Tex in another chat: ${String(body.what ?? "").slice(0, 140)}` : "answered the chat that asked", tool: path === "/cross-ask" ? "ask_chat" : "chatAnswer" });
      return Response.json({ outcome: "queued" });
    }
    if (name.startsWith("job:")) {
      let job = jobs.get(name);
      if (!job) {
        if (path !== "/job-start" || request.method !== "POST") return Response.json({ here: false }, { status: 404 });
        const run = await request.clone().json().catch(() => null);
        if (typeof run?.inbox === "string") chats.add(run.inbox);
        // On a real job box (`jobBox.js`), unless it would run on a computer (never run here) or one too many (refused).
        const boxes = [...jobs.values()].filter((kept) => kept.boxed).length;
        const box = makeBox !== null && run?.machine === undefined && boxes < MAX_JOBS ? makeBox(name) : null;
        if (box === null) job = { name, ...makeJob(name), parent: parentOfJob() };
        else {
          // Its start is held until its turn in `runJobs`, as a job in memory waits for its first pass: the text's own
          // answer is in first, and one box runs at a time, so each pass's steps hang under it alone.
          job = { name, inbox: box, boxed: true, passes: 0, failedLine: false, parent: parentOfJob(), start: await request.clone().text() };
          jobs.set(name, job);
          return Response.json({ ok: true });
        }
        jobs.set(name, job);
      }
      if (job.boxed) {
        await startBox(job);
        return await job.inbox.fetch(request);
      }
      return await job.inbox.fetch(inner(request));
    }
    if (chats.has(name) && registry.chat !== null) return await registry.chat.fetch(inner(request));
    gate.record({ kind: "Job", summary: `asked another object ${path}` });
    return new Response(null, { status: 503 });
  };
  registry.namespace = {
    idFromName: (name) => ({ name, toString: () => "" }),
    idFromString: () => {
      throw new TypeError("a test chat reaches no other object");
    },
    get: (id) => ({ fetch: (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      return reach(nameOf(request, id), request);
    } }),
  };
  return registry;
}

/**
 * Runs every job this text's turn started, each to its end or `JOB_LIMIT_MS`, its passes through the job node of the
 * test chat's graph (`config`, the draft over main's). `drain` runs the chat object's own work a pass handed it (a
 * job's report turn) before the next pass. `book` is the text's steps (`steps.js`): each pass is a step under the step
 * that started the job, and what the pass runs hangs under it. Never throws.
 */
export async function runJobs({ registry, gate, book, config = null, drain = async () => {}, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limitMs = JOB_LIMIT_MS }) {
  const deadline = now() + limitMs;
  const graphConfig = config ? withDraft(TEX_CONFIG, config) : TEX_CONFIG;
  const ran = [];
  const wait = beatingSleep(sleep, () => gate.show?.());
  // Jobs a job's report turn starts are added as this runs, and are run in turn, up to `MAX_JOBS`.
  for (const job of registry.jobs.values()) {
    if (job.done) continue;
    job.done = true;
    const jobId = job.name.replace(/^job:/, "");
    // On its own box it is already running (its alarm started it at birth): watched, and stopped at the end.
    if (job.boxed) {
      const { passes, outcome } = await runBox({ job, jobId, gate, book, drain, now, wait, deadline });
      ran.push({ jobId, passes, outcome, box: true });
      console.log(JSON.stringify({ event: "lab_sandbox_job", passes, outcome, box: true }));
      continue;
    }
    if (gate.cancelled) {
      // Reset while this text ran: its jobs never start, as the test chat they would write to is gone.
      ran.push({ jobId, passes: 0, outcome: "reset" });
      continue;
    }
    if (ran.length >= MAX_JOBS) {
      const refused = book.begin({ node: "job", parent: job.parent ?? book.tail, input: { jobId }, bg: true });
      book.end(refused, { out: { refused: `a test text runs at most ${MAX_JOBS} jobs` }, ms: 0, ok: false });
      gate.record({ kind: "Job", summary: `job ${jobId.slice(0, 12)} not run: ${MAX_JOBS} jobs already ran for this text` });
      continue;
    }
    const graph = gatewayGraph({
      config: graphConfig,
      log: (run) => gate.onNode(run),
      onStart: (run) => {
        gate.onStart(run);
        // The pass is what the job's own turn and report hang under; the job node's own wires come from the runner.
        if (run.node === "job" && typeof run.parent !== "string") book.setAnchor(book.stepOf(run.id));
      },
    });
    const read = async () => {
      const run = await job.storage.get(RUN_KEY);
      return { attempt: run?.attempt, sent: run?.sent, running: run !== undefined };
    };
    const call = (path) => job.inbox.fetch(new Request(`https://inbox${path}`, { method: "POST" }));
    const pass = async (step) => {
      book.setAnchor(job.parent ?? book.tail);
      // The job's object is driven here, never by its own alarm (`jobRun.ts` `acceptJob` set one, with no workflow).
      job.storage.alarm = null;
      const result = await graph.runNode("job", { step, jobId }, { job: { call, read } }, "TexJob").catch((error) => ({ ran: true, error }));
      if (result?.error) return { kind: "done", failed: String(result.error?.message ?? result.error).slice(0, 200) };
      if (!result?.ran) return { kind: "done", off: true };
      const output = result.output ?? {};
      return output.next === "after" ? { kind: "after", ms: output.ms ?? 0 } : { kind: output.next ?? "done" };
    };
    let passes = 0;
    let outcome = "done";
    try {
      const run = await job.storage.get(RUN_KEY);
      if (run?.machine !== undefined) {
        // A job on one of the person's computers: refused, as a step, and ended the way production ends a failed one.
        book.setAnchor(job.parent ?? book.tail);
        const refused = book.begin({ node: "job", parent: job.parent ?? book.tail, input: { jobId, on: "computer" }, bg: true });
        book.end(refused, { out: { refused: "a job on a person's computer is never run in a Lab test chat" }, ms: 0, ok: false });
        gate.record({ kind: "Refused", summary: `job "${String(run.title ?? jobId).slice(0, 80)}" on a computer (not run in a test chat)` });
        await pass("failed");
        await drain();
        outcome = "refused";
      } else {
        while (passes < MAX_PASSES && now() < deadline) {
          if (gate.cancelled) {
            outcome = "reset";
            break;
          }
          gate.show?.();
          passes += 1;
          const next = await pass("pass");
          await drain();
          if (next.kind === "done") {
            outcome = next.failed ? "failed" : next.off ? "off" : "done";
            break;
          }
          if (next.kind === "after") await wait(Math.max(0, Math.min(next.ms, MAX_WAIT_MS, deadline - now())));
          if (passes >= MAX_PASSES || now() >= deadline) outcome = "cut";
        }
      }
    } catch (error) {
      outcome = "failed";
      console.log(JSON.stringify({ event: "lab_sandbox_job_failed", reason: String(error?.name ?? "error").slice(0, 40) }));
    } finally {
      book.setAnchor(null);
    }
    if (outcome === "cut") gate.record({ kind: "Job", summary: `job ${jobId.slice(0, 12)} stopped after ${passes} passes (the test chat's limit)` });
    ran.push({ jobId, passes, outcome });
    console.log(JSON.stringify({ event: "lab_sandbox_job", passes, outcome }));
  }
  return ran;
}

/**
 * One job on its own box (`jobBox.js`): its alarm runs the passes, and this only drains the chat object between looks
 * (a pass's report is a turn there) until the box has no job left, the limit is up, or the test chat is Reset; then the
 * box is stopped, which deletes it. Answers its passes, as the box told them, and how it ended. Never throws.
 */
/**
 * A node a job box's graph ran (`jobBox.js`), as it started or ended: a step on the run card, as a job in memory's are.
 * A pass (the job node) hangs under the step that started its job, and what it runs after under the pass; each one
 * counted on its job, and the "couldn't finish" line noted.
 */
export function boxNode({ phase, run, registry, gate, book }) {
  if (typeof run?.node !== "string" || typeof run.id !== "string") return;
  const pass = run.node === "job" && typeof run.parent !== "string";
  const job = pass ? registry.jobs.get(`job:${String(run.input?.jobId ?? "")}`) : undefined;
  if (phase === "start") {
    if (pass) book.setAnchor(job?.parent ?? book.tail);
    gate.onStart(run);
    if (pass) {
      book.setAnchor(book.stepOf(run.id));
      if (job !== undefined) {
        job.passes += run.input?.step === "failed" ? 0 : 1;
        if (run.input?.step === "failed") job.failedLine = true;
      }
    }
  } else gate.onNode(run);
  gate.show?.();
}

/** Sends a box's held start (`/job-start`), once: the box is born, and its alarm runs its first pass. */
export async function startBox(job) {
  if (typeof job.start !== "string") return;
  const body = job.start;
  job.start = null;
  const answer = await job.inbox.fetch(new Request("https://inbox/job-start", { method: "POST", headers: { "content-type": "application/json" }, body }));
  if (!answer.ok) throw new Error(`the job box refused its start (${answer.status})`);
}

export async function runBox({ job, jobId, gate, book, drain, now, wait, deadline }) {
  const look = async () => {
    const answer = await job.inbox.fetch(new Request(`https://inbox${LAB_STATE_PATH}`)).catch(() => null);
    return answer?.ok ? await answer.json().catch(() => null) : null;
  };
  let outcome = "cut";
  let state = null;
  try {
    // What its passes run hangs under the step that started it, each pass's own under that pass (`object` `node`).
    book.setAnchor(job.parent ?? book.tail);
    if (gate.cancelled) throw Object.assign(new Error("reset"), { name: "reset" });
    await startBox(job);
    while (now() < deadline) {
      if (gate.cancelled) {
        outcome = "reset";
        break;
      }
      await drain();
      state = await look();
      if (state !== null && (state.gone || !state.here || (!state.running && state.drive === null))) {
        outcome = state.gone ? "gone" : job.failedLine ? "failed" : "done";
        break;
      }
      await wait(Math.max(0, Math.min(BOX_POLL_MS, deadline - now())));
    }
    await drain();
  } catch (error) {
    outcome = error?.name === "reset" ? "reset" : "failed";
    if (outcome === "failed") console.log(JSON.stringify({ event: "lab_sandbox_job_failed", box: true, reason: String(error?.name ?? "error").slice(0, 40) }));
  } finally {
    book.setAnchor(null);
    // A box never born (its start held, then Reset) has nothing to stop.
    if (typeof job.start === "string") job.start = null;
    else await job.inbox.fetch(new Request(`https://inbox${LAB_STOP_PATH}`, { method: "POST" })).catch(() => null);
  }
  const said = { done: "done", failed: "ended with its couldn't-finish line", cut: "stopped at the test chat's limit", reset: "stopped by Reset", gone: "lost its run" }[outcome];
  gate.record({ kind: "Job", summary: `job ${jobId.slice(0, 12)} ran on its own job box (LabJob, driven by its alarm): ${job.passes} pass${job.passes === 1 ? "" : "es"}, ${said}` });
  return { passes: job.passes, outcome };
}
