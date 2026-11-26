import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The Lab's Evals (Dev2, 2026-11-20: "create an evals tab one of them being the LongMemEval"; `functions/labEvals.ts`,
 * `docs/decisions/testing/lab-evals.md`). A run is one public benchmark over a slice of its questions, run on GitHub
 * (`.github/workflows/lab-eval-run.yml`) against a throwaway bench world per question. Public data only: a row holds
 * the benchmark's own question and answer, the reader's reply and the judge's verdict, never anyone's notes. Never a
 * Training, Dev or Test set conversation, and nothing here gates CI.
 */
export const labEvalTables = {
  labEvalRuns: defineTable({
    bench: v.string(),
    /** How many questions the slice holds (the same n is the same slice every time). */
    n: v.number(),
    models: v.union(v.literal("gw"), v.literal("cc")),
    /**
     * Whose Anthropic key the run asked to pay first: an alias from `packages/tex/src/aiKeys.json` (Dev2, 2026-11-26:
     * "need to be able to choose whose we are using"). Unset uses that file's list for the run's use.
     */
    key: v.optional(v.string()),
    /** `#<pull request>` or a branch; unset is main. */
    code: v.optional(v.string()),
    /** The commit the workflow checked out and ran. */
    commit: v.optional(v.string()),
    stage: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
    ghRunUrl: v.optional(v.string()),
    by: v.id("users"),
    /** "lab" for the Lab page, or the AI client's name. */
    via: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    /**
     * The scores, costs and settings the run reported at its end (`bench/evals/cli.mjs` result, rows apart), cleaned by
     * `cleanSummary`. A Search suite run keeps its `search` block (`cleanSearch`); a Claude Code run its `cc`. Both are
     * optional, so a row reported before either existed stays valid. Stored as v.any, like the rows: the cleaners in
     * `functions/labEvals.ts` are the validator.
     */
    summary: v.optional(v.any()),
    /** How many rows have been reported so far. */
    rows: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_started", ["startedAt"])
    .index("by_by", ["by", "startedAt"]),
  /**
   * One question of a run: its facts, the reader's answer and the verdict (`bench/evals/memoryRun.mjs` row). A Search
   * suite row (`bench/evals/searchSuite.mjs` rowOf) also carries `rank` (the first expected note's rank, or null) and
   * `hits` (how many notes the search answered with); both are optional, and `answer` holds the first hits.
   */
  labEvalRows: defineTable({
    runId: v.id("labEvalRuns"),
    i: v.number(),
    row: v.any(),
  }).index("by_run", ["runId", "i"]),
};
