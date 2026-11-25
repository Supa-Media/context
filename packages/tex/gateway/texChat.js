/**
 * One text chat's object in the gateway: the texting Worker's chat object (`packages/tex/worker/chatObject.ts`, a phone's
 * inbox or a group's, with its queue, its alarm and every route the chat's state answers), run here as it is (step 3
 * of Tex's config graph: a text arriving, Triage, Decide, React and the per-chat queues move into the gateway; Dev2
 * approved https://claude.ai/artifact/6iF9DnjvN4aGVREhPc6yua, 2026-11-14). Only what it reaches outside itself
 * changes, and all of it is the `env` this file hands it:
 *
 *   - the gateway's own routes (`/agent`, `/agent/steer`, ...) and `TexTexts` are called in-process, with no HTTP hop;
 *   - the line (sending, typing, read, tapback, members) is the texting Worker's, over its `TEXTING` RPC entrypoint
 *     (`lineCall`, `groupLineCall`), because the line's keys stay in the Worker;
 *   - every other object it reaches (another chat, a group's directory entry, a job) is the gateway's, by name
 *     (`senderObjects`);
 *   - a group turn that failed is tried again by this object's own alarm (`packages/tex/worker/groupRetry.ts`), as a job's
 *     passes are run by its own (`texJob.js`): no Workflow, and no call back to the Worker for it (2026-11-21);
 *   - the control plane is reached as the Worker reached it, with `AGENT_WORKER_SECRET`.
 *
 * Every chat lives here and is born here, on its first call (`placeChat`). Until part C of the runtime simplification
 * (Dev2 approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX) a chat still in the Worker was copied in on its
 * first call; every chat had moved by 2026-11-22, and the boxes no name led to were archived (`texChat/workerArchive.js`).
 */

import { ARRIVAL_KINDS, INBOX_NAME } from "./texChat/arrival.js";
import { objectByName } from "../../../apps/mcp/src/objectPlace.js";
import { JOB_NAME } from "./texJobName.js";
import { NAME_KEY, PLACE_KEY, SENDER_ID_KEY, isAppChatName, placeAppChat, serveAppArrive, serveAppCard, serveAppFileById, serveAppOutbox, serveAppPictureById, serveAppTurnCall } from "./texChat/appChat.js";
import { NOTE_RUNS_PATH, serveNoteRuns } from "./texChat/noteRuns.js";
import { serveAppSeenGet, serveAppSeenPost } from "./texChat/appSeen.js";
import { isDirectoryName, serveDirectory } from "./texChat/directory.js";
import { BY_ID_PATH, indexChat, isByIdName, serveById } from "./texChat/byId.js";
import { ARCHIVE_PATH, isArchiveName, serveArchive } from "./texChat/workerArchive.js";

