/**
 * A LAB TEST CHAT'S JOB ON A REAL JOB BOX (2026-11-21: the job box's memory fix and its own alarm could not be tried in
 * the Lab, since a test chat's jobs ran in memory inside the test chat's object, their passes driven by a loop and their
 * alarm switched off; decision `docs/decisions/texting-assistant/lab-sandbox.md`).
 *
 * A job a test text starts is born in a `LabJob` Durable Object: the gateway's `TexJob` class itself
 * (`packages/tex/gateway/texJob.js`), given the fence below. Its own alarm drives every pass (`jobDrive.ts`), each pass is
 * the job node on the test chat's draft, its node log is kept, and its turn leaves the box over a real hop, exactly as a
 * real job's do. What the fence changes is only what the box reaches outside itself: every call (the gateway's
 * `/agent` and texting routes, the control plane, the chat's object and other jobs) goes to the test chat's own object
 * (`/job-out/*`), which answers it on the fences of the text that started the job (`chatRun.js`): reads real, writes kept
 * in the test chat, nothing sent. The box holds no token and no secret: only the test chat's object name and the run's
 * key, a random lookup that dies with the run.
 *
 * Each node the box's graph runs is told to the test chat's object as it starts and ends, so the run card shows every
 * pass, its tries and what it ran as it happens. When the run is over (its job done, cut at the test chat's limit, or
 * Reset), the test chat's object stops the box, which deletes everything it kept; a box whose run is gone (a deploy
 * restarted the test chat's object) is answered "gone" and deletes itself on its next alarm.
 */

import { TEX_CONFIG, withDraft } from "../fromGateway/agent_texConfig.js";
import { LAB_SANDBOX_KEY } from "../fromGateway/labSandbox_policy.js";
import { objectByName } from "../fromGateway/objectPlace.js";

/** Where the box keeps its test chat: `{ sandbox, run }`. */
export const LAB_KEY = "__lab";
/** Set once the box's run is over: its next alarm deletes everything. */
export const LAB_GONE_KEY = "__lab_gone";
/** The headers a box is born with: its test chat's object name, and the run's key. */
export const LAB_SANDBOX_HEADER = "x-lab-sandbox";
export const LAB_RUN_HEADER = "x-lab-run";
/** The box's own routes, for the test chat's object: what it is at, and stop. */
export const LAB_STATE_PATH = "/lab-state";
export const LAB_STOP_PATH = "/lab-stop";
/** The test chat's object answers a box's calls under this path (`object.js`). */
export const JOB_OUT_PREFIX = "/job-out/";
const OUT_ORIGIN = "https://lab-sandbox.internal";
const URL_HEADER = "x-lab-url";
const NAME_HEADER = "x-lab-name";
const GONE_HEADER = "x-lab-gone";
/** The keys the texting Worker keeps a job's run and its driving under (`jobs.ts` `RUN_KEY`, `jobDrive.ts` `DRIVE_KEY`). */
const RUN_KEY = "jobrun";
const DRIVE_KEY = "jobdrive";
/** How soon a box whose run is gone deletes itself: after the pass that found out has ended. */
const GONE_IN_MS = 1_000;

const SANDBOX_NAME = /^labsandbox:[A-Za-z0-9_-]{1,80}:[A-Za-z0-9_-]{1,80}$/;
const RUN = /^[0-9a-f]{48}$/;

