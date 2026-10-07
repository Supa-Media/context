/**
 * Fixtures shared by the workspace activity checks (`agentActivity.test.mjs`)
 * and the live map's checks (`agentMap.test.mjs`): a bucket, a Durable Object
 * runtime whose storage records every write, a namespace that really runs the
 * room, and the two requests those suites make. Moved verbatim out of
 * `agentActivity.test.mjs`.
 */

import worker from "../src/index.js";
import { PresenceRoom } from "../src/presenceRoom.js";
import { createWorkerCtx } from "./workerCtx.mjs";

export function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
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

/** A Durable Object runtime with no sockets, whose storage records every write. */
export function fakeRuntime() {
  const stored = new Map();
  return {
    stored,
    state: {
      acceptWebSocket() {},
      getWebSockets: () => [],
      storage: {
        async get(key) {
          return stored.get(key);
        },
        async put(entries) {
          for (const [key, value] of Object.entries(entries)) stored.set(key, value);
        },
        async list() {
          return new Map();
        },
        async delete() {},
        async deleteAll() {
          stored.clear();
        },
        async setAlarm() {},
        async getAlarm() {
          return null;
        },
      },
    },
  };
}

/**
 * A namespace that really runs the room object, one instance per name.
 *
 * The note-room checks elsewhere stub the namespace and read what the route
 * *sent*. Here the answer depends on what an earlier call recorded, so the
 * object has to exist and remember between requests, as the runtime's does.
 */
export function createLiveNamespace() {
  const instances = new Map();
  const runtimes = new Map();
  const calls = [];
  return {
    calls,
    runtimes,
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      if (!instances.has(id.name)) {
        const runtime = fakeRuntime();
        runtimes.set(id.name, runtime);
        instances.set(id.name, new PresenceRoom(runtime.state, {}));
      }
      const room = instances.get(id.name);
      return {
        async fetch(request, init) {
          const asRequest = request instanceof Request ? request : new Request(request, init);
          const body = asRequest.method === "POST" ? await asRequest.clone().text() : null;
          calls.push({ name: id.name, url: asRequest.url, method: asRequest.method, body });
          return room.fetch(asRequest);
        },
      };
    },
  };
}

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

export async function activityRequest(env, token, { query = "", method = "GET", headers = {} } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://mcp.context.test/agent-activity${query}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
