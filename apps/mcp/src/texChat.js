/**
 * One text chat's object in the gateway: the texting Worker's chat object (`apps/agent/src/chatObject.ts`, a phone's
 * inbox or a group's, with its queue, its alarm and every route the chat's state answers), run here as it is (step 3
 * of Tex's config graph: a text arriving, Triage, Decide, React and the per-chat queues move into the gateway; Dev2
 * approved https://claude.ai/artifact/6iF9DnjvN4aGVREhPc6yua, 2026-11-14). Only what it reaches outside itself
 * changes, and all of it is the `env` this file hands it:
 *
 *   - the gateway's own routes (`/agent`, `/agent/steer`, ...) and `TexTexts` are called in-process, with no HTTP hop;
 *   - the line (sending, typing, read, tapback, members) is the texting Worker's, over its `TEXTING` RPC entrypoint
 *     (`lineCall`, `groupLineCall`), because the line's keys stay in the Worker;
 *   - the Worker's other objects this one reaches (a chat's directory entry, and a job's object while jobs run in the
 *     Worker) are reached the same way (`inboxFetch`); a job's calls go through `apps/agent/src/jobPlace.ts`, which starts
 *     a new job in the gateway's `TEX_JOB` while `TEX_JOBS` is "gateway" and sends every later call where it was born;
 *   - a group turn's retries stay the Worker's Workflow, started over the same RPC (`groupTurn`);
 *   - the control plane is reached as the Worker reached it, with `AGENT_WORKER_SECRET`.
 *
 * A chat comes here once, on its first call, by copying the Worker's object in (`apps/agent/src/inboxMove.ts`, the
 * same copy and digest the Worker's own moves use): the Worker's object marks itself moved and passes every later call
 * on to this one (`/texts/chat-call`). A copy that fails leaves the Worker's object answering, and the call is refused
 * here so the Worker answers it.
 *
 * Which chats come here is the Worker's `INTAKE` var: only a text handed over by the Worker starts the copy.
 */

import { ARRIVAL_KINDS, INBOX_NAME } from "./texChat/arrival.js";
import { objectByName } from "./objectPlace.js";
import { JOB_NAME } from "./texJobName.js";

/** Where the Worker's chat object answers each kind of arrival (`apps/agent/src/index.ts`). */
const ARRIVAL_PATHS = Object.freeze({ one: "/accept", react: "/react", group: "/group-accept", members: "/group-members-changed" });
/** The header the Worker's object names itself with (`inboxMove.ts` `INBOX_NAME_HEADER`). */
export const INBOX_NAME_HEADER = "x-inbox-name";
/** Set on every answer this object gives a passed-on call: the chat answered in the gateway. */
export const CHAT_HOME_HEADER = "x-tex-chat-home";
/** Where this chat's copy stands (`inboxMove.ts` `PLACE_KEY`): set once the copy arrived. */
const PLACE_KEY = "__inbox_place";
/** The Worker's object id this chat had there, for the addresses its pictures and pages are served at. */
const SENDER_ID_KEY = "__sender_id";

/**
 * The `TexChat` class, given the gateway's own handlers (`index.js`): its default `fetch` and `TexTexts`, read when a
 * call needs them, so this file imports nothing of `index.js`.
 */
