import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The Tex Architecture Lab's saved versions and case edits (tex.lc/lab;
 * Dev2, 2026-11-13). Staff design and compare Tex's architecture here: a
 * version is a graph of steps, wires and context-module edits, never a note
 * and never anyone's data. Case edits change the bench's own test cases, which
 * are public in the repo. Shared by every staff member, read and written only
 * through `functions/texLab.ts` behind `requireAdmin`.
 */
export const texLabTables = {
  texLabVersions: defineTable({
    /** The Lab's own id for the version (`v<base36 time>`), stable across saves. */
    versionId: v.string(),
    name: v.string(),
    /** The staff member who made it. */
    authorId: v.optional(v.id("users")),
    /** The version's graph, picks, areas and run results, as the Lab's JSON. */
    graph: v.string(),
    picks: v.string(),
    areas: v.optional(v.string()),
    results: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
    /**
     * Promote (Dev2, 2026-11-13: the Lab's config is "the only source of truth"): a staff member asked for this
     * version to become Tex's config; the Lab promote workflow opens the pull request that changes
     * `packages/shared/src/texConfig.json` and records its address here.
     */
    promote: v.optional(v.object({ state: v.union(v.literal("asked"), v.literal("opened"), v.literal("refused")), by: v.id("users"), at: v.number(), pr: v.optional(v.string()), why: v.optional(v.string()) })),
    /**
     * Live drafts (Dev2, 2026-11-15: an AI over the MCP's `tex_dev` and a person in the Lab edit one draft together;
     * `functions/texLabDrafts.ts`): the revision, raised by every save and every batch of edits, and the AI client
     * last in it. A version saved before has neither and reads as revision 0.
     */
    rev: v.optional(v.number()),
    live: v.optional(v.object({ client: v.string(), by: v.id("users"), at: v.number() })),
  }).index("by_version", ["versionId"]),
  /**
   * What each revision of a draft changed, for the other side to read: the pieces it touched (`texLabOps.cjs`
   * `keysOf`), one plain line per edit, who and through what. Kept for the draft's life and deleted with it; the
   * graph itself is only on the version row.
   */
  texLabChanges: defineTable({
    versionId: v.string(),
    rev: v.number(),
    by: v.id("users"),
    /** "lab" for the Lab page, or the AI client's name. */
    via: v.string(),
    keys: v.array(v.string()),
    said: v.array(v.string()),
    /** The same lines uncut (each up to 1,000 characters), for `tex_dev`'s `changes`; `said` is the Lab's short form. */
    full: v.optional(v.array(v.string())),
    /**
     * What undoes this change, as JSON (`lib/texLabDraftWrites.ts` `Undo`): the edits back to the graph before it, and
     * the name, test picks and run areas it replaced. `tex_dev`'s `revert` applies it as a new revision. A change
     * made before undo was kept, or one nothing undoes (asking to promote, keeping run results), has none.
     */
    undo: v.optional(v.string()),
    at: v.number(),
  }).index("by_version_rev", ["versionId", "rev"]),
  texLabCaseEdits: defineTable({
    /** `<area>/<case id>`. */
    key: v.string(),
    /** The edited case, as the Lab's JSON. */
    data: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
};
