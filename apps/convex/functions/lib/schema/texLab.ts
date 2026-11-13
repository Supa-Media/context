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
  }).index("by_version", ["versionId"]),
  texLabCaseEdits: defineTable({
    /** `<area>/<case id>`. */
    key: v.string(),
    /** The edited case, as the Lab's JSON. */
    data: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
};
