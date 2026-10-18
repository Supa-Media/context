/** The argument and return validators the id copy's functions share (`functions/noteIdsCopy.ts`). */

import { v } from "convex/values";

/** One file a page copies or checks: its path, its id key, and the etag the row had when the page was handed out. */
export const itemValidator = v.object({
  path: v.string(),
  key: v.string(),
  etag: v.string(),
  size: v.optional(v.number()),
});

export const copyResultValidator = v.object({
  path: v.string(),
  /** The key the page was handed for this path: a row whose id changed since does not take the copy (`copyRecord.ts`). */
  key: v.optional(v.string()),
  ok: v.boolean(),
  etag: v.optional(v.string()),
  keyEtag: v.optional(v.string()),
  reason: v.optional(v.string()),
  /** For `changed`: the bucket's current version of the path, which the record may refresh the row to. */
  currentEtag: v.optional(v.string()),
  currentSize: v.optional(v.number()),
});

export const refusedValidator = v.object({ noteId: v.string(), reason: v.string() });

export const copyPageValidator = v.object({
  items: v.array(itemValidator),
  refused: v.array(refusedValidator),
  files: v.number(),
  fresh: v.number(),
  unidentified: v.number(),
  next: v.optional(v.string()),
  done: v.boolean(),
});

/** A keyed row the diagnosis checks: its path, its key, and the etag the row had when it was read. */
export const keyedItemValidator = v.object({ path: v.string(), key: v.string(), etag: v.string() });

export const checkPageValidator = v.object({
  paused: v.boolean(),
  items: v.array(itemValidator),
  keyed: v.array(keyedItemValidator),
  next: v.optional(v.string()),
  done: v.boolean(),
});

export const checkItemValidator = v.object({
  path: v.string(),
  key: v.string(),
  etag: v.string(),
  state: v.string(),
});

/** What the bucket says about a keyed row's key: its HEAD now, or no `headEtag` when the key is absent. */
export const keyedCheckItemValidator = v.object({
  path: v.string(),
  key: v.string(),
  etag: v.string(),
  headEtag: v.optional(v.string()),
  headSize: v.optional(v.number()),
});