/** Where the Worker's chat object answers each kind of arrival (`packages/tex/worker/index.ts`). */
const ARRIVAL_PATHS = Object.freeze({ one: "/accept", react: "/react", group: "/group-accept", members: "/group-members-changed", edit: "/edit", joined: "/group-joined" });
/** The header a chat's name travels in to its object (`packages/tex/worker/gatewayChats.ts` `INBOX_NAME_HEADER`). */
export const INBOX_NAME_HEADER = "x-inbox-name";
/** Set on every answer this object gives a passed-on call: the chat answered in the gateway. */
export const CHAT_HOME_HEADER = "x-tex-chat-home";

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
      // A note's run log (`texChat/noteRuns.js`): its own object, named `noteruns:`, answered before any chat routing.
      if (url.pathname === NOTE_RUNS_PATH) return await serveNoteRuns(request, this.state.storage);
      // A chat's index by the id its addresses carry (`texChat/byId.js`): its own object, named `byid:`.
      if (url.pathname === BY_ID_PATH && isByIdName(request.headers.get(INBOX_NAME_HEADER))) return await serveById(request, this.state.storage);
      // A sealed copy of a Worker chat box no name leads to (`texChat/workerArchive.js`): its own object, named `archive:`.
      if (isArchiveName(request.headers.get(INBOX_NAME_HEADER))) return url.pathname === ARCHIVE_PATH ? await serveArchive(request, this.state.storage) : new Response(null, { status: 404 });
      if (request.method === "POST" && url.pathname === "/arrive") return await this.arrive(request);
      // The app chat's calls (`texChat/appChat.js`): the gateway's `/tex/app-chat` route, and only for an app chat.
      if (request.method === "POST" && url.pathname === "/app/arrive") {
        return await serveAppArrive(request, { state: this.state, open: (name) => this.chat(name) });
      }
      if (request.method === "POST" && url.pathname === "/app/card") return await serveAppCard(request, { state: this.state });
      if (request.method === "GET" && url.pathname === "/app/outbox") return await serveAppOutbox(this.state.storage, { alarms: this.state.storage });
      if (request.method === "POST" && (url.pathname === "/app/stop" || url.pathname === "/app/retry")) return await serveAppTurnCall(request, url.pathname, { state: this.state, open: (name) => this.chat(name) });
      // The screen the app had open when the person texted (`texChat/appSeen.js`): an app chat's only, 404 for any other.
      if (request.method === "POST" && url.pathname === "/app/seen") return await serveAppSeenPost(request, { storage: this.state.storage });
      if (request.method === "GET" && url.pathname === "/app/seen") return await serveAppSeenGet(this.state.storage);
      if (request.method === "GET" && url.pathname.startsWith("/app/picture/")) return await serveAppPictureById(this.state.storage, url.pathname.slice("/app/picture/".length));
      if (request.method === "GET" && url.pathname.startsWith("/app/file/")) return await serveAppFileById(this.state.storage, url.pathname.slice("/app/file/".length));
      if (url.pathname.startsWith("/chat-call/")) return await this.chatCall(request, url);
      // Where the chat is answered, for the Lab's staff sweep (`packages/lab/gateway/labSandbox/intake.js`).
      if (request.method === "GET" && url.pathname === "/home") {
        // The intake sweep asks every chat its home: a chat already here is indexed by its id then, opened or not.
        const home = await homeOf(this.state.storage);
        if (home.home === "gateway") await indexChat(this.env, this.state.storage, await this.state.storage.get(NAME_KEY), await this.state.storage.get(SENDER_ID_KEY));
        return Response.json(home);
      }
      return Response.json({ error: "unknown_route" }, { status: 404 });
    }

    async alarm() {
      const chat = await this.chat();
      if (chat !== null) await chat.alarm();
    }

    /** A text handed over by the Worker (`agent/textsArrive.js`): answered by the chat, born here on its first. */
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

    /** A call to a chat by its name (`/texts/chat-call`, another chat's `senderObjects`): answered by the chat here. */
    async chatCall(request, url) {
      const name = request.headers.get(INBOX_NAME_HEADER);
      if (name === null || !INBOX_NAME.test(name)) return new Response(null, { status: 400 });
      // A group's directory entry is not a chat: it is answered from this object's own storage (`texChat/directory.js`).
      if (isDirectoryName(name)) return await serveDirectory(request, url.pathname.slice("/chat-call".length), { storage: this.state.storage });
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

    /** The chat object (`packages/tex/worker/chatObject.ts`), running on this object's storage; null with no name to place. */
    async chat(name) {
      if (this.inner !== null) return this.inner;
      const { storage } = this.state;
      // An app chat is born here: placed without a copy, since the Worker has no object of it (`texChat/appChat.js`).
      if (typeof name === "string" && (await isAppChatName(name)) && (await storage.get(PLACE_KEY))?.arrivedAt === undefined) {
        await placeAppChat(storage, name, Date.now);
      }
      // Any other chat is born here too, on its first call (part C of the runtime simplification, Dev2 approved
      // https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX): every chat the Worker held has moved, so there is nothing
      // to copy. Its addresses (pictures, a page of its jobs) carry this object's own id, indexed by `byid:<id>`.
      if (typeof name === "string" && INBOX_NAME.test(name) && (await storage.get(PLACE_KEY))?.arrivedAt === undefined) {
        await placeChat(storage, name, this.state.id.toString(), Date.now);
      }
      if ((await storage.get(PLACE_KEY))?.arrivedAt === undefined) return null;
      this.name = name ?? (await storage.get(NAME_KEY)) ?? null;
      if (this.name === null) return null;
      const { SenderInbox } = await import("../../../packages/tex/worker/gatewayChat.js");
      const senderId = (await storage.get(SENDER_ID_KEY)) ?? "";
      // A call this chat makes to its own Worker object is served here. Asking the Worker would forward it back.
      let servingOwn = false;
      const own = {
        name: `enam:${this.name}`,
        fetch: (request) => {
          if (servingOwn) return Promise.resolve(new Response(null, { status: 421 }));
          servingOwn = true;
          return Promise.resolve(this.inner.fetch(request)).finally(() => {
            servingOwn = false;
          });
        },
      };
      this.inner = new SenderInbox(chatState(this.state, senderId), await chatEnv(this.env, this.state, this.name, senderId, { gateway, texts, own }));
      await indexChat(this.env, storage, this.name, senderId);
      return this.inner;
    }
  };
}