/** A run's key: random, in memory only, and dead with the run. */
export function runKey() {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The name a box is made under: one per test chat, text and job, so no two runs ever share one. */
export function boxName(sandbox, rowId, jobName) {
  return `${sandbox}/${rowId}/${jobName}`;
}

/** Calls the box makes in order, so a node's start reaches the test chat before the turn it starts does. */
const chains = new WeakMap();

/** The box's way to its test chat's object. */
function outOf(env, state, lab) {
  const stub = objectByName(env.LAB_SANDBOX, lab.sandbox);
  const send = async (kind, request, name = null) => {
    const headers = new Headers(request.headers);
    headers.set(LAB_RUN_HEADER, lab.run);
    headers.set(URL_HEADER, request.url);
    if (name !== null) headers.set(NAME_HEADER, name);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
    const answer = await stub.fetch(new Request(`${OUT_ORIGIN}${JOB_OUT_PREFIX}${kind}`, { method: request.method, headers, body }));
    if (answer.status === 410 && answer.headers.get(GONE_HEADER) === "1") await goneSoon(state);
    return answer;
  };
  return {
    /** A call the inner object made, answered by the test chat; after every node told before it. */
    forward: async (kind, request, name = null) => {
      await (chains.get(state.storage) ?? Promise.resolve());
      return await send(kind, request, name);
    },
    /** One of the box's own words to the test chat (a node started or ended), kept in order, never awaited by the node. */
    tell: (kind, fields) => {
      const next = (chains.get(state.storage) ?? Promise.resolve()).then(() => send(kind, new Request(`${OUT_ORIGIN}/`, { method: "POST", body: JSON.stringify(fields) }))).then(() => {}, () => {});
      chains.set(state.storage, next);
      return next;
    },
    /** What the run answers: the draft and the made-up addresses its fences answer. Throws when the run is gone. */
    setup: async () => {
      const answer = await send("setup", new Request(`${OUT_ORIGIN}/`, { method: "POST", body: "{}" }));
      if (!answer.ok) throw new Error(`the test chat's run is over (${answer.status})`);
      return await answer.json();
    },
  };
}

async function goneSoon(state) {
  await state.storage.put(LAB_GONE_KEY, true);
  await state.storage.setAlarm(Date.now() + GONE_IN_MS);
}

async function labOf(state) {
  const lab = await state.storage.get(LAB_KEY);
  if (typeof lab?.sandbox !== "string" || typeof lab?.run !== "string") throw new Error("not a Lab job box");
  return lab;
}

/**
 * A graph run as it travels to the test chat: plain JSON, its error said in words, the job node's input with the box's
 * pass and tries, and its ids (and its parent's) made the box's own, since every isolate counts runs from `r1`.
 */
export function plain(run, box, prefix) {
  const error = run?.error === undefined ? {} : { error: String(run.error?.message ?? run.error).slice(0, 300) };
  const own = (id) => (typeof id === "string" ? `${prefix}${id}` : id);
  let kept;
  try {
    kept = JSON.parse(JSON.stringify({ ...run, error: undefined }));
  } catch {
    kept = { id: run?.id, node: run?.node, parent: run?.parent, via: run?.via, at: run?.at, ms: run?.ms, ok: run?.ok };
  }
  const input = kept.node === "job" && kept.input && typeof kept.input === "object" ? { input: { ...kept.input, box } } : {};
  return { ...kept, ...error, ...input, id: own(kept.id), parent: own(kept.parent) };
}

/**
 * The `TexJob` fence (`texJob.js` `texJobClass`) a Lab test chat's job runs with: the box's birth, routes, alarm, graph
 * and env, each reaching only the test chat's object.
 */
export const labJobFence = {
  /** What a box keeps from its birth: its test chat and the run's key, or null when either is missing or malformed. */
  born(request) {
    const sandbox = request.headers.get(LAB_SANDBOX_HEADER);
    const run = request.headers.get(LAB_RUN_HEADER);
    if (sandbox === null || !SANDBOX_NAME.test(sandbox) || run === null || !RUN.test(run)) return null;
    return { [LAB_KEY]: { sandbox, run } };
  },

  /** The box's own routes: what it is at (`GET /lab-state`), and stop (`POST /lab-stop`). Null for any other call. */
  async serve(request, state) {
    const path = new URL(request.url).pathname;
    if (path === LAB_STATE_PATH && request.method === "GET") {
      const [lab, run, drive, gone, nodes] = await Promise.all([LAB_KEY, RUN_KEY, DRIVE_KEY, LAB_GONE_KEY, "jobnodes"].map((key) => state.storage.get(key)));
      return Response.json({ here: lab !== undefined, running: run !== undefined, drive: drive ?? null, gone: gone === true, nodes: Array.isArray(nodes) ? nodes.length : 0, alarm: (await state.storage.getAlarm?.()) ?? null });
    }
    if (path === LAB_STOP_PATH && request.method === "POST") {
      // Never deleted under a running pass: the alarm runs after it, and deletes everything then.
      await goneSoon(state);
      return Response.json({ stopping: true });
    }
    return null;
  },

  /** True when the alarm was the box's end: everything it kept is deleted, and nothing runs. */
  async alarm(state) {
    if ((await state.storage.get(LAB_GONE_KEY)) !== true) return false;
    await state.storage.deleteAlarm?.();
    await state.storage.deleteAll();
    console.log(JSON.stringify({ event: "lab_job_box", outcome: "deleted" }));
    return true;
  },

  /** The graph a pass runs on: the test chat's draft, every node told to the test chat as it starts and ends. */
  async graph(state, env) {
    const out = outOf(env, state, await labOf(state));
    const { config } = await out.setup();
    const drive = await state.storage.get(DRIVE_KEY);
    const box = { on: "LabJob", pass: drive?.pass ?? 0, tries: drive?.tries ?? 0, ...(drive?.failing ? { failing: true } : {}) };
    const prefix = `box:${String(await state.storage.get("__inbox_name")).replace(/^job:/, "").slice(0, 16)}:`;
    const gate = {
      record() {},
      onStart: (run) => void out.tell("node", { phase: "start", run: plain(run, box, prefix) }),
      onNode: (run) => void out.tell("node", { phase: "end", run: plain(run, box, prefix) }),
    };
    return { ...(config ? { config: withDraft(TEX_CONFIG, config) } : {}), env: { [LAB_SANDBOX_KEY]: gate } };
  },

  /** The env the inner object runs on: every way out goes to the test chat's object, and nothing else is bound. */
  async env(state, env) {
    const out = outOf(env, state, await labOf(state));
    const setup = await out.setup();
    const forward = (kind, name = null) => (input, init) => out.forward(kind, input instanceof Request && init === undefined ? input : new Request(input, init), name);
    return {
      FETCH: forward("fetch"),
      ...(setup.config ? { TEX_GRAPH: withDraft(TEX_CONFIG, setup.config) } : {}),
      GATEWAY_ORIGIN: setup.gateway,
      GATEWAY_TEXTS: { fetch: forward("texts") },
      CONTROL_PLANE_ORIGIN: setup.controlPlane,
      AGENT_WORKER_SECRET: setup.secret,
      SENDER_INBOX: {
        idFromName: (name) => ({ name, toString: () => "" }),
        idFromString: () => {
          throw new TypeError("a Lab job box reaches objects by name");
        },
        get: (id) => ({ fetch: forward("inbox", String(id?.name ?? "")) }),
      },
      LINQ_API_KEY: "",
      JOBS: "worker",
    };
  },
};

/** The runs a test chat's object holds now, by key (`openRun`): what a box's calls are answered with. */
const runs = new Map();

/**
 * Opens a run for boxes to reach: `entry` is `{ setup, env, namespace, node }`, filled in as the text's turn sets up.
 * Answers its key and `close()`; a box calling after it is closed is answered "gone".
 */
export function openRun(entry) {
  const key = runKey();
  runs.set(key, entry);
  return { key, entry, close: () => void runs.delete(key) };
}

/** A box's call (`/job-out/<kind>`), answered on its run's fences; "gone" (410) when its run is over. */
export async function serveJobOut(request) {
  const kind = new URL(request.url).pathname.slice(JOB_OUT_PREFIX.length);
  const entry = runs.get(request.headers.get(LAB_RUN_HEADER) ?? "");
  if (entry === undefined || entry.env === null) return Response.json({ error: "gone" }, { status: 410, headers: { [GONE_HEADER]: "1" } });
  if (kind === "setup") return Response.json(entry.setup);
  if (kind === "node") {
    const body = await request.json().catch(() => null);
    if (body !== null && (body.phase === "start" || body.phase === "end")) entry.node(body.phase, body.run ?? {});
    return Response.json({ ok: true });
  }
  const target = request.headers.get(URL_HEADER);
  if (target === null) return Response.json({ error: "bad_call" }, { status: 400 });
  const headers = new Headers(request.headers);
  for (const header of [LAB_RUN_HEADER, URL_HEADER, NAME_HEADER]) headers.delete(header);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  const inner = new Request(target, { method: request.method, headers, body });
  if (kind === "fetch") return await entry.env.FETCH(inner);
  if (kind === "texts") return await entry.env.GATEWAY_TEXTS.fetch(inner);
  if (kind === "inbox") {
    const name = request.headers.get(NAME_HEADER) ?? "";
    return await entry.namespace.get(entry.namespace.idFromName(name)).fetch(inner);
  }
  return Response.json({ error: "unknown_call" }, { status: 404 });
}

/** A stub for the box of `jobName`, made under `boxName`: every call carries the job's name, its test chat and run. */
export function boxStub(namespace, { sandbox, rowId, jobName, run }) {
  const stub = objectByName(namespace, boxName(sandbox, rowId, jobName));
  return {
    fetch: async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("x-inbox-name", jobName);
      headers.set(LAB_SANDBOX_HEADER, sandbox);
      headers.set(LAB_RUN_HEADER, run);
      const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      return await stub.fetch(new Request(request.url, { method: request.method, headers, body }));
    },
  };
}
