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
  ok: v.boolean(),
  etag: v.optional(v.string()),
  reason: v.optional(v.string()),
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

export const checkPageValidator = v.object({
  paused: v.boolean(),
  items: v.array(itemValidator),
  next: v.optional(v.string()),
  done: v.boolean(),
});

export const checkItemValidator = v.object({
  path: v.string(),
  key: v.string(),
  etag: v.string(),
  state: v.string(),
});