export function texChatClass({ gateway, texts }) {
  return class TexChat {
    constructor(state, env) {
      this.state = state;
      this.env = env;
      this.inner = null;
      this.name = null;
    }

    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/arrive") return await this.arrive(request);
      if (url.pathname.startsWith("/chat-call/")) return await this.chatCall(request, url);
      return Response.json({ error: "unknown_route" }, { status: 404 });
    }

    async alarm() {
      const chat = await this.chat();
      if (chat !== null) await chat.alarm();
    }

    /** A text handed over by the Worker (`agent/textsArrive.js`): copied in first, then answered as the Worker's object would. */
    async arrive(request) {
      const body = await request.json().catch(() => null);
      if (body === null || !ARRIVAL_KINDS.has(body.kind) || typeof body.inbox !== "string" || !INBOX_NAME.test(body.inbox)) {
        return Response.json({ error: "bad_body" }, { status: 400 });
      }
      const chat = await this.chat(body.inbox);
      if (chat === null) return Response.json({ outcome: "not_here" }, { status: 503 });
      const path = ARRIVAL_PATHS[body.kind];
      const origin = typeof body.origin === "string" ? `?origin=${encodeURIComponent(body.origin)}` : "";
      const init = body.kind === "members" ? { method: "POST" } : { method: "POST", body: JSON.stringify(body.message) };
      const answer = await chat.fetch(new Request(`https://inbox${path}${body.kind === "one" || body.kind === "group" ? origin : ""}`, init));
      const outcome = answer.ok ? await answer.json().catch(() => ({})) : {};
      return Response.json({ outcome: typeof outcome.outcome === "string" ? outcome.outcome : answer.ok ? "queued" : "failed" }, { status: answer.ok ? 200 : 503 });
    }

    /** A call the Worker's moved object passed on (`inboxMove.ts` `forward`): answered by the copy here. */
    async chatCall(request, url) {
      const name = request.headers.get(INBOX_NAME_HEADER);
      if (name === null || !INBOX_NAME.test(name)) return new Response(null, { status: 400 });
      const chat = await this.chat(name);
      if (chat === null) return new Response(null, { status: 503 });
      const path = url.pathname.slice("/chat-call".length);
      const headers = new Headers(request.headers);
      headers.delete(INBOX_NAME_HEADER);
      const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      const answer = await chat.fetch(new Request(`https://inbox${path}${url.search}`, { method: request.method, headers, body }));
      // Where the chat answered, for a caller that has to tell (the staging intake check, `scripts/staging-tex-live.mjs`).
      const marked = new Headers(answer.headers);
      marked.set(CHAT_HOME_HEADER, "gateway");
      return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: marked });
    }

    /** The Worker's chat object, running on this chat's copy; null while the copy cannot be made. */
    async chat(name) {
      if (this.inner !== null) return this.inner;
      const { storage } = this.state;
      const place = await storage.get(PLACE_KEY);
      if (place?.arrivedAt === undefined) {
        if (typeof name !== "string" || this.env.TEXTING === undefined) return null;
        const moved = await this.state.blockConcurrencyWhile(() => copyIn(this.env.TEXTING, storage, name));
        console.log(JSON.stringify({ event: "tex_chat_move", ...moved }));
        if (moved.outcome !== "arrived") return null;
      }
      this.name = name ?? (await storage.get("__inbox_name")) ?? null;
      if (this.name === null) return null;
      const { SenderInbox } = await import("../../agent/src/gatewayChat.js");
      const senderId = (await storage.get(SENDER_ID_KEY)) ?? "";
      this.inner = new SenderInbox(chatState(this.state, senderId), await chatEnv(this.env, this.state, this.name, senderId, { gateway, texts }));
      return this.inner;
    }
  };
}

/**
 * Copy the Worker's chat object in (`inboxMove.ts` `arrive`, run against the Worker over RPC), and keep its name and
 * id. Never throws; anything but `arrived` leaves this object empty and the Worker's answering.
 */
async function copyIn(rpc, storage, name) {
  const { arrive } = await import("../../agent/src/gatewayChat.js");
  const stubs = () => ({
    fetch: async (request) => {
      const op = new URL(request.url).pathname === "/__move_back" ? "back" : "out";
      const answer = await rpc.chatMove({ inbox: name, op });
      return Response.json(answer.body ?? null, { status: answer.status });
    },
  });
  const moved = await arrive(stubs, storage, name, () => Date.now());
  if (moved.outcome === "arrived") {
    await storage.put("__inbox_name", name);
    const id = await rpc.inboxId({ name }).catch(() => "");
    await storage.put(SENDER_ID_KEY, typeof id === "string" ? id : "");
  }
  return moved;
}

/**
 * The state the chat object runs on: this object's storage and work, with the id it had in the Worker, so the
 * addresses it mints for pictures and pages still reach it (the Worker's object passes them on).
 */
export function chatState(state, senderId) {
  return {
    storage: state.storage,
    id: { toString: () => senderId },
    waitUntil: (work) => state.waitUntil(work),
    blockConcurrencyWhile: (run) => state.blockConcurrencyWhile(run),
  };
}

/**
 * The Worker's `Env`, as the chat object reads it, made of the gateway's bindings. `jobsHere`: this object's job calls
 * (`job:<id>`) reach the gateway's `TEX_JOB` objects rather than the Worker's.
 */
