/**
 * The gateway's TexChat runs the texting Worker's chat object as it is (step 3 of Tex's config graph,
 * docs/architecture/tex.md): a text handed over is queued here, in a chat born here on its first call, and answered by
 * the gateway's own `/agent` over a real hop (a fresh gateway isolate, here the same fake gateway reached through
 * `fetch`), the answer going out on the Worker's line over its RPC. Nothing is asked of the Worker's chat objects: part C
 * of the runtime simplification (Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX) ended the copy in.
 *
 * Runs under `--experimental-transform-types` with `test/tsRegister.mjs` (`test/run.mjs`), which load the Worker's
 * TypeScript the way the deploy's bundler does.
 *
 * Sabotage record (each break reverted before the next):
 *   1. (2026-11-14) `chatEnv`'s `TEX_LINE` removed: the chat object fell back to a local line with no keys, and "a
 *      handed-over text is answered on the Worker's line" failed (no `lineCall` reached the fake Worker).
 *   2. (2026-11-14) `chatEnv` passed `SIMULATOR: "on"` whatever the gateway's var: "a simulated chat ... only where the
 *      simulator is on" failed (the gateway without it answered the simulator).
 *   3. (2026-11-25) `placeChat` kept "" as the sender id: "the chat's own id is this object's" failed.
 *   4. (2026-11-25) `chat()` placed a chat for a name `INBOX_NAME` refuses: "a bad arrival is refused before anything is
 *      placed" failed.
 *   5. (2026-11-25) `placeChat` wrote the place before the name: "a failed place is tried again" failed, the chat open
 *      with no name kept.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { texChatClass } from "../../../packages/tex/gateway/texChat.js";

const PHONE = "+15555550100";
const LINE = "+15555550199";
const CHAT = `${LINE};${PHONE}`;
const SELF = "https://gateway.example";
/** This chat's own object id in the gateway. */
const OWN_ID = "c".repeat(64);

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

/** The Worker's side: its line and its other calls, each recorded. It has no chat objects to ask. */
function fakeWorker() {
  const calls = { line: [], inboxFetch: [] };
  const rpc = {
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
  };
  return { rpc, calls };
}

/** The gateway's own `/agent`, reached over the hop (`texChat.js` `hopToGateway`), and the control plane over the network. */
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
/** The gateway a turn's hop reaches: the chat object's own fake, set by `chatObject`. */
let hopTarget = null;
/** Each turn that went over the hop rather than in-process. */
let hopped = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  hopTarget = null;
  hopped = [];
});

function controlPlane() {
  const seen = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (hopTarget !== null && url.origin === new URL(SELF).origin) return (hopped.push(url.pathname), hopTarget.fetch(request));
    seen.push(url.pathname);
    if (url.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
    return Response.json({});
  };
  return seen;
}

function chatObject(rpc, extra = {}) {
  const { gateway, texts, asked } = fakeGateway();
  hopTarget = gateway;
  const TexChat = texChatClass({ gateway: () => gateway, texts: () => texts });
  const storage = new DoStorage();
  const work = [];
  const state = { id: { toString: () => OWN_ID }, storage, waitUntil: (promise) => work.push(promise), blockConcurrencyWhile: (run) => run() };
  const env = { TEXTING: rpc, PUBLIC_ORIGIN: SELF, CONTROL_PLANE_URL: "https://cp.example", AGENT_WORKER_SECRET: "s", ...extra };
  return { chat: new TexChat(state, env), storage, asked, work };
}

const message = (id, text) => ({ kind: "message", eventId: `sendblue:${id}`, chatId: CHAT, from: PHONE, messageId: id, text });

async function arrive(chat, body) {
  const answer = await chat.fetch(new Request("https://chat/arrive", { method: "POST", body: JSON.stringify(body) }));
  return { status: answer.status, body: await answer.json() };
}

