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
    /**
     * The code a draft runs on (Dev2, 2026-11-16: "when we run things it should run on the PRs code instead of main";
     * `functions/texLabRuns.ts` `CODE`): a same-repository pull request (`#3401`) or branch whose steps the draft's
     * graph needs. Unset is main. Every run of the draft checks that code out.
     */
    code: v.optional(v.string()),
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
  /**
   * A draft's graph just before each revision (JSON), so the Lab can mark what that revision changed ("against last
   * rev"). Kept apart from texLabChanges so the change feed, read live, stays small; deleted with the draft.
   */
  texLabRevBefore: defineTable({
    versionId: v.string(),
    rev: v.number(),
    graph: v.string(),
  }).index("by_version_rev", ["versionId", "rev"]),
  texLabCaseEdits: defineTable({
    /** `<area>/<case id>`. */
    key: v.string(),
    /** The edited case, as the Lab's JSON. */
    data: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  /**
   * Lab drafts of Tex's test conversations (Dev2, 2026-11-15; `functions/texSets.ts`): a Training or Dev conversation
   * as a staff member in the Lab's Testing tab, or an AI over the MCP's `tex_dev`, changed it, over the file in
   * `apps/mcp/bench/sets/<set>/<id>.json`. Promote opens the pull request that writes it there. Never the Test Set:
   * its conversations live only in the eval service.
   */
  texSetConvos: defineTable({
    convoId: v.string(),
    set: v.union(v.literal("training"), v.literal("dev")),
    /** The conversation as `packages/shared/src/texSets.cjs` reads it, as JSON. */
    data: v.string(),
    /** A conversation the repo does not have yet. */
    isNew: v.boolean(),
    /** Asked to be deleted from the repo at the next Promote. */
    removed: v.boolean(),
    rev: v.number(),
    by: v.id("users"),
    /** "lab" for the Lab page, or the AI client's name. */
    via: v.string(),
    updatedAt: v.number(),
    /** Promote: asked at a revision, then the pull request it went into (or why it was refused). */
    promote: v.optional(v.object({ state: v.union(v.literal("asked"), v.literal("opened"), v.literal("refused")), by: v.id("users"), at: v.number(), rev: v.number(), pr: v.optional(v.string()), why: v.optional(v.string()) })),
  }).index("by_convo", ["convoId"]),
  /**
   * Lab runs on GitHub (Dev2, 2026-11-16, "go ahead and build everything"; `functions/texLabRuns.ts`): a staff member
   * in the Lab, or an AI over `tex_dev`, asked for a draft (or main) to run on the Dev set's unit tests, and the
   * workflow `.github/workflows/tex-lab-run.yml` ran it and reported back. A "gate" run follows a Promote's pull
   * request and its "Tex test set" status (counts only). Results are counts and ids, plus each unit test's
   * verdict; never the Test set and never a real person's words.
   */
  texLabRuns: defineTable({
    versionId: v.string(),
    kind: v.union(v.literal("dev"), v.literal("chat"), v.literal("node"), v.literal("gate")),
    convId: v.optional(v.string()),
    nodeId: v.optional(v.string()),
    models: v.union(v.literal("gw"), v.literal("cc")),
    stage: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    ghRunUrl: v.optional(v.string()),
    /** A gate run's pull request. */
    pr: v.optional(v.string()),
    /** The code asked for (a draft's `code`, or the run's own): `#<pull request>` or a branch; unset is main. */
    code: v.optional(v.string()),
    /** The commit the workflow checked out and ran, reported back by it: what actually ran. */
    commit: v.optional(v.string()),
    by: v.id("users"),
    /** "lab" for the Lab page, or the AI client's name. */
    via: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    results: v.optional(v.any()),
    error: v.optional(v.string()),
  })
    .index("by_started", ["startedAt"])
    .index("by_version", ["versionId", "startedAt"])
    .index("by_by", ["by", "startedAt"]),
  /**
   * What each revision of a conversation draft changed (`texSetOps.cjs` keys and lines), for the conflict check, and
   * the conversation as that revision left it (`data`), so the Lab's history and `tex_dev` `set_history` can put any
   * earlier revision back (Dev2, 2026-11-16: "make sure we have a change history and the ability to undo").
   */
  texSetChanges: defineTable({
    convoId: v.string(),
    rev: v.number(),
    by: v.id("users"),
    via: v.string(),
    keys: v.array(v.string()),
    said: v.array(v.string()),
    at: v.number(),
    data: v.optional(v.string()),
  }).index("by_convo_rev", ["convoId", "rev"]),
};
