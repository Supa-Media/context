/**
 * Bounded bucket listing and legacy-layout-aware probes over the storage
 * adapter, plus the storage-layout migration tool. Moved verbatim out of
 * `src/index.js`.
 */

import { legacyStorageKey } from "../../../../packages/shared/src/storageLayout.cjs";
import { migrateStorageLayout, objectExists } from "../storageLayout.js";
import { toolError, toolText } from "../tools/results.js";

/** Pages a single listing may fetch — 1000 keys each, so 100k objects. */
const LIST_PAGE_CAP = 100;

/**
 * Pagination is driven by a customer-configured endpoint, so the loop cannot
 * trust it to terminate — and cannot trust it to say honestly that it has.
 * Three shapes are caught here and reported as themselves: a backend that keeps
 * answering `IsTruncated: true`, one that replays the same continuation token
 * forever (both of which would otherwise spin until the Workers subrequest
 * limit kills the request with an opaque error), and one that reports another
 * page while offering no token to ask for it, which used to end the walk
 * silently and hand back a short list.
 */
function nextListCursor(page, seen) {
  if (!page.truncated) return undefined;
  // Truncated with nowhere to go. `truncated` and `cursor` are read from
  // independent tags in `store/s3.js` — `IsTruncated` from one element,
  // `NextContinuationToken` from another, and nothing checks they agree — so
  // this pair is what a slightly-wrong endpoint produces, not a hypothetical.
  // Folded in with a finished listing (`page.truncated ? page.cursor :
  // undefined` then `if (!cursor) return undefined`) it ended the walk
  // silently, so `listAllKeys` returned a SHORT key set that read exactly like
  // a complete one — and `move_folder` and `set_folder_visibility` build their
  // key sets from it. Refused as itself, like the two shapes below.
  if (!page.cursor) {
    throw new Error("storage listing did not finish and offered no continuation token");
  }
  const cursor = page.cursor;
  if (seen.has(cursor)) {
    throw new Error("storage listing repeated a pagination cursor; refusing to loop");
  }
  seen.add(cursor);
  if (seen.size >= LIST_PAGE_CAP) {
    throw new Error(`storage listing exceeded ${LIST_PAGE_CAP} pages; refusing to loop`);
  }
  return cursor;
}

export async function listAllKeys(store, prefix) {
  const keys = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const o of page.objects) {
      keys.push({ key: o.key, size: o.size, uploaded: o.uploaded, etag: o.etag });
    }
    cursor = nextListCursor(page, seen);
  } while (cursor);
  return keys;
}

/** List current plumbing plus its pre-v1 location, presenting both as v1 keys. */
export async function listAllKeysWithLegacy(store, prefix) {
  const current = await listAllKeys(store, prefix);
  const legacyPrefix = legacyStorageKey(prefix);
  if (!legacyPrefix) return current;
  const legacy = await listAllKeys(store, legacyPrefix);
  const byKey = new Map(current.map((object) => [object.key, object]));
  for (const object of legacy) {
    const key = `${prefix}${object.key.slice(legacyPrefix.length)}`;
    if (!byKey.has(key)) byKey.set(key, { ...object, key });
  }
  return [...byKey.values()];
}

export async function toolMigrateStorageLayout(store, scope, args) {
  if (scope !== "private") return toolError("unknown tool: migrate_storage_layout");
  const result = await migrateStorageLayout(store, {
    batchSize: args.batch_size,
    cleanup: args.cleanup === true,
  });
  if (result.error) return toolError(result.error);
  return toolText(
    [
      `storage layout migration: ${result.state}`,
      `copied: ${result.objectsCopied}`,
      `already verified: ${result.objectsVerified}`,
      `legacy objects deleted: ${result.objectsDeleted}`,
      `conflicts: ${result.conflicts.length}`,
    ].join("\n"),
  );
}

export async function listImmediateLayout(store, prefix = "") {
  const objects = [];
  const prefixes = new Set();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await store.list({
      prefix: prefix || undefined,
      delimiter: "/",
      cursor,
      limit: 1000,
    });
    for (const object of page.objects || []) {
      const remainder = object.key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      if (slash === -1) objects.push(object);
      else prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`); // test-stub fallback
    }
    for (const childPrefix of page.delimitedPrefixes || []) prefixes.add(childPrefix);
    cursor = nextListCursor(page, seenCursors);
  } while (cursor);
  return {
    objects,
    prefixes: [...prefixes].filter((childPrefix) => {
      const remainder = childPrefix.slice(prefix.length);
      return remainder && !remainder.startsWith(".");
    }),
  };
}

/**
 * Existence, by metadata, with the same legacy fallback a read would follow.
 *
 * Returns a sentinel rather than an object: callers of `getVisibleMovedNote`
 * only ever ask whether the thing is there, and handing back something that
 * looks like a note but has no body is how a caller ends up reading `undefined`
 * into a customer's bucket.
 */
const PRESENT = Object.freeze({ present: true });
export async function probeWithLegacyFallback(store, key) {
  if (await objectExists(store, key, { metadataOnly: true })) return PRESENT;
  const legacy = legacyStorageKey(key);
  if (legacy && (await objectExists(store, legacy, { metadataOnly: true }))) return PRESENT;
  return null;
}

/**
 * List note keys under one folder, spending at most `pageCap` pages.
 *
 * `listAllKeys` throws rather than truncate, which is right for a search or a
 * move — a partial answer there is a wrong answer. That sentence was false for
 * one shape until `nextListCursor` was fixed: a page reporting `truncated` with
 * no continuation token ended the walk silently and returned a short list.
 * Orientation is the opposite case: a context too large to walk still has a
 * shape worth describing, so this stops early and *says so*, and every caller
 * has to carry the `truncated` flag into what it prints — including for that
 * same shape, which used to leave `truncated` false and print a floor as a
 * total.
 */
export async function listBoundedKeys(store, prefix, pageCap) {
  const keys = [];
  const seen = new Set();
  let truncated = false;
  let cursor;
  let pages = 0;
  do {
    const page = await store.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const object of page.objects || []) {
      keys.push({ key: object.key, uploaded: object.uploaded });
    }
    pages += 1;
    if (page.truncated && !page.cursor) {
      // Another page promised and no way to ask for it. This one reports rather
      // than throws, because that is what orientation is for.
      truncated = true;
      cursor = undefined;
      break;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && pages >= pageCap) {
      truncated = true;
      cursor = undefined;
    } else if (cursor) {
      if (seen.has(cursor)) {
        throw new Error("storage listing repeated a pagination cursor; refusing to loop");
      }
      seen.add(cursor);
    }
  } while (cursor);
  return { keys, truncated };
}

export async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}