describe("TexChat runs the Worker's chat object", () => {
  it("a call to this chat's own Worker object is served here, and another chat is its gateway object, never the Worker's", async () => {
    const { chatEnv } = await import("../../../packages/tex/gateway/texChat.js");
    const calls = [];
    const chats = [];
    const rpc = { async inboxFetch(target) { calls.push(target.name); return Response.json({ rpc: true }); } };
    const own = { name: `enam:${PHONE}`, fetch: async (request) => Response.json({ local: new URL(request.url).pathname }) };
    const TEX_CHAT = { idFromName: (name) => name, get: (name) => ({ fetch: async (request) => (chats.push([name, new URL(request.url).pathname, request.headers.get("x-inbox-name")]), Response.json({ ok: true })) }) };
    const env = { PUBLIC_ORIGIN: SELF, CONTROL_PLANE_URL: "https://cp.example", AGENT_WORKER_SECRET: "s", TEXTING: rpc, TEX_CHAT };
    const inbox = await chatEnv(env, { waitUntil() {} }, PHONE, "worker-id", {
      gateway: () => ({ fetch: async () => new Response(null) }),
      texts: () => ({ fetch: async () => new Response(null) }),
      own,
    });
    const local = await inbox.SENDER_INBOX.get(inbox.SENDER_INBOX.idFromName(`enam:${PHONE}`)).fetch("https://inbox/accept", { method: "POST", body: "{}" });
    assert.deepEqual(await local.json(), { local: "/accept" });
    await inbox.SENDER_INBOX.get(inbox.SENDER_INBOX.idFromName("enam:chat-two")).fetch("https://inbox/accept", { method: "POST", body: "{}" });
    assert.deepEqual(chats, [["chat:chat-two", "/chat-call/accept", "chat-two"]]);
    assert.deepEqual(calls, []);
  });

  it("a handed-over text is placed here, queued, and answered on the Worker's line, with nothing asked of its objects", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage, asked, work } = chatObject(worker.rpc);

    const first = await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi"), origin: "https://agent.example" });
    assert.deepEqual(first, { status: 200, body: { outcome: "queued" } });
    // Born here: its name and own id kept, nothing copied, and no Worker object asked.
    const place = await storage.get("__inbox_place");
    assert.equal(typeof place.arrivedAt, "number");
    assert.equal(place.born, true);
    assert.equal(await storage.get("__inbox_name"), PHONE);
    assert.deepEqual(worker.calls.inboxFetch, []);
    assert.notEqual(storage.alarm, null);

    await chat.alarm();
    await Promise.allSettled(work);
    assert.deepEqual(asked, ["hi"]);
    // The phone chat's turn left the object over the hop, not in its own isolate (one path, Dev2 2026-11-21).
    assert.deepEqual(hopped, ["/agent"]);
    const sent = worker.calls.line.filter((call) => call.method === "sendText");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].inbox, PHONE);
    assert.equal(sent[0].chatId, CHAT);
    assert.equal(sent[0].args[0], "answer to hi");
    assert.deepEqual(worker.calls.inboxFetch, []);
  });

  it("a text's provider times become the chat's text step, and never ride on with the text", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    const provider = { name: "sendblue", providerAt: Date.now() - 120_000, receivedAt: Date.now(), lagMs: 120_000 };
    await arrive(chat, { kind: "one", inbox: PHONE, message: { ...message("m1", "hi"), provider } });
    const { unwritten } = await import("../../../packages/tex/worker/events.ts");
    const step = (await unwritten(storage)).find((event) => event.kind === "step" && event.step.name === "text");
    assert.equal(step?.step.ms, 120_000);
    assert.deepEqual(step?.step.input.provider, provider);
    assert.equal(step?.step.output.outcome, "queued");
    const pending = [...(await storage.list({ prefix: "pending:" })).values()];
    assert.equal(pending.length, 1);
    assert.equal(pending[0].message.provider, undefined);
  });

  it("the same text again is a duplicate, and the chat is placed once", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    const placed = await storage.get("__inbox_place");
    const again = await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.deepEqual(again, { status: 200, body: { outcome: "duplicate" } });
    assert.deepEqual(await storage.get("__inbox_place"), placed);
  });

  it("a call by the chat's name (`/chat-call`) is answered here", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    const passed = await chat.fetch(
      new Request("https://chat/chat-call/accept", { method: "POST", headers: { "x-inbox-name": PHONE }, body: JSON.stringify(message("m2", "again")) }),
    );
    assert.deepEqual(await passed.json(), { outcome: "queued" });
    assert.equal(passed.headers.get("x-tex-chat-home"), "gateway", "a call by name says it was answered here");
    // A pass-on with no name, or a bad one, is refused before the chat object.
    const unnamed = await chat.fetch(new Request("https://chat/chat-call/accept", { method: "POST", body: "{}" }));
    assert.equal(unnamed.status, 400);
  });

  it("a failed place is tried again on the next call, and never leaves a chat open with no name", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    const realPut = storage.put.bind(storage);
    let failed = false;
    storage.put = async (key, value) => {
      if (key === "__sender_id" && !failed) {
        failed = true;
        throw Object.assign(new Error("storage down"), { name: "PutFailed" });
      }
      return realPut(key, value);
    };
    await assert.rejects(arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") }), { name: "PutFailed" });
    assert.equal(await storage.get("__inbox_place"), undefined);
    assert.deepEqual(await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") }), { status: 200, body: { outcome: "queued" } });
    assert.equal(await storage.get("__inbox_name"), PHONE);
  });

  it("home says none before the chat's first call, and gateway after; move-in is gone", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat } = chatObject(worker.rpc);
    assert.deepEqual(await (await chat.fetch(new Request("https://chat/home"))).json(), { home: "none" });
    assert.deepEqual(await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") }), { status: 200, body: { outcome: "queued" } });
    const after = await (await chat.fetch(new Request("https://chat/home"))).json();
    assert.equal(after.home, "gateway");
    assert.equal(after.keys, 0);
    const gone = await chat.fetch(new Request("https://chat/move-in", { method: "POST", body: JSON.stringify({ inbox: PHONE }) }));
    assert.equal(gone.status, 404);
    assert.deepEqual(worker.calls.inboxFetch, []);
  });

  it("no text is answered twice: a hand-over whose answer was lost, sent again by name and by the webhook's retry, is a duplicate", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage, asked, work } = chatObject(worker.rpc);
    // The hand-over queued the text here, but the Worker never read the answer (a dropped connection).
    assert.deepEqual(await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") }), { status: 200, body: { outcome: "queued" } });
    const again = await chat.fetch(new Request("https://chat/chat-call/accept", { method: "POST", headers: { "x-inbox-name": PHONE }, body: JSON.stringify(message("m1", "hi")) }));
    assert.deepEqual(await again.json(), { outcome: "duplicate" });
    // And the webhook's own retry of it, handed over again.
    assert.deepEqual(await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") }), { status: 200, body: { outcome: "duplicate" } });
    assert.equal([...(await storage.list({ prefix: "pending:" })).values()].length, 1);
    await chat.alarm();
    await Promise.allSettled(work);
    assert.deepEqual(asked, ["hi"]);
    assert.equal(worker.calls.line.filter((call) => call.method === "sendText").length, 1);
  });

  it("the chat's own id is this object's, so its counts and addresses name it", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.equal(await storage.get("__sender_id"), OWN_ID);
    assert.equal(chat.inner.state.id.toString(), OWN_ID);
    assert.equal(chat.inner.env.SENDER_INBOX.idFromName(`enam:${PHONE}`).toString(), OWN_ID);
    assert.equal(chat.inner.env.SENDER_INBOX.idFromName("enam:+15555550111").toString(), "");
  });

  it("a chat already placed keeps the name and id it has", async () => {
    controlPlane();
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    const old = "d".repeat(64);
    await storage.put("__inbox_place", { arrivedAt: 1, keys: 3 });
    await storage.put("__inbox_name", PHONE);
    await storage.put("__sender_id", old);
    await arrive(chat, { kind: "one", inbox: PHONE, message: message("m1", "hi") });
    assert.equal(await storage.get("__sender_id"), old);
    assert.deepEqual(await storage.get("__inbox_place"), { arrivedAt: 1, keys: 3 });
  });

  it("a simulated chat is born and answered here, its reply in its log and never on the line, only where the simulator is on", async () => {
    controlPlane();
    const SIM = "+12125550100";
    const worker = fakeWorker();
    const { chat, asked, work } = chatObject(worker.rpc, { SIMULATOR: "on" });
    const sim = (action, body) =>
      chat.fetch(new Request(`https://chat/chat-call/sim/${action}`, { method: "POST", headers: { "x-inbox-name": SIM }, body: JSON.stringify(body) }));
    const keyHash = "ab".repeat(32);
    assert.deepEqual(await (await sim("send", { keyHash, phone: SIM, text: "hello sim" })).json(), { outcome: "queued" });
    await chat.alarm();
    await Promise.allSettled(work);
    assert.deepEqual(asked, ["hello sim"]);
    const log = await (await sim("thread", { keyHash, phone: SIM, text: "" })).json();
    assert.deepEqual(log.messages.map((m) => [m.dir, m.text]), [["out", "hello sim"], ["in", "answer to hello sim"]]);
    assert.equal(worker.calls.line.filter((call) => call.method === "sendText").length, 0);

    const off = chatObject(fakeWorker().rpc).chat;
    const refused = await off.fetch(new Request("https://chat/chat-call/sim/send", { method: "POST", headers: { "x-inbox-name": SIM }, body: JSON.stringify({ keyHash, phone: SIM, text: "x" }) }));
    assert.equal(refused.status, 404);
  });

  it("a bad arrival is refused before anything is placed", async () => {
    const worker = fakeWorker();
    const { chat, storage } = chatObject(worker.rpc);
    assert.equal((await arrive(chat, { kind: "one", inbox: "bad name!", message: {} })).status, 400);
    assert.equal((await arrive(chat, { kind: "shout", inbox: PHONE, message: {} })).status, 400);
    // And opened straight by a name no inbox has: nothing placed, no chat.
    assert.equal(await chat.chat("bad name!"), null);
    assert.equal(await storage.get("__inbox_place"), undefined);
  });
});
