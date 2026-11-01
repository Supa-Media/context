/**
 * A `TEX_STORE` Durable Object namespace for tests: the real `TexStore` class
 * (src/texStore.js) over `node:sqlite`, one object per name, with every call
 * the gateway makes to an object recorded (`calls`: `{name, op}`), so a test
 * can say which object a turn reached and how many times.
 */

import { DatabaseSync } from "node:sqlite";
import { TexStore } from "../src/texStore.js";

/** `node:sqlite` in the Durable Object's `sql.exec(...).toArray()` shape. */
export function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...binds) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...binds);
        return { toArray: () => all };
      }
      statement.run(...binds);
      return { toArray: () => [] };
    },
  };
}

function stateOver() {
  const storage = {
    sql: durableSql(),
    alarm: undefined,
    setAlarm(at) {
      storage.alarm = at;
    },
    deleteAlarm() {
      storage.alarm = null;
    },
  };
  return { storage };
}

export function texStoreNamespace() {
  const objects = new Map();
  const calls = [];
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new TexStore(stateOver(), {}, { dispatch: async () => ({ next: null }) }));
    return objects.get(name);
  };
  const namespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (request) => {
        let call = null;
        try {
          call = JSON.parse(decodeURIComponent(request.headers.get("x-tex-call") ?? "null"));
        } catch {
          call = null;
        }
        const op = call?.op ?? "?";
        calls.push({ name: id.name, op, ...(typeof call?.key === "string" ? { key: call.key } : {}) });
        // A test's hook, run before the object answers: a slow write, say.
        if (typeof api.before === "function") await api.before(id.name, call ?? {});
        return await object(id.name).fetch(request);
      },
    }),
  };
  /** The keys an object holds, or [] for one never made. */
  const keysIn = (name) => {
    const held = objects.get(name);
    if (!held) return [];
    held.ready();
    return held.objects.list({}).objects.map((entry) => entry.key);
  };
  /** One object's kept text at `key`, or null. */
  const textIn = (name, key) => {
    const held = objects.get(name);
    if (!held) return null;
    held.ready();
    const found = held.objects.get(key);
    return found?.body ? new TextDecoder().decode(found.body) : null;
  };
  const api = { namespace, calls, objects, object, keysIn, textIn, before: null };
  return api;
}

const AGENT = ".context/agent/";
const AGENT_HOME = /^\.context\/agent\/(history|turns|running|cancel|steer)\//;

/**
 * A test bucket (a Map of key to `{body, etag, contentType, lastModified}`)
 * with a person's Tex bookkeeping (`.context/agent/{history,turns,running,
 * cancel,steer}/`) read from and written to their object instead, under the
 * names the gateway uses (`store/texRouting.js`): what a test that looked at
 * those keys in the bucket now looks at. Every other key is the bucket's.
 */
export function withAgentHome(bucket, tex, workspaceId) {
  const name = `person:${workspaceId}`;
  const inner = (key) => `state/agent/${key.slice(AGENT.length)}`;
  const held = () => {
    const object = tex.objects.get(name);
    if (object) object.ready();
    return object?.objects ?? null;
  };
  const ensure = () => {
    const object = tex.object(name);
    object.ready();
    return object.objects;
  };
  const entryOf = (found) =>
    found
      ? { body: found.body ? new TextDecoder().decode(found.body) : "", etag: found.etag, contentType: found.httpMetadata?.contentType ?? found.contentType, lastModified: new Date(found.uploaded).toISOString() }
      : undefined;
  const view = {
    has: (key) => (AGENT_HOME.test(key) ? (held()?.head(inner(key)) ?? null) !== null : bucket.has(key)),
    get: (key) => (AGENT_HOME.test(key) ? entryOf(held()?.get(inner(key))) : bucket.get(key)),
    /** A bookkeeping key's write is the object's, and answers a promise: await it. */
    set: (key, entry) => {
      if (!AGENT_HOME.test(key)) return bucket.set(key, entry);
      return ensure().put(inner(key), new TextEncoder().encode(String(entry?.body ?? "")), {});
    },
    delete: (key) => (AGENT_HOME.test(key) ? (held()?.delete(inner(key)), true) : bucket.delete(key)),
    keys: () => {
      const own = (held()?.list({ prefix: "state/agent/" }).objects ?? []).map((entry) => `${AGENT}${entry.key.slice("state/agent/".length)}`);
      return [...[...bucket.keys()].filter((key) => !AGENT_HOME.test(key)), ...own][Symbol.iterator]();
    },
    get size() {
      return [...view.keys()].length;
    },
    /** The bucket alone, for a check that nothing of this was written there. */
    bucket,
  };
  return view;
}