/** Where a chat is answered, read from this object's own place: "gateway" once placed here, "none" before its first call. */
export async function homeOf(storage) {
  const place = await storage.get(PLACE_KEY);
  return place?.arrivedAt === undefined ? { home: "none" } : { home: "gateway", movedAt: place.arrivedAt, keys: Number.isSafeInteger(place.keys) ? place.keys : 0 };
}

/**
 * Places a chat born here: its name, and the id its addresses carry (this object's own). Written once; a chat already
 * placed (copied from the Worker before part C, or born here) keeps what it has.
 */
export async function placeChat(storage, name, senderId, now) {
  if ((await storage.get(PLACE_KEY))?.arrivedAt !== undefined) return;
  await storage.put(NAME_KEY, name);
  await storage.put(SENDER_ID_KEY, typeof senderId === "string" ? senderId : "");
  await storage.put(PLACE_KEY, { arrivedAt: now(), keys: 0, born: true });
}

/**
 * The state the chat object runs on: this object's storage and work, with the id it had in the Worker, so the
 * addresses it mints for pictures and pages reach it through its `byid:<id>` index (`texChat/byId.js`).
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
 * The Worker's `Env`, as the chat object reads it, made of the gateway's bindings. Every other object it reaches (a
 * chat, a job, a directory entry) is the gateway's (`senderObjects`).
 */
export async function chatEnv(env, state, name, senderId, { gateway, texts, own = null, hop = (request) => fetch(request) }) {
  const { remoteLine, remoteGroupLine, appLine, APP_PICTURE_ORIGIN, serveAppFile, serveAppPicture } = await import("../../../packages/tex/worker/gatewayChat.js");
  const ctx = { waitUntil: (work) => state.waitUntil(work), passThroughOnException() {} };
  const self = typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN.replace(/\/+$/, "") : "";
  const rpc = env.TEXTING;
  const app = await isAppChatName(name);
  return {
    // The gateway's own routes run in-process; everything else (the control plane, a picture's address) goes out.
    FETCH: (input, init) => {
      const request = new Request(input, init);
      // An app chat's pictures are read from its own store, never the network (`packages/tex/worker/appPictures.ts`).
      // A file's address (`/file/`) and a picture's (`/pic/`) are each read from the same store, by their own kind.
      if (request.url.startsWith(`${APP_PICTURE_ORIGIN}/`)) {
        if (!app) return Promise.resolve(new Response(null, { status: 404 }));
        return request.url.startsWith(`${APP_PICTURE_ORIGIN}/file/`) ? serveAppFile(state.storage, request.url) : serveAppPicture(state.storage, request.url);
      }
      // Every chat's turn goes over a real hop to the gateway, as a phone's does from the texting Worker: in-process, the
      // whole turn (its prompt, history and reads) lived in this object's isolate, which ran out of memory and was reset
      // before the reply went (Dev2's 8:25 AM app text, 2026-11-20; three `TexJob` `/job-pass` resets, 2026-11-20 and
      // 11-21). App chats, phone chats moved here and background jobs all take it (one path, Dev2 2026-11-21). Only when
      // the hop itself cannot be made does the turn run here, as before.
      if (self !== "" && isTurnCall(request.url, self)) return hopToGateway(hop, request, (kept) => gateway().fetch(kept, env, ctx));
      if (self !== "" && request.url.startsWith(`${self}/`)) return gateway().fetch(request, env, ctx);
      return fetch(request);
    },
    GATEWAY_ORIGIN: self,
    GATEWAY_TEXTS: { fetch: (input, init) => texts().fetch(new Request(input, init), env, ctx) },
    CONTROL_PLANE_ORIGIN: typeof env.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL : "",
    AGENT_WORKER_SECRET: typeof env.AGENT_WORKER_SECRET === "string" ? env.AGENT_WORKER_SECRET : "",
    SENDER_INBOX: senderObjects(env, name, senderId, own),
    // An app chat's line texts nobody: its replies are the chat object's events, which the app reads (`appChat.ts`).
    TEX_LINE: app
      ? { line: () => appLine(state.storage), groupLine: () => { throw new Error("an app chat has no group line"); } }
      : rpc === undefined ? undefined : { line: (chatId) => remoteLine(rpc, name, chatId), groupLine: (groupId) => remoteGroupLine(rpc, name, groupId) },
    IMAGES: env.IMAGES,
    // A kept sticker's picture on Photon's line, at an address only the Worker can sign (`packages/tex/worker/stickerLook.ts`).
    ...(rpc === undefined || typeof rpc.stickerPictureUrl !== "function" ? {} : { STICKER_PICTURE_URL: async (guid) => (await rpc.stickerPictureUrl({ guid }))?.url ?? null }),
    // The Worker's datasets, bound here under the same names, so a text is timed and counted wherever its chat runs.
    TEX_TEXTS: env.TEX_TEXTS,
    TEX_COUNTS: env.TEX_COUNTS,
    // The texts simulator's chats answer here only where the gateway's own var says so (staging).
    ...(env.SIMULATOR === "on" ? { SIMULATOR: "on" } : {}),
    // The Context app's chat: only this object runs as its user (`packages/tex/worker/reply.ts` `sessionOf`).
    ...(app ? { APP_CHAT: name } : {}),
    LINQ_API_KEY: "",
  };
}

