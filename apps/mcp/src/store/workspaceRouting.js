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
 * Saved versions (`.context/collaboration/v1/revisions/`) are the exception
 * in `object`: the object keeps each document's current and pending ones, and
 * one it lacks is read from the bucket and never copied in. Saving a
 * document's state drops the object's copies of the versions it no longer
 * names, and a listing that reaches them is the bucket's. One the bucket does
 * not hold is kept instead: the copy and compare check cannot repair a missing
 * older revision, because it skips them when it walks the bucket, so the
 * object's copy may be the only one.
 *
 * Because both sides are written in every home but `bucket`, a request built
 * from a binding a moment older than a switch reads a current copy either way. A mirror
 * write that fails is logged and never fails the caller's write; the copy
 * and compare check finds and repairs it.
 */

import { r2Shaped } from "../texStore/wire.js";
import { lastWriteEach } from "../workspaceStore/lastWrite.js";
import { HOMES, REVISIONS, documentStateId, isHome, isRevisionKey, isWorkspaceObjectKey } from "../workspaceStore/api.js";

const routedPrefix = (prefix) => typeof prefix === "string" && (prefix.startsWith("notes/") || prefix.startsWith(".context/collaboration/"));

/** A workspace note's key in its object, the one form `ws.collab.read` serves (`workspaceStore/collabRead.js`). */
const OBJECT_NOTE_KEY = /^notes\/[A-Za-z0-9-]{1,128}\.md$/;

/** A listing that could name an older saved version, which only the bucket holds whole. */
const coversRevisions = (prefix) => typeof prefix === "string" && (REVISIONS.startsWith(prefix) || prefix.startsWith(REVISIONS));
/**
 * How long a saved version no document names yet is kept in the object: a version kept when its person went idle,
 * or one an older writer made before the document that names it (`commitSnapshot`), may still be in flight.
 */
