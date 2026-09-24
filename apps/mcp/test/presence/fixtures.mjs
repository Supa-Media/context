/**
 * Shared fixtures for `test/presence/*.test.mjs`, split out of the original
 * presence.test.mjs — see presence.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import worker, {
  PresenceRoom as GatewayPresenceRoom,
  presenceClientKey,
} from "../../src/index.js";
import { PresenceRoom } from "../../src/presenceRoom.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_MEMBERS_PER_ROOM,
  MAX_OFFSET,
  MEMBER_IDLE_MS,
  admit,
  applyCursor,
  colorFor,
  createRoom,
  decodeClientFrame,
  expire,
  forget,
  normalizeDisplayName,
  normalizeOffset,
  roomKey,
  roster,
  touch,
} from "../../src/presence.js";

export {
  worker,
  GatewayPresenceRoom,
  presenceClientKey,
  PresenceRoom,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createWorkerCtx,
  MAX_CLIENT_FRAME_BYTES,
  MAX_MEMBERS_PER_ROOM,
  MAX_OFFSET,
  MEMBER_IDLE_MS,
  admit,
  applyCursor,
  colorFor,
  createRoom,
  decodeClientFrame,
  expire,
  forget,
  normalizeDisplayName,
  normalizeOffset,
  roomKey,
  roster,
  touch,
};

export const OWNER_TOKEN = `cat_presence_owner_${"0".repeat(14)}`;
export const TEAM_TOKEN = `cat_presence_team_${"0".repeat(15)}`;
export const OTHER_TOKEN = `cat_presence_other_${"0".repeat(14)}`;
export const SHARED_TOKEN = `cat_presence_shared_${"0".repeat(13)}`;
export const NOHANDLE_TOKEN = `cat_presence_nohandle_${"0".repeat(11)}`;

/** One team folder and one private note inside it, so a refusal is the rule. */
export const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  "note_overrides:\n  1-projects/rates.md: private\n  1-projects/marker-sized.md: private\n  1-projects/group.md: @writers\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export function createBucket() {
  const objects = new Map();
  let etags = 0;
  /*
    Storage round trips, counted.

    A refusal that reads the same and costs a different number of trips to the
    bucket is still two different answers — the second one is just measured
    with a clock rather than read. Counting them is what makes that a
    deterministic check instead of a flaky timing one.
  */
  const ops = { get: 0, list: 0, put: 0, delete: 0 };
  const fetched = [];
  const trips = () => ops.get + ops.list + ops.put + ops.delete;
  return {
    ops,
    trips,
    fetched,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      ops.get += 1;
      fetched.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      ops.put += 1;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      ops.delete += 1;
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      ops.list += 1;
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

/**
 * A Durable Object namespace that records rather than connects.
 *
 * The route's job ends at "address this room, with this member" — the socket
 * itself is the runtime's. So the stub keeps the name the route derived and the
 * header it set, which between them are the two things a client must not be
 * able to influence.
 */
export function createRoomNamespaceStub() {
  const calls = [];
  return {
    calls,
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      return {
        async fetch(request, init) {
          // A notice from a tool arrives as a POST with a body rather than as
          // an upgrade, so the stub records the body where there is one.
          const asRequest = request instanceof Request ? request : new Request(request, init);
          calls.push({
            name: id.name,
            member: asRequest.headers.get("x-presence-member"),
            url: asRequest.url,
            authorization: asRequest.headers.get("authorization"),
            cookie: asRequest.headers.get("cookie"),
            body: asRequest.method === "POST" ? await asRequest.text() : null,
          });
          return new Response("joined", { status: 200 });
        },
      };
    },
  };
}

/** One MCP tool call, so the write path can be checked against the room. */
export async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

export async function presenceRequest(env, token, query, init = {}) {
  const { ctx, settle } = createWorkerCtx();
  const headers = { Upgrade: "websocket", ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  // `path` overrides the route entirely, for the one check that has to address
  // `/@slug/presence` rather than `/presence`.
  const target = init.path || `/presence${query}`;
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${target}`, {
      method: init.method || "GET",
      headers,
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text };
}

/** A fake `WebSocket`, per the two-way surface `PresenceRoom` calls. */
export function fakeSocket() {
  const sent = [];
  const closed = [];
  let attachment = null;
  let readyState = 1;
  return {
    sent,
    closed,
    get readyState() {
      return readyState;
    },
    setReadyState(value) {
      readyState = value;
    },
    frames: () => sent.map((text) => JSON.parse(text)),
    send: (text) => sent.push(text),
    close(code, reason) {
      closed.push({ code, reason });
      readyState = 3;
    },
    serializeAttachment: (value) => {
      attachment = value;
    },
    deserializeAttachment: () => attachment,
  };
}

/** A fake Durable Object runtime: hibernatable sockets, storage, an alarm. */
export function fakeRoomRuntime() {
  const open = [];
  const stored = new Map();
  let alarm = null;
  return {
    open,
    alarmAt: () => alarm,
    state: {
      acceptWebSocket: (ws) => open.push(ws),
      getWebSockets: () => [...open],
      storage: {
        async get(key) {
          return stored.get(key);
        },
        async put(entries) {
          for (const [key, value] of Object.entries(entries)) stored.set(key, value);
        },
        async list({ prefix = "", end, limit } = {}) {
          const hits = [...stored.entries()]
            .filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end))
            .sort(([a], [b]) => a.localeCompare(b));
          // `limit` is honoured because `ensureAlarm` passes one, and a fake
          // that ignored it would be testing a call the runtime does not make.
          return new Map(typeof limit === "number" ? hits.slice(0, limit) : hits);
        },
        async delete(keys) {
          for (const key of keys) stored.delete(key);
        },
        async deleteAll() {
          stored.clear();
        },
        async setAlarm(at) {
          alarm = at;
        },
        async getAlarm() {
          return alarm;
        },
      },
    },
  };
}

/**
 * Installs a fake `WebSocketPair` global for the duration of `run`, and
 * restores whatever was there before — the room-object sections of this
 * suite construct real `PresenceRoom`/`RelayRoom` instances and call
 * `.fetch()` on them with an `Upgrade` header, which reaches
 * `new WebSocketPair()` the way the Workers runtime never does in node.
 *
 * `run` is called with the `pairs` array every pair created during the call
 * is pushed onto, in creation order — the same array the original
 * presence.test.mjs closed over directly, before this was split into
 * `test/presence/*.test.mjs` each needing their own install/restore cycle.
 */
export async function withFakeWebSocketPair(run) {
  const previousPair = globalThis.WebSocketPair;
  const pairs = [];
  globalThis.WebSocketPair = function FakePair() {
    const client = fakeSocket();
    const server = fakeSocket();
    pairs.push({ client, server });
    return [client, server];
  };
  try {
    await run(pairs);
  } finally {
    if (previousPair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = previousPair;
  }
}