/** Whether a call is the turn itself (`POST <gateway>/agent`), not one of the gateway's smaller routes. */
export function isTurnCall(url, self) {
  return typeof url === "string" && (url === `${self}/agent` || url.startsWith(`${self}/agent?`));
}

/**
 * The turn over the network, to a fresh gateway isolate. A hop that throws before any answer (no route, a refused
 * subrequest) runs the turn in-process instead, so a text is never dropped for want of the hop; any answer, an error
 * status included, is the gateway's and is passed on as it is.
 */
export async function hopToGateway(hop, request, inProcess) {
  const kept = request.clone();
  try {
    return await hop(request);
  } catch (error) {
    console.log(JSON.stringify({ event: "turn_hop", outcome: "in_process", error: String(error?.name ?? "error").slice(0, 40) }));
    return inProcess(kept);
  }
}

/**
 * The app chat a name names (`enam:app:<userId>` as `inboxByName` makes it, or bare), or null. An app chat lives only
 * here, in `TEX_CHAT`, and is born here (`texChat/appChat.js`); it is never copied from the texting Worker.
 */
export function appChatNameOf(name) {
  const bare = bareName(name);
  return typeof bare === "string" && /^app:[A-Za-z0-9_-]{1,64}$/.test(bare) ? bare : null;
}

/** A name as a `SENDER_INBOX` lookup was made with it (`enam:<name>`, `objectPlace.ts` `inboxByName`), bare. */
function bareName(name) {
  return typeof name === "string" && name.startsWith("enam:") ? name.slice("enam:".length) : name;
}

/** A stub for a chat's own object here (or a group's directory entry), through its `/chat-call` door. */
function chatCallStub(namespace, name) {
  const stub = objectByName(namespace, `chat:${name}`);
  return {
    fetch: async (input, init) => {
      const request = input instanceof Request && init === undefined ? input : new Request(input, init);
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set(INBOX_NAME_HEADER, name);
      const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
      return stub.fetch(new Request(`https://chat/chat-call${url.pathname}${url.search}`, { method: request.method, headers, body }));
    },
  };
}

/** The id an object has under `name`: its name, and for this chat's own name, the id it had in the Worker. */
function chatId(name, chatName, senderId) {
  return { name, toString: () => (name === `enam:${chatName}` ? senderId : "") };
}

/**
 * The `SENDER_INBOX` the chat object reads, all of it the gateway's (part C of the runtime simplification, Dev2 approved
 * https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX): this chat's own name is served by this object (`own`), a job's
 * name (`enam:job:<id>`) by the gateway's `TEX_JOB` object of that name, and every other name (another chat, a group's
 * directory entry) by its `TEX_CHAT` object, through the same `/chat-call` door the texting Worker uses.
 *
 * The `group-moves` table (`groupMoves.ts`) is reached the same way, and the Worker's own webhook and line read it in
 * the gateway too (`gatewayChats.ts` `chatNamespace`).
 */
function senderObjects(env, chatName, senderId, own) {
  return {
    idFromName: (name) => chatId(name, chatName, senderId),
    idFromString: () => {
      throw new TypeError("an object is reached by name here");
    },
    get: (id) => ({
      fetch: (input, init) => {
        if (own && id.name === own.name && typeof own.fetch === "function") {
          return own.fetch(input instanceof Request && init === undefined ? input : new Request(input, init));
        }
        const job = jobNameOf(id.name);
        if (job !== null) {
          if (env.TEX_JOB === undefined) return Promise.resolve(new Response(null, { status: 503 }));
          return objectByName(env.TEX_JOB, job).fetch(new Request(input, init));
        }
        const bare = bareName(id.name);
        if (env.TEX_CHAT === undefined || typeof bare !== "string" || !INBOX_NAME.test(bare)) return Promise.resolve(new Response(null, { status: 503 }));
        return chatCallStub(env.TEX_CHAT, bare).fetch(input, init);
      },
    }),
  };
}

/** The job's object name (`job:<id>`) inside a name a `SENDER_INBOX` lookup was made with, or null for any other name. */
function jobNameOf(name) {
  const bare = bareName(name);
  return typeof bare === "string" && JOB_NAME.test(bare) ? bare : null;
}
