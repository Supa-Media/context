/**
 * The gateway's TexChat runs the texting Worker's chat object as it is (step 3 of Tex's config graph,
 * docs/architecture/tex.md): a text handed over copies the Worker's chat in, is queued here, and is answered by the
 * gateway's own `/agent` in-process, the answer going out on the Worker's line over its RPC. The Worker's side of the
 * move is its real code (`inboxMove.ts` `serveMoveOut`), run on an in-memory object.
 *
 * Runs under `--experimental-transform-types` with `test/tsRegister.mjs` (`test/run.mjs`), which load the Worker's
 * TypeScript the way the deploy's bundler does.
 *
 * Sabotage record (run 2026-11-14, each break reverted before the next):
 *   1. `chatEnv`'s `TEX_LINE` removed: the chat object fell back to a local line with no keys, and "a handed-over
 *      text is answered on the Worker's line" failed (no `lineCall` reached the fake Worker).
 *   2. `copyIn` stopped checking the outcome (`moved.outcome !== "arrived"` dropped): "a copy the Worker refuses
 *      leaves the Worker answering" failed, the object answering a chat it never copied.
 *   3. `workerObjects` answered "" for the chat's own id: "the chat's own id is the Worker's" failed.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { texChatClass } from "../src/texChat.js";

const { serveMoveOut } = await import("../../agent/src/inboxMove.ts");

const PHONE = "+15555550100";
const LINE = "+15555550199";
const CHAT = `${LINE};${PHONE}`;
const SELF = "https://gateway.example";

/** A Durable Object's storage, in memory: the calls the chat object and the move make. */
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

/** The Worker's side: its chat object's storage, its move, its line and its other calls, each recorded. */
function fakeWorker({ refuseMove = false } = {}) {
  const old = new DoStorage();
  old.data.set("history:1", { text: "an older line" });
  const calls = { line: [], move: [], inboxFetch: [] };
  const rpc = {
    async chatMove({ inbox, op }) {
      calls.move.push({ inbox, op });
      if (refuseMove && op === "out") return { status: 409, body: { busy: true } };
      const path = op === "out" ? "/__move_out" : "/__move_back";
      const body = op === "out" ? JSON.stringify({ name: inbox, to: "gateway" }) : undefined;
      const answer = await serveMoveOut(new Request(`https://inbox${path}`, { method: "POST", body }), old, 0, Date.now());
      const text = await answer.text();
      return { status: answer.status, body: text === "" ? null : JSON.parse(text) };
    },
    async inboxId({ name }) {
      return `worker-id-of-${name}`;
    },
    async lineCall(call) {
      calls.line.push(call);
      if (call.method === "sendText") return { ok: true, value: "handle-1" };
      return { ok: true, value: null };
    },
    async groupLineCall(call) {
      calls.line.push(call);
      return { ok: true, value: null };
    },
    async inboxFetch(target, request) {
      calls.inboxFetch.push({ name: target.name, path: new URL(request.url).pathname });
      return Response.json({});
    },
    async groupTurn() {
      return null;
    },
  };
  return { rpc, old, calls };
}

/** The gateway's own `/agent`, answered in-process, and the control plane over the network. */
function fakeGateway() {
  const asked = [];
  const gateway = {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/agent") {
        const body = await request.json();
        asked.push(body.question);
        return Response.json({ answer: `answer to ${body.question}` });
      }
      return Response.json({}, { status: 404 });
    },
  };
  const texts = { fetch: async () => Response.json({ error: "unknown_route" }, { status: 404 }) };
  return { gateway, texts, asked };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function controlPlane() {
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push(url.pathname);
    if (url.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    return Response.json({});
  };
  return seen;
}

function chatObject(rpc) {
  const { gateway, texts, asked } = fakeGateway();
  const TexChat = texChatClass({ gateway: () => gateway, texts: () => texts });
  const storage = new DoStorage();
  const work = [];
  const state = { storage, waitUntil: (promise) => work.push(promise), blockConcurrencyWhile: (run) => run() };
  const env = { TEXTING: rpc, PUBLIC_ORIGIN: SELF, CONTROL_PLANE_URL: "https://cp.example", AGENT_WORKER_SECRET: "s" };
  return { chat: new TexChat(state, env), storage, asked, work };
}

const message = (id, text) => ({ kind: "message", eventId: `sendblue:${id}`, chatId: CHAT, from: PHONE, messageId: id, text });

async function arrive(chat, body) {
  const answer = await chat.fetch(new Request("https://chat/arrive", { method: "POST", body: JSON.stringify(body) }));
  return { status: answer.status, body: await answer.json() };
}

describe("TexChat runs the Worker's chat object", () => {
  it("a handed-over text is copied in, queued, and answered on the Worker's line", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage, asked, work } = chatObject(worker.rpc);

    const first = await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi"), origin: "https://agent.example" });
    assert.deepEqual(first, { status: 200, body: { outcome: "queued" } });
    // The Worker's chat was copied in and marked moved to the gateway; this one holds its lines.
    assert.deepEqual(worker.calls.move, [{ inbox: PHONE, op: "out" }]);
    assert.equal((await worker.old.get("__inbox_place")).movedTo, "gateway");
    assert.deepEqual(await storage.get("history:1"), { text: "an older line" });
    assert.notEqual(storage.alarm, null);

    await chat.alarm();
    await Promise.allSettled(work);
    assert.deepEqual(asked, ["hi"]);
    const sent = worker.calls.line.filter((call) => call.method === "sendText");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].inbox, PHONE);
    assert.equal(sent[0].chatId, CHAT);
    assert.equal(sent[0].args[0], "answer to hi");
  });

  it("the same text again is a duplicate, and the copy is made once", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    const again = await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.deepEqual(again, { status: 200, body: { outcome: "duplicate" } });
    assert.equal(worker.calls.move.length, 1);
  });

  it("a call the Worker's moved object passes on is answered here", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    const passed = await chat.fetch(
      new Request("https://chat/chat-call/accept", { method: "POST", headers: { "x-inbox-name": PHONE }, body: JSON.stringify(message("m2", "again")) }),
    );
    assert.deepEqual(await passed.json(), { outcome: "queued" });
    // A pass-on with no name, or a bad one, is refused before the chat object.
    const unnamed = await chat.fetch(new Request("https://chat/chat-call/accept", { method: "POST", body: "{}" }));
    assert.equal(unnamed.status, 400);
  });

  it("a copy the Worker refuses leaves the Worker answering", async () => {
    controlPlane();
    const worker = fakeWorker({ refuseMove: true });
    const { chat, storage } = chatObject(worker.rpc);
    const refused = await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.deepEqual(refused, { status: 503, body: { outcome: "not_here" } });
    assert.equal(await storage.get("history:1"), undefined);
    assert.equal((await worker.old.get("__inbox_place")), undefined);
  });

  it("the chat's own id is the Worker's, so its counts and addresses still name it", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.equal(chat.inner.state.id.toString(), `worker-id-of-${PHONE}`);
    assert.equal(chat.inner.env.SENDER_INBOX.idFromName(`enam:${PHONE}`).toString(), `worker-id-of-${PHONE}`);
    assert.equal(chat.inner.env.SENDER_INBOX.idFromName("enam:+15555550111").toString(), "");
  });

  it("a bad arrival is refused before anything is copied", async () => {
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    assert.equal((await arrive(chat, { kind: "one", inbox: "bad name!", message: {} })).status, 400);
    assert.equal((await arrive(chat, { kind: "shout", inbox: PHONE, message: {} })).status, 400);
    assert.equal(worker.calls.move.length, 0);
  });
});