export const REVISION_GRACE_MS = 10 * 60 * 1000;


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

  // One key's backup writes land in the order they were made: written behind the response, two saves of one note
  // in a request would otherwise race, and the older could land last.
  const queued = new Map();
  const mirror = (label, key, work) => {
    const before = queued.get(key) ?? Promise.resolve();
    const running = before.then(async () => {
      try {
        await work();
      } catch (error) {
        log("workspace_mirror_failed", { workspaceId, op: label, key, error: String(error?.message ?? error) });
      }
    });
    queued.set(key, running);
    running.then(() => {
      if (queued.get(key) === running) queued.delete(key);
    });
    // `defer` answers `false` when it has nothing to hand the work to yet (a session store opened before its
    // request's `ctx` was laid on it, `sessionStore.js`): the write is then awaited, never dropped.
    if (typeof defer === "function" && defer(running) !== false) return Promise.resolve();
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

  /**
   * After a document's state is saved in the object, drop the object's copies of that document's saved versions it
   * no longer names (its `revision` and `pending.revision` stay), once older than the grace. The bucket keeps them all.
   */
  const pruneRevisions = async (documentId, bytes) => {
    let named;
    try {
      const state = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));
      named = new Set([state?.revision, state?.pending?.revision].filter((value) => typeof value === "string"));
    } catch {
      return;
    }
    if (named.size === 0) return;
    const prefix = `${REVISIONS}${documentId}/`;
    const before = now() - REVISION_GRACE_MS;
    let cursor;
    for (let pages = 0; pages < 100; pages += 1) {
      const page = await object.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
      for (const entry of page?.objects ?? []) {
        const revision = entry.key.slice(prefix.length).replace(/\.json$/, "");
        const uploaded = new Date(entry.uploaded ?? 0).getTime();
        if (named.has(revision) || !Number.isFinite(uploaded) || uploaded >= before) continue;
        // Only ever a second copy comes out. A mirror write that failed is logged and never fails the caller's
        // write, so the object can hold the only copy of a version; deleting that one would lose customer-owned
        // editing history, and no parity side could see the gap afterwards (walking the bucket skips older
        // revisions, and walking the object no longer finds the key).
        if ((await store.head(entry.key)) === null) {
          log("workspace_revision_unmirrored", { workspaceId, key: entry.key });
          continue;
        }
        await object.delete(entry.key);
      }
      if (!page?.truncated || !page.cursor) break;
      cursor = page.cursor;
    }
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
      if (found !== null || routed.home !== HOMES.OBJECT) return found;
      // An older saved version is never copied in: the bucket keeps those, and answers for them.
      if (isRevisionKey(key)) return await store[method](key, ...rest);
      if (routed.backfilled) return found;
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
        const documentId = routed.home === HOMES.OBJECT ? documentStateId(key) : null;
        if (documentId !== null) await mirror("prune", key, () => pruneRevisions(documentId, bytes));
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
      // A conditional delete (`onlyIf`, from collaboration's purge, erase and recoveries) names the version the
      // caller read, from the side reads come from. That side decides, and a refusal (`null`: a newer write won)
      // leaves BOTH copies; deleting the other copy anyway is how a key went missing from one side alone.
      const [options, ...more] = rest;
      const conditional = options?.onlyIf !== undefined && options?.onlyIf !== null;
      // The side reads come from is deleted first and its failure is the caller's; the other copy follows.
      if (held.home === HOMES.OBJECT) {
        for (const key of moving) {
          const removed = await object.delete(key, ...rest);
          if (conditional && removed === null) return null;
        }
        // The bucket's copy follows unconditionally: the condition named the object's version, not the bucket's.
        return await store.delete(keys, ...(conditional ? [plainOptions(options), ...more] : rest));
      }
      const answer = await store.delete(keys, ...rest);
      if (conditional && answer === null) return answer;
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
      // Saved versions never are the object's whole (it keeps the current ones), so a listing that reaches them
      // (an export, a purge) is the bucket's, which every version is written to.
      if (home === HOMES.OBJECT && typeof backfilledAt === "number" && !coversRevisions(options?.prefix)) return await object.list(options);
      return await store.list(options);
    };
  }

  /**
   * A whole-note save's editing history, run in the object in one call (`workspaceStore/collabReplace.js`), for an
   * object-home workspace the object holds whole. Every write it made is copied to the bucket behind the response,
   * exactly as `put` copies one, and a document state it wrote prunes the object's older versions the same way.
   * `null` when the object did not serve it (not held there, the row moved, a version only the bucket keeps): the
   * caller then runs the engine through this store, as before.
   */
  /**
   * Every write the object's engine made (`collabReplace.js`, `collabRead.js`), copied to the bucket behind the
   * response exactly as `put` copies one, and a document state it wrote prunes the object's older versions the same way.
   */
  const copyHandedBack = async (answer) => {
    for (const write of lastWriteEach(Array.isArray(answer?.writes) ? answer.writes : [])) {
      await mirror("put", write.key, () => store.put(write.key, write.body));
      const documentId = documentStateId(write.key);
      if (documentId !== null) await mirror("prune", write.key, () => pruneRevisions(documentId, write.body));
    }
    for (const removed of Array.isArray(answer?.deletes) ? answer.deletes : []) {
      if (typeof removed === "string") await mirror("delete", removed, () => store.delete(removed));
    }
  };

  if (typeof client.collab?.replace === "function") {
    wrapped.replaceInObject = async ({ path, key, noteId, legacyEtag = null, rowEtag = null, expectedEtag, text, record = null }) => {
      if (held.home !== HOMES.OBJECT || typeof held.backfilledAt !== "number") return null;
      const answer = await client.collab.replace({
        path, key, noteId,
        ...(typeof legacyEtag === "string" && typeof rowEtag === "string" ? { legacyEtag, rowEtag } : {}),
        expectedEtag, text,
        ...(Number.isFinite(record?.at) ? { record: { at: record.at } } : {}),
      });
      await copyHandedBack(answer);
      if (answer?.served === true) return answer;
      // Why the save ran the engine from here instead: a short code from the object, never the path.
      const reason = typeof answer?.reason === "string" && /^[a-z_]{1,32}$/.test(answer.reason) ? answer.reason : null;
      log("workspace_object_collab_not_served", { workspaceId, reason });
      // Said to the save too, with the object's time on it, so its timings show why (`tools/notes/replaceInObject.js`).
      return { served: false, reason, ...(Number.isFinite(answer?.took) ? { took: answer.took } : {}) };
    };
  }

  /**
   * A note's Markdown and its editing history's text in one call (`workspaceStore/collabRead.js`), for `read_note` in
   * an object-home workspace the object holds whole: `{markdown, collaboration|error, took}`. `null` when the object
   * did not serve it, and the caller reads the Markdown and the history through this store, as before.
   */
  if (typeof client.collab?.read === "function") {
    wrapped.readInObject = async ({ path, key, noteId }) => {
      if (held.home !== HOMES.OBJECT || typeof held.backfilledAt !== "number") return null;
      // Only a workspace note's own key: a Tex note's (`tex/…`) lives in Tex's store, so asking would be a wasted trip.
      if (typeof key !== "string" || !OBJECT_NOTE_KEY.test(key)) return null;
      const answer = await client.collab.read({ path, key, noteId });
      await copyHandedBack(answer);
      const markdown = answer?.markdown;
      if (answer?.served === true && typeof markdown?.etag === "string" && typeof markdown.text === "string") return answer;
      // Why the read went the long way instead: a short code from the object, never the path.
      log("workspace_object_read_not_served", { workspaceId, reason: typeof answer?.reason === "string" ? answer.reason : null });
      return null;
    };
  }

  /**
   * A note's Markdown as its row's lookup carried it (`workspaceStore/lookupBody.js`), shaped as `get` answers it from
   * the object, for the id layer's edit (`idLayout.js` `oneWrite`). Only where `get` would read that key from the
   * object (home `object`); else `null`, and the id layer reads it with `get`.
   */
  wrapped.storedFromLookup = (key, body) => {
    if (held.home !== HOMES.OBJECT || typeof key !== "string" || !OBJECT_NOTE_KEY.test(key)) return null;
    if (body?.meta?.key !== key || typeof body.meta.etag !== "string" || typeof body.text !== "string") return null;
    return r2Shaped(body.meta, new TextEncoder().encode(body.text));
  };

  /**
   * A new note's bytes and row in one call to the workspace object (`workspaceStore/createNote.js`), for the id layer's
   * create (`idLayout.js` `keyedCreate`). `null` where the object does not serve it, and the caller puts as before.
   */
  if (typeof client.collab?.create === "function") {
    wrapped.createInObject = async ({ path, noteId, key, text, tier, at, contentType = null, checks = false }) => {
      if (held.home !== HOMES.OBJECT || typeof held.backfilledAt !== "number") return null;
      const answer = await client.collab.create({ path, noteId, key, text, tier, at, ...(typeof contentType === "string" ? { contentType } : {}), ...(checks === true ? { checks: true } : {}) });
      for (const write of Array.isArray(answer?.writes) ? answer.writes : []) {
        if (typeof write?.key !== "string" || typeof write.body !== "string") continue;
        await mirror("put", write.key, () => store.put(write.key, write.body, typeof contentType === "string" ? { httpMetadata: { contentType } } : {}));
      }
      if (answer?.served === true && typeof answer.etag === "string") return answer;
      // Why the note was put from here instead: a short code from the object, never the path.
      log("workspace_object_create_not_served", { workspaceId, reason: typeof answer?.reason === "string" ? answer.reason : null });
      return null;
    };
  }

  return wrapped;
}
