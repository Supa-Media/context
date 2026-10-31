/**
 * Tex's notes, routed to their Durable Object (decided by the owner,
 * 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * A note Tex keeps has a row like every note, its id for a file name, and a
 * key of the Tex form, `tex/<owner>/notes/<noteId>.md` (`isTexKey`): that key
 * is the mark that its text lives in the owner's Durable Object, not in the
 * bucket. Every read and write that names such a key, by the id layer above or
 * by anything holding the row's key (the trash's emptying, an export), comes
 * here and goes to that object with the rest of the key; every other key goes
 * to the bucket as before.
 *
 * - Only this workspace's own owners: `person:<workspaceId>`, and the group
 *   chats the store was built for. A key naming any other owner is refused, so
 *   a row can never point one workspace's store at another's object.
 * - Fails closed: with no way to reach the object (no binding, a control plane
 *   that cannot call the gateway), a Tex key is refused, never looked for in
 *   the bucket.
 * - One narrower form besides: a group chat's own state,
 *   tex/chat:<chatKey>/state/<64 hex>.json (`isTexStateKey`), its memory
 *   record. No row names it and only a chat's object holds one: the same
 *   shape under `person:`, or anything else under `state/`, is refused.
 * - Below the id layer and above the bucket's own wrappers (logical deletes,
 *   managed encryption): the object keeps plain text, encrypted at rest by
 *   Cloudflare, and answers conditional writes itself.
 */

import { isTexKey, isTexStateKey } from "../privacy/engine.js";

/** Thrown for a Tex key this store cannot serve: another workspace's owner, or no way to reach the object. */
export class TexStoreUnavailable extends Error {
  constructor(reason) {
    super(`Tex's notes are not reachable here: ${reason}`);
    this.name = "TexStoreUnavailable";
    this.code = "STORAGE_UNAVAILABLE";
    this.reason = reason;
  }
}

/** Anything shaped as a Tex owner's `state/`, so a near miss is refused rather than sent to the bucket. */
const STATE_SHAPED = /^tex\/[^/]*:[^/]*\/state(?:\/|$)/;

/** `{owner, key}` for a Tex key or a chat's state key: whose object, and the key inside it. */
export function splitTexKey(key) {
  if (!isTexKey(key) && !isTexStateKey(key)) return null;
  const cut = key.indexOf("/", "tex/".length);
  return { owner: key.slice("tex/".length, cut), key: key.slice(cut + 1) };
}

/** The Tex key for an id key kept in `owner`'s object. */
export function texKeyFor(owner, idKey) {
  const key = `tex/${owner}/${idKey}`;
  if (!isTexKey(key)) throw new TypeError("not an id key, or not an owner");
  return key;
}

/** A group chat's state key: `name` is 64 hex (a SHA-256), kept in that chat's object alone. */
export function texStateKeyFor(chat, name) {
  const key = ["tex", `chat:${chat}`, "state", `${name}.json`].join("/");
  if (!isTexStateKey(key)) throw new TypeError("not a chat, or not a state name");
  return key;
}

/**
 * `store` with Tex keys sent to their object.
 *
 * @param {object} store
 * @param {{workspaceId: string, chats?: string[], texStore?: ((owner: string) => object|null)|null}} options
 *   `texStore(owner)` answers a ContextStore over that owner's object, or null.
 */
export function withTexRouting(store, { workspaceId, chats = [], texStore = null } = {}) {
  if (!store) return store;
  const allowed = new Set([`person:${workspaceId}`, ...chats.map((chat) => `chat:${chat}`)]);
  const opened = new Map();

  /** The object's store and the key inside it, or `null` for a bucket key. */
  const route = (key) => {
    const split = splitTexKey(key);
    if (split === null) {
      if (typeof key === "string" && STATE_SHAPED.test(key)) throw new TexStoreUnavailable("not a key a chat's state is kept at");
      return null;
    }
    if (typeof workspaceId !== "string" || workspaceId === "" || !allowed.has(split.owner)) {
      throw new TexStoreUnavailable("a key that names another workspace's Tex");
    }
    if (!opened.has(split.owner)) opened.set(split.owner, typeof texStore === "function" ? texStore(split.owner) : null);
    const target = opened.get(split.owner);
    if (!target) throw new TexStoreUnavailable("no way to reach Tex's Durable Object");
    return { target, key: split.key };
  };

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  // The chats this store was built for (a group turn's grant names its own), so a turn knows where its chat's state lives.
  Object.defineProperty(wrapped, "texChats", { value: Object.freeze([...chats]), enumerable: false, writable: false, configurable: false });

  const byKey = (method, fallback) => async (key, ...rest) => {
    const routed = route(key);
    if (routed === null) return await store[method](key, ...rest);
    if (typeof routed.target[method] === "function") return await routed.target[method](routed.key, ...rest);
    return await fallback(routed.target, routed.key, ...rest);
  };

  for (const method of ["get", "head", "put", "delete"]) {
    if (typeof store[method] === "function") wrapped[method] = byKey(method);
  }
  const present = async (target, key) => (await target.head(key)) !== null;
  if (typeof store.exists === "function") wrapped.exists = byKey("exists", present);
  if (typeof store.existsMetadata === "function") wrapped.existsMetadata = byKey("existsMetadata", present);

  if (typeof store.copy === "function") {
    // Within one side it is that side's own copy; across the two it is a read and a write.
    wrapped.copy = async (source, destination, options = {}) => {
      const from = route(source);
      const to = route(destination);
      if (from === null && to === null) return await store.copy(source, destination, options);
      if (from !== null && to !== null && from.target === to.target) return await from.target.copy(from.key, to.key, options);
      if (options?.onlyIf?.absent === true && (await wrapped.head(destination)) !== null) return null;
      const object = await wrapped.get(source);
      if (object === null) return null;
      const contentType = object.httpMetadata?.contentType ?? object.contentType;
      return await wrapped.put(destination, await object.arrayBuffer(), {
        ...(contentType ? { contentType } : {}),
        ...(object.customMetadata ? { customMetadata: object.customMetadata } : {}),
      });
    };
  }

  if (typeof store.list === "function") {
    // A listing under `tex/<owner>/` is that object's, with the prefix put back on each key; any other is the bucket's.
    wrapped.list = async (options = {}) => {
      const prefix = typeof options.prefix === "string" ? options.prefix : "";
      const match = /^tex\/((?:person|chat):[A-Za-z0-9_-]{1,64})\/(.*)$/.exec(prefix);
      if (!match) return await store.list(options);
      const head = `tex/${match[1]}/`;
      const routed = route(`${head}notes/00000000-0000-7000-8000-000000000000.md`);
      const page = await routed.target.list({
        ...options,
        prefix: match[2],
        ...(typeof options.startAfter === "string" && options.startAfter.startsWith(head) ? { startAfter: options.startAfter.slice(head.length) } : {}),
      });
      return {
        ...page,
        objects: (page.objects ?? []).map((object) => ({ ...object, key: `${head}${object.key}` })),
        delimitedPrefixes: (page.delimitedPrefixes ?? []).map((folded) => `${head}${folded}`),
      };
    };
  }

  return wrapped;
}