export async function chatEnv(env, state, name, senderId, { gateway, texts, jobsHere = false }) {
  const { remoteLine, remoteGroupLine } = await import("../../agent/src/gatewayChat.js");
  const ctx = { waitUntil: (work) => state.waitUntil(work), passThroughOnException() {} };
  const self = typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN.replace(/\/+$/, "") : "";
  const rpc = env.TEXTING;
  return {
    // The gateway's own routes run in-process; everything else (the control plane, a picture's address) goes out.
    FETCH: (input, init) => {
      const request = new Request(input, init);
      if (self !== "" && request.url.startsWith(`${self}/`)) return gateway().fetch(request, env, ctx);
      return fetch(request);
    },
    GATEWAY_ORIGIN: self,
    GATEWAY_TEXTS: { fetch: (input, init) => texts().fetch(new Request(input, init), env, ctx) },
    CONTROL_PLANE_ORIGIN: typeof env.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL : "",
    AGENT_WORKER_SECRET: typeof env.AGENT_WORKER_SECRET === "string" ? env.AGENT_WORKER_SECRET : "",
    // The Worker's other objects (a job's, a chat's directory entry), reached through the Worker.
    // Where a new background job starts (`apps/agent/src/jobPlace.ts`): its calls then follow where it was born.
    JOBS: env.TEX_JOBS === "gateway" && env.TEX_JOB !== undefined ? "gateway" : "worker",
    SENDER_INBOX: senderObjects(env, rpc, name, senderId, jobsHere),
    TEX_LINE: rpc === undefined ? undefined : { line: (chatId) => remoteLine(rpc, name, chatId), groupLine: (groupId) => remoteGroupLine(rpc, name, groupId) },
    // A group turn's retries stay the Worker's Workflow: it reaches this chat through the Worker's object by its old
    // id, which passes the call on here (`groupTurnWorkflow.ts`).
    ...(rpc === undefined ? {} : { GROUP_TURN: { create: (options) => rpc.groupTurn({ op: "create", ...options }), get: (id) => rpc.groupTurn({ op: "get", id }) } }),
    IMAGES: env.IMAGES,
    // The Worker's datasets, bound here under the same names, so a text is timed and counted wherever its chat runs.
    TEX_TEXTS: env.TEX_TEXTS,
    TEX_COUNTS: env.TEX_COUNTS,
    // The texts simulator's chats answer here only where the gateway's own var says so (staging).
    ...(env.SIMULATOR === "on" ? { SIMULATOR: "on" } : {}),
    LINQ_API_KEY: "",
    INTAKE: "gateway",
  };
}

/**
 * A stand-in for the Worker's `SENDER_INBOX` namespace: each object reached by name through the Worker's RPC. Only
 * this chat's own id is known here (the one it had in the Worker, for counting: `objectPlace.ts` `inboxIdOf`).
 */
function workerObjects(rpc, chatName, senderId) {
  return {
    idFromName: (name) => workerId(name, chatName, senderId),
    idFromString: () => {
      throw new TypeError("a Worker object is reached by name here");
    },
    get: (id) => workerStub(rpc, id),
  };
}

/** The id a Worker's object has under `name`: its name, and for this chat's own name, the id it had in the Worker. */
function workerId(name, chatName, senderId) {
  return { name, toString: () => (name === `enam:${chatName}` ? senderId : "") };
}

/** A stub for the Worker's object `id`, reached over the Worker's RPC. */
function workerStub(rpc, id) {
  return {
    fetch: (input, init) => {
      if (rpc === undefined) return Promise.resolve(new Response(null, { status: 503 }));
      return rpc.inboxFetch({ name: id.name }, new Request(input, init));
    },
  };
}

/**
 * The `SENDER_INBOX` the chat object reads: a job's name (`enam:job:<id>`, as `inboxByName` makes it) goes to the
 * gateway's `TEX_JOB` object of that name, and every other name to the Worker's objects, as before. Only the job
 * objects are made here by namespace, through `objectByName`; the Worker's are named and reached over RPC.
 */
function senderObjects(env, rpc, chatName, senderId, jobsHere) {
  if (!jobsHere) return workerObjects(rpc, chatName, senderId);
  return {
    idFromName: (name) => (jobNameOf(name) === null ? workerId(name, chatName, senderId) : { name, toString: () => "" }),
    idFromString: () => {
      throw new TypeError("a job is reached by name here");
    },
    get: (id) => {
      const job = jobNameOf(id.name);
      if (job === null) return workerStub(rpc, id);
      const stub = objectByName(env.TEX_JOB, job);
      return { fetch: (input, init) => stub.fetch(new Request(input, init)) };
    },
  };
}

/** The job's object name (`job:<id>`) inside a name a `SENDER_INBOX` lookup was made with, or null for any other name. */
function jobNameOf(name) {
  const bare = typeof name === "string" && name.startsWith("enam:") ? name.slice("enam:".length) : name;
  return typeof bare === "string" && JOB_NAME.test(bare) ? bare : null;
}
