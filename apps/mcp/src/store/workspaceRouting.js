/**
 * Note texts and shared-editing history, routed to the workspace's object by
 * its home (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * Only keys `isWorkspaceObjectKey` names move (`notes/<noteId>.md`,
 * `.context/collaboration/…`); every other key is the bucket's as before.
 * The home rides on the binding the control plane serves (`notesHome`, set by
 * the same switch that calls the object's `setHome`); a binding naming none is
 * `bucket`, and the object is never called:
 *
 * - `bucket`: nothing changes; the object is never called again for a key.
 * - `dual`: reads and conditional writes go to the bucket, and every write and
 *   delete is mirrored to the object unconditionally, so the object fills
 *   while the bucket stays the truth.
 * - `object`: reads and conditional writes go to the object. Every write and
 *   delete is still made in the bucket, as the backup copy written behind,
 *   never read on a request once the workspace is backfilled. Before then a
 *   note missing from the object is read from the bucket and copied in.
 *
 * Because both sides are written in every home but `bucket`, a request built
 * from a binding a moment older than a switch reads a current copy either way. A mirror
 * write that fails is logged and never fails the caller's write; the copy
 * and compare check finds and repairs it.
 */

import { HOMES, isHome, isWorkspaceObjectKey } from "../workspaceStore/api.js";

const routedPrefix = (prefix) => typeof prefix === "string" && (prefix.startsWith("notes/") || prefix.startsWith(".context/collaboration/"));

/**
 * @param {object} store the bucket's store
 * @param {{workspaceId: string, client?: object|null, known?: {home?: string, backfilledAt?: number|null}|null, now?: () => number, defer?: ((promise: Promise<unknown>) => void)|null, log?: (event: string, fields: object) => void}} options
 *   `client` is `workspaceClient(env, workspaceId)`; absent, the store is returned as it is. `known` is the home the
 *   control plane carried on the binding (`notesHome`, `notesBackfilledAt`): when it names a home the object is not asked.
 *   `defer` lets the bucket's backup write finish after the response (`ctx.waitUntil`); without it the write is awaited.
 */
export function withWorkspaceRouting(store, { workspaceId, client = null, known = null, now = Date.now, defer = null, log = () => {} } = {}) {
  if (!store || !client || typeof workspaceId !== "string" || workspaceId === "") return store;
  const object = client.bodies;

  // The binding's home, as the control plane carries it. None named is the bucket: the object is never asked.
  const held = { home: isHome(known?.home) ? known.home : HOMES.BUCKET, backfilledAt: typeof known?.backfilledAt === "number" ? known.backfilledAt : null };
  if (held.home === HOMES.BUCKET) return store;
  const state = async () => held;

  const mirror = (label, key, work) => {
    const running = (async () => {
      try {
        await work();
      } catch (error) {
        log("workspace_mirror_failed", { workspaceId, op: label, key, error: String(error?.message ?? error) });
      }
    })();
    if (typeof defer === "function") {
      defer(running);
      return Promise.resolve();
    }
    return running;
  };

  /** Which side is read, and which side is mirrored, for one key. */
  const sides = async (key) => {
    if (!isWorkspaceObjectKey(key)) return null;
    const { home, backfilledAt } = await state();
    if (home === HOMES.OBJECT) return { primary: object, secondary: store, home, backfilled: typeof backfilledAt === "number" };
    if (home === HOMES.DUAL) return { primary: store, secondary: object, home, backfilled: false };
    return null;
  };

  const wrapped = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));

  const plainOptions = (options) => {
    if (!options || typeof options !== "object") return options;
    const { onlyIf: _onlyIf, ...rest } = options;
    return rest;
  };

  for (const method of ["get", "head"]) {
    if (typeof store[method] !== "function") continue;
    wrapped[method] = async (key, ...rest) => {
      const routed = await sides(key);
      if (routed === null) return await store[method](key, ...rest);
      const found = await routed.primary[method](key, ...rest);
      if (found !== null || routed.home !== HOMES.OBJECT || routed.backfilled) return found;
      // Object home, not yet backfilled: the bucket still has it. Copy it in, then answer from the object.
      const fromBucket = await store.get(key);
      if (fromBucket === null) return null;
      const contentType = fromBucket.httpMetadata?.contentType ?? fromBucket.contentType;
      await object.put(key, await fromBucket.arrayBuffer(), {
        ...(contentType ? { contentType } : {}),
        ...(fromBucket.customMetadata ? { customMetadata: fromBucket.customMetadata } : {}),
        onlyIf: { absent: true },
      }).catch(() => null);
      log("workspace_note_copied_on_read", { workspaceId, key });
      return await object[method](key, ...rest);
    };
  }

  if (typeof store.put === "function") {
    wrapped.put = async (key, value, options = {}) => {
      const routed = await sides(key);
      if (routed === null) return await store.put(key, value, options);
      const bytes = value instanceof Uint8Array || typeof value === "string" ? value : new Uint8Array(await new Response(value).arrayBuffer());
      const written = await routed.primary.put(key, bytes, options);
      if (written !== null) {
        await mirror("put", key, () => routed.secondary.put(key, bytes, plainOptions(options)));
      }
      return written;
    };
  }

  if (typeof store.delete === "function") {
    wrapped.delete = async (keys, ...rest) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const moving = [];
      for (const key of list) if ((await sides(key)) !== null) moving.push(key);
      if (moving.length === 0) return await store.delete(keys, ...rest);
      // The side reads come from is deleted first and its failure is the caller's; the other copy follows.
      if (held.home === HOMES.OBJECT) {
        for (const key of moving) await object.delete(key);
        return await store.delete(keys, ...rest);
      }
      const answer = await store.delete(keys, ...rest);
      for (const key of moving) await mirror("delete", key, () => object.delete(key));
      return answer;
    };
  }

  for (const method of ["exists", "existsMetadata"]) {
    if (typeof store[method] !== "function") continue;
    wrapped[method] = async (key, ...rest) => {
      const routed = await sides(key);
      if (routed === null || routed.primary === store) return await store[method](key, ...rest);
      return (await wrapped.head(key)) !== null;
    };
  }

  if (typeof store.copy === "function") {
    wrapped.copy = async (source, destination, options = {}) => {
      if ((await sides(source)) === null && (await sides(destination)) === null) return await store.copy(source, destination, options);
      if (options?.onlyIf?.absent === true && (await wrapped.head(destination)) !== null) return null;
      const found = await wrapped.get(source);
      if (found === null) return null;
      const contentType = found.httpMetadata?.contentType ?? found.contentType;
      return await wrapped.put(destination, new Uint8Array(await found.arrayBuffer()), {
        ...(contentType ? { contentType } : {}),
        ...(found.customMetadata ? { customMetadata: found.customMetadata } : {}),
      });
    };
  }

  if (typeof store.list === "function") {
    wrapped.list = async (options = {}) => {
      if (!routedPrefix(options?.prefix)) return await store.list(options);
      const { home, backfilledAt } = await state();
      // A listing is the object's only once it holds everything; until then the bucket's is the complete one.
      if (home === HOMES.OBJECT && typeof backfilledAt === "number") return await object.list(options);
      return await store.list(options);
    };
  }

  return wrapped;
}
