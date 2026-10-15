/**
 * One page of the move from path keys to id keys, run next to the bucket.
 *
 * A note's body used to live at its path (`1-projects/foo.md`). Moving it to
 * `notes/<noteId>.md` (and attachments to `files/<noteId><.ext>`) is a copy
 * inside one bucket, so the bytes never leave it: the control plane plans the
 * pages and hands each one here, as the encryption walk does, and this copies
 * the objects it was given and reports what happened to each.
 *
 * The store is the bare adapter (`sealedObjects`). A managed bucket's bodies
 * are sealed at rest, and the copy must move the sealed bytes as they are, the
 * same way the encryption walk reads them; a plain read would decrypt nothing
 * and re-encrypting here would be a second key path. The source is never
 * deleted here. Retiring a path key is the control plane's decision, taken
 * only after `runIdCheckPage` reports the destination as the same object.
 *
 * Every item is settled on its own. A failure is a reason for that one path,
 * never a reason to stop the page: the control plane retries the reasons it
 * knows and shows the rest. Reasons name a fixed code only; raw provider text
 * and paths never reach a log, since a path can be a note's title.
 */

import { storeForBinding } from "../store/factory.js";
import { settleInPool } from "./pool.js";

/** Attachments above this are left in place and reported, never read into memory. */
export const ID_COPY_MAX_BYTES = 20 * 1024 * 1024;

/**
 * @param {{
 *   kind: "idCopy",
 *   workspaceId: string,
 *   source: object,
 *   items: { path: string, key: string, etag: string, size?: number }[],
 *   limits: { lanes: number, byteBudget: number },
 * }} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps] seam for tests
 * @returns {Promise<{ results: object[] }>}
 */
export async function runIdCopyPage(page, { buildStore = storeForBinding } = {}) {
  // The bare adapter: sealed bytes are copied as they are (see the header).
  const store = buildStore(page.source, undefined, { sealedObjects: true });
  const results = new Array(page.items.length);
  await settleInPool(
    page.items.map((item, index) => ({ item, index })),
    { lanes: page.limits.lanes, byteBudget: page.limits.byteBudget, sizeOf: ({ item }) => item.size ?? 0 },
    async ({ item, index }) => {
      results[index] = await copyOne(store, item);
    },
  );
  const reasons = {};
  for (const result of results) {
    if (!result.ok) reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
  }
  if (Object.keys(reasons).length > 0) {
    console.error("mover.id_copy_skipped", { workspaceId: page.workspaceId, reasons });
  }
  return { results };
}

/** Never throws: a failure is this item's result, so the pool keeps going. */
async function copyOne(store, item) {
  try {
    if (typeof item.size === "number" && item.size > ID_COPY_MAX_BYTES) {
      return { path: item.path, ok: false, reason: "too_large" };
    }
    let copiedEtag;
    if (typeof store.copy === "function" && store.capabilities?.serverSideCopy === "same-store") {
      const copied = await store.copy(item.path, item.key, { sourceOnlyIf: { etagMatches: item.etag } });
      if (copied === null || copied === undefined) return { path: item.path, ok: false, reason: "changed" };
      copiedEtag = copied.etag ?? null;
    } else {
      const object = await store.get(item.path);
      if (object === null || object === undefined) return { path: item.path, ok: false, reason: "missing" };
      if (object.etag !== item.etag) return { path: item.path, ok: false, reason: "changed" };
      const written = await store.put(item.key, await object.arrayBuffer(), { contentType: object.contentType });
      if (written === null || written === undefined) return { path: item.path, ok: false, reason: "copy_failed" };
      copiedEtag = written.etag ?? null;
    }
    const landed = await metadataOf(store, item.key);
    if (landed === null || (typeof item.size === "number" && landed.size !== item.size)) {
      return { path: item.path, ok: false, reason: "verify_failed" };
    }
    return { path: item.path, ok: true, etag: item.etag, copiedEtag };
  } catch {
    return { path: item.path, ok: false, reason: "copy_failed" };
  }
}

/**
 * Metadata for one key: `head` where the adapter has it, else a read. `null`
 * means the key is absent; a read that cannot say its size reports none, so
 * the size check is skipped rather than guessed.
 */
async function metadataOf(store, key) {
  const head = typeof store.head === "function" ? await store.head(key) : undefined;
  if (head !== undefined) return head;
  const object = await store.get(key);
  if (object === null || object === undefined) return null;
  return { etag: object.etag, size: typeof object.size === "number" ? object.size : undefined };
}

/**
 * Compare each path with its id key, without writing either.
 *
 * `same`: both exist, the sizes agree, and the bytes agree (the etags are
 * compared first, and the bytes read only when they differ). `missing`: the
 * id key is absent. `source_missing`: the path is gone. `differs`: anything
 * else. A thrown error fails the whole page rather than reporting a state for
 * an object that was never looked at.
 *
 * @param {{ kind: "idCheck", workspaceId: string, source: object, items: { path: string, key: string }[], limits: { lanes: number, byteBudget: number } }} page
 * @param {{ buildStore?: typeof storeForBinding }} [deps]
 * @returns {Promise<{ results: { path: string, state: "same" | "missing" | "source_missing" | "differs" }[] }>}
 */
export async function runIdCheckPage(page, { buildStore = storeForBinding } = {}) {
  const store = buildStore(page.source, undefined, { sealedObjects: true });
  const results = new Array(page.items.length);
  await settleInPool(
    page.items.map((item, index) => ({ item, index })),
    { lanes: page.limits.lanes, byteBudget: page.limits.byteBudget, sizeOf: () => 0 },
    async ({ item, index }) => {
      results[index] = { path: item.path, state: await checkOne(store, item) };
    },
  );
  return { results };
}

async function checkOne(store, item) {
  const destination = await metadataOf(store, item.key);
  if (destination === null) return "missing";
  const source = await metadataOf(store, item.path);
  if (source === null) return "source_missing";
  if (source.size !== destination.size) return "differs";
  if (source.etag !== undefined && source.etag === destination.etag) return "same";
  const [left, right] = await Promise.all([store.get(item.path), store.get(item.key)]);
  if (!left || !right) return "differs";
  return buffersEqual(await left.arrayBuffer(), await right.arrayBuffer()) ? "same" : "differs";
}

function buffersEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
