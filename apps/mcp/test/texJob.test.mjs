/**
 * The gateway's TexJob (`src/texJob.js`): a background job's object run here as the texting Worker's SenderInbox, born
 * on its first `/job-start`, answering nothing before that, and reached by a chat's job calls and by the Worker's
 * `/texts/job-call/` route. Since 2026-11-21 its own alarm runs each pass (`jobDrive.ts`), never the Worker's workflow.
 *
 * Runs under `--experimental-transform-types` with `test/tsRegister.mjs` (`test/run.mjs`): the Worker's TypeScript
 * (`jobRun.ts`, `chatObject.ts`) is what answers, on in-memory storage, with a fake workflow that records each start.
 *
 * Sabotage record (run 2026-11-14, each break reverted before the next):
 *   1. The unborn guard in `TexJob.fetch` removed (`if (false)`): "an unborn job refuses every path but its start" failed
 *      (the unborn object answered `/job-steer` 200 instead of 404 `{"here": false}`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { texJobClass, BORN_KEY, JOB_NAME_KEY } from "../../../packages/tex/gateway/texJob.js";
import { chatEnv } from "../../../packages/tex/gateway/texChat.js";
import { jobCallForTexts, TEXTS_JOB_CALL_PREFIX } from "../../../packages/tex/gateway/agent/textsArrive.js";
import { TexTexts, TexJob } from "../src/index.js";

const { SenderInbox } = await import("../../../packages/tex/worker/gatewayChat.js");

const JOB = "a1b2c3d4-e5f6";
const NAME = `job:${JOB}`;
const CHAT = "chat-one";

/** A Durable Object's storage, in memory: the calls the job's object and its workers make. */
class DoStorage {
  data = new Map();
  alarm = null;
  async get(key) {
    return structuredClone(this.data.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
    else this.data.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.data.delete(key);
  }
  async deleteAll() {
    this.data.clear();
  }
  async list(options = {}) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
    return new Map(keys.map((key) => [key, structuredClone(this.data.get(key))]));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(at) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

/** One object's state: its storage, its id, and the concurrency and background work the object runs. */
function fakeState(id) {
  return {
    storage: new DoStorage(),
    id: { toString: () => id },
    blockConcurrencyWhile: (run) => run(),
    waitUntil: () => {},
  };
}

/** The Worker's RPC, recording what the job's object asks of it: an inbox fetch, or a move (which a job never does). */
function fakeWorkerRpc() {
  const calls = { inboxFetch: [], chatMove: [] };
  const rpc = {
    async chatMove(call) {
      calls.chatMove.push(call);
      return { status: 404, body: null };
    },
    async inboxFetch(target, request) {
      calls.inboxFetch.push({ name: target.name, path: new URL(request.url).pathname });
      return Response.json({});
    },
    async inboxId() {
      return "";
    },
    async lineCall() {
      return { ok: true, value: null };
    },
    async groupLineCall() {
      return { ok: true, value: null };
    },
    async groupTurn() {
      return null;
    },
  };
  return { rpc, calls };
}

/** The workflow binding: records each instance started, and refuses one already there, as `Workflow.create` does. */
function fakeWorkflow() {
  const created = [];
  return {
    created,
    async create(options) {
      if (created.some((one) => one.id === options.id)) throw new Error("instance already exists");
      created.push(options);
      return { id: options.id };
    },
    async get(id) {
      return { id };
    },
  };
}

const gateway = () => ({ fetch: async () => Response.json({}, { status: 404 }) });
const texts = () => ({ fetch: async () => Response.json({}, { status: 404 }) });
const TexJobObject = texJobClass({ gateway, texts });

/** The `TEX_JOB` namespace: one real `TexJob` per name, each on its own fake state. Records each stub's name and placement. */
function jobNamespace(env) {
  const objects = new Map();
  const placements = [];
  return {
    objects,
    placements,
    idFromName: (name) => name,
    get(id, options) {
      placements.push({ id, locationHint: options?.locationHint });
      if (!objects.has(id)) objects.set(id, new TexJobObject(fakeState(id), env));
      const object = objects.get(id);
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
  };
}

/** The gateway's environment for a job: the bindings a `TexJob` and its chat read. */
function makeEnv({ jobs = true, job = true, workflow = fakeWorkflow(), rpc = fakeWorkerRpc() } = {}) {
  // The Worker's job workflow, as its RPC starts it (`chatCalls.ts` `jobRun`): the inner object's `JOB_RUN` is this.
  rpc.rpc.jobRun = async (call) => {
    if (call.op === "get") await workflow.get(call.id);
    else await workflow.create({ id: call.id, params: call.params });
    return { ok: true };
  };
  const env = { TEX_JOBS: jobs ? "gateway" : "worker", TEXTING: rpc.rpc, rpc, workflow };
  if (job) env.TEX_JOB = jobNamespace(env);
  return env;
}

/** A job's run, as the chat starts it (`jobs.ts` `JobRun`): enough for the job's object to keep it. */
const run = () => ({ id: JOB, title: "Sort the photos", brief: "Sort them by month", inbox: CHAT, origin: { kind: "text" }, attempt: 1, tries: 0, startedAt: 1 });

const request = (method, path, { name, body, headers = {} } = {}) =>
  new Request(`https://job${path}`, {
    method,
    headers: { ...(name === undefined ? {} : { "x-inbox-name": name }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** The object the namespace made for `name`, after the test has reached it. */
const objectOf = (env, name = NAME) => env.TEX_JOB.objects.get(name);

describe("an unborn job's object", () => {
  it("refuses every path but its start, and /job-here says it is not here", async () => {
    const env = makeEnv();
    const here = await env.TEX_JOB.get(NAME).fetch(request("GET", "/job-here"));
    assert.equal(here.status, 200);
    assert.deepEqual(await here.json(), { here: false });

    const steer = await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-steer", { name: NAME, body: { id: "s1", text: "faster" } }));
    assert.equal(steer.status, 404);
    assert.deepEqual(await steer.json(), { here: false });
    assert.equal(objectOf(env).inner, null, "no inner job object is made before the birth");
    assert.equal(await objectOf(env).state.storage.get(BORN_KEY), undefined);
  });

  it("answers its own alarm with nothing when it was never born", async () => {
    const original = SenderInbox.prototype.alarm;
    let alarms = 0;
    SenderInbox.prototype.alarm = async function () {
      alarms += 1;
      return original.call(this);
    };
    try {
      const env = makeEnv();
      await env.TEX_JOB.get(NAME).fetch(request("GET", "/job-here"));
      await objectOf(env).alarm();
      assert.equal(alarms, 0);
    } finally {
      SenderInbox.prototype.alarm = original;
    }
  });
});

describe("a job's start", () => {
  it("births the object under the job's name, and the job's own alarm is set to run it, with no workflow (2026-11-21)", async () => {
    const env = makeEnv();
    const started = await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { ok: true });

    const object = objectOf(env);
    assert.equal(typeof (await object.state.storage.get(BORN_KEY)), "number");
    assert.equal(await object.state.storage.get(JOB_NAME_KEY), NAME);
    // The inner object received `/job-start`, kept the run, and set its own alarm to drive it: no Worker workflow.
    assert.equal(env.workflow.created.length, 0);
    assert.deepEqual(await object.state.storage.get("jobdrive"), { pass: 0, tries: 0, overlaps: 0, dueAt: object.state.storage.alarm, resumes: 0 });
    assert.equal(typeof object.state.storage.alarm, "number");
  });

  it("refuses a start whose name is not a job's, and an unborn object never answers as born", async () => {
    const env = makeEnv();
    const bad = await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: "chat-one", body: run() }));
    assert.equal(bad.status, 400);
    assert.equal(env.workflow.created.length, 0);
    assert.equal(await objectOf(env).state.storage.get(BORN_KEY), undefined);
  });

  it("after birth, /job-here is true, /job-steer reaches the inner object, and the name header is not seen inside", async () => {
    const env = makeEnv();
    await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
    const here = await env.TEX_JOB.get(NAME).fetch(request("GET", "/job-here"));
    assert.deepEqual(await here.json(), { here: true });

    const steer = await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-steer", { name: NAME, body: { id: "s1", text: "faster" } }));
    assert.equal(steer.status, 200);
    assert.deepEqual(await steer.json(), { taken: true });
    // Had the header reached the inner object, its move gate would have tried to copy the job in from the Worker.
    assert.equal(env.rpc.calls.chatMove.length, 0);
  });

  it("a second start is passed on, and does not birth the object again", async () => {
    const env = makeEnv();
    await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
    const born = await objectOf(env).state.storage.get(BORN_KEY);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
    assert.equal(await objectOf(env).state.storage.get(BORN_KEY), born);
    assert.equal((await objectOf(env).state.storage.get("jobdrive")).dueAt, objectOf(env).state.storage.alarm, "the run is driven once");
    assert.equal(env.workflow.created.length, 0);
  });
});

describe("the job's alarm", () => {
  it("is forwarded to the inner object only once the object is born", async () => {
    const original = SenderInbox.prototype.alarm;
    let alarms = 0;
    SenderInbox.prototype.alarm = async function () {
      alarms += 1;
      return original.call(this);
    };
    try {
      const env = makeEnv();
      await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
      await objectOf(env).alarm();
      assert.equal(alarms, 1, "a born job's alarm reaches its inner object");
    } finally {
      SenderInbox.prototype.alarm = original;
    }
  });
});

describe("the job's alarm runs its pass", () => {
  it("through the job node, logged in the job's node log, and counts a failed pass as a try", async () => {
    const env = makeEnv();
    await env.TEX_JOB.get(NAME).fetch(request("POST", "/job-start", { name: NAME, body: run() }));
    const object = objectOf(env);
    let passes = 0;
    const real = object.passNext.bind(object);
    object.passNext = async (step) => {
      passes += 1;
      return await real(step);
    };
    // The inner object reads its step from the env it was built with: built now, after the spy.
    object.inner = null;
    object.state.storage.alarm = null;
    await object.alarm();
    assert.equal(passes, 1, "the alarm ran one pass, through TexJob's job node");
    const nodes = await (await env.TEX_JOB.get(NAME).fetch(request("GET", "/job-nodes"))).json();
    assert.ok(nodes.nodes.length >= 1, "the pass is in the job's node log");
    // This test's run is too thin for a real pass (no message on its origin): the node fails, and the alarm counts it
    // as the pass's first try, due again in 10 s.
    assert.deepEqual(nodes.nodes.map((node) => [node.name, node.ok, node.input.step, node.via]), [["job", false, "pass", "TexJob"]]);
    const drive = await object.state.storage.get("jobdrive");
    assert.deepEqual({ pass: drive.pass, tries: drive.tries }, { pass: 0, tries: 1 });
    assert.equal(object.state.storage.alarm, drive.dueAt);
    assert.equal(env.workflow.created.length, 0);
  });
});

describe("the route that hands a call to a job", () => {
  it("names the job by its header, refuses any other name, and 501s without the binding", async () => {
    const env = makeEnv();
    const notAJob = await jobCallForTexts(request("GET", "/texts/job-call/job-here", { name: CHAT }), env);
    assert.equal(notAJob.status, 400);
    const bare = await jobCallForTexts(request("GET", "/texts/job-call/job-here"), env);
    assert.equal(bare.status, 400);

    const selfHosted = makeEnv({ job: false });
    const absent = await jobCallForTexts(request("GET", "/texts/job-call/job-here", { name: NAME }), selfHosted);
    assert.equal(absent.status, 501);
    assert.deepEqual(await absent.json(), { error: "no_job_home" });
  });

  it("passes the path after the prefix, with its query, to the job's object, and the texting entrypoint routes the prefix", async () => {
    assert.equal(TEXTS_JOB_CALL_PREFIX, "/texts/job-call/");
    const env = makeEnv();
    const answer = await TexTexts.fetch(request("GET", "/texts/job-call/job-here", { name: NAME }), env, undefined);
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), { here: false });
    assert.deepEqual(env.TEX_JOB.placements.map((placement) => placement.id), [NAME]);
    assert.equal(typeof TexJob, "function");
  });
});

describe("a chat's job calls", () => {
  // Part C of the runtime simplification (2026-11-22): every object a chat reaches is the gateway's.
  it("reach the gateway's job object for a job's name, and the gateway's chat object for any other", async () => {
    const env = makeEnv({ rpc: fakeWorkerRpc() });
    const chats = [];
    env.TEX_CHAT = { idFromName: (name) => name, get: (name) => ({ fetch: async (request) => (chats.push([name, new URL(request.url).pathname]), Response.json({ ok: true })) }) };
    const inbox = await chatEnv(env, fakeState(CHAT), CHAT, "", { gateway: gateway, texts: texts });
    const jobId = inbox.SENDER_INBOX.idFromName(`enam:${NAME}`);
    const jobAnswer = await inbox.SENDER_INBOX.get(jobId).fetch("https://inbox/job-here");
    assert.deepEqual(await jobAnswer.json(), { here: false });
    assert.ok(env.TEX_JOB.objects.has(NAME), "the job's object is the gateway's");

    const chatId = inbox.SENDER_INBOX.idFromName("enam:chat-two");
    await inbox.SENDER_INBOX.get(chatId).fetch("https://inbox/accept", { method: "POST", body: "{}" });
    assert.deepEqual(chats, [["chat:chat-two", "/chat-call/accept"]]);
    assert.deepEqual(env.rpc.calls.inboxFetch ?? [], []);
  });
});
