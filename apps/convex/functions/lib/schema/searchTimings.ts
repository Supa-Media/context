import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Where a search was asked from. */
export const searchSurfaceValidator = v.union(
  /** What a person waited for in the app, measured on their device. */
  v.literal("screen"),
  /** The app's palette, measured in the control plane. */
  v.literal("app"),
  /** The search page across every workspace, one row per workspace asked. */
  v.literal("page"),
  /** An AI client's `search_notes` or `search`, measured in the gateway. */
  v.literal("ai"),
);

/** Which index answered, or that nothing did. */
export const searchAnsweredByValidator = v.union(
  v.literal("fast"),
  v.literal("index"),
  v.literal("scan"),
  v.literal("none"),
  v.literal("failed"),
);

/**
 * Who searched, for the search quality log: set on the one quality row per
 * search (the app's `screen` row, an AI client's or Tex's gateway row). Rows
 * without it are timing-only and never counted as quality.
 */
export const searchWhoValidator = v.union(v.literal("app"), v.literal("ai"), v.literal("tex"));

/**
 * One row per search: how long it took and which index answered, so search
 * speed can be watched rather than guessed at (asked for by the owner,
 * 2026-10-07: "make sure that we are able to track the average search
 * latency").
 *
 * METADATA ONLY. Never the query, a path, a title, a snippet or a count of
 * what the workspace holds: a search is the clearest record there is of what
 * somebody is looking for in their own notes, and that is theirs. Kept
 * `SEARCH_TIMING_RETENTION_MS` (`functions/searchTimings.ts`).
 */
export const searchTimingTables = {
  searchTimings: defineTable({
    workspaceId: v.id("workspaces"),
    surface: searchSurfaceValidator,
    /** Absent on `screen` rows: the device does not know which index answered. */
    answeredBy: v.optional(searchAnsweredByValidator),
    /** Whether anything came back, so a slow miss can be told from a slow hit. */
    found: v.boolean(),
    ms: v.number(),
    at: v.number(),
    /**
     * Quality rows only. Opaque: 16 lowercase hex, the first 16 of SHA-256 of
     * `search-actor:<principal>` (the user's id in the app, the grant's or the
     * user's in the gateway). Links a search to the same searcher's next action,
     * in any workspace, and is never shown.
     */
    who: v.optional(searchWhoValidator),
    actor: v.optional(v.string()),
    /**
     * Gateway quality rows only: the results in order, each 16 hex (the first
     * 16 of SHA-256 of `search-hit:<workspaceId>:<noteId or path>`). Cleared by
     * the retention sweep 15 minutes after the search.
     */
    hits: v.optional(v.array(v.string())),
    /** 1-based position of the first result opened. */
    opened: v.optional(v.number()),
    /** The same searcher searched this workspace again within 60 s with nothing opened. */
    again: v.optional(v.boolean()),
  })
    .index("by_at", ["at"])
    .index("by_surface_at", ["surface", "at"])
    .index("by_workspace_at", ["workspaceId", "at"])
    .index("by_workspace_surface_at", ["workspaceId", "surface", "at"])
    .index("by_actor_at", ["actor", "at"]),
};
