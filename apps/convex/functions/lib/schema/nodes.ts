import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The workspace's file tree, in the control plane (decided by the owner,
 * 2026-10-12: "a move to Convex to have a better overall experience").
 *
 * One row per file or folder the bucket holds — names, versions and sizes,
 * **never note text** — plus each workspace's privacy rules, parsed. The
 * bucket stays canonical: these rows are rebuilt from a listing of it
 * (`lib/nodes/sweep.ts`) and kept current by re-checking what each change
 * touched (`lib/nodes/touch.ts`). Phase 1 of the migration is a **shadow**:
 * nothing reads these rows to answer a person yet; a parity check holds the
 * tree they describe equal to the bucket's at every clearance
 * (`lib/nodes/parity.ts`). See `docs/decisions/app-and-console/convex-tree.md`.
 *
 * Who may see a row is never stored on it. It is decided when served, by the
 * same `canSee` over the workspace's rules that every listing applies.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`.
 */
export const nodeTables = {
  /**
   * One file or folder.
   *
   * `path` is the bucket key as the bucket spells it (`1-projects/a.md`; a
   * folder has no trailing slash). `parentId`/`name` are the same fact as a
   * tree, so a folder's children are one indexed read. Top-level dot folders
   * (`.context/`, `.obsidian/`) are never rows, as in the tree table.
   * A folder marker key (`a/`, what an S3 console writes for an empty folder)
   * is its own `file` row named `""` under the folder it marks (`nodeKey`).
   *
   * **Last observation wins.** `observedAt` is when the bucket was seen to
   * hold this row as it is; an observation older than it never overwrites it.
   * `goneAt` marks a key seen gone: a tombstone a slower listing that saw it
   * a moment before it left cannot undo. Tombstones are removed by the next
   * finished sweep that started after them.
   */
  nodes: defineTable({
    workspaceId: v.id("workspaces"),
    path: v.string(),
    parentId: v.optional(v.id("nodes")),
    name: v.string(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    etag: v.optional(v.string()),
    size: v.optional(v.number()),
    uploaded: v.optional(v.number()),
    observedAt: v.number(),
    goneAt: v.optional(v.number()),
    /**
     * What a note's text says about it, read by the facts fill
     * (`lib/nodes/facts.ts`, decided by the owner, 2026-10-13): `props` is its
     * front matter, first heading, first paragraph, inline tags and length as
     * JSON (`propsOf` in `apps/mcp/src/tree/props.js`), what Lists, Boards and
     * the chaos score read. `parsed` is the version it was read at: a row
     * whose `etag` has moved on since is stale, and a reader reads that note
     * again rather than trust it.
     */
    parsed: v.optional(v.string()),
    props: v.optional(v.string()),
    /** The note is sealed (`indexableText` cannot read it): it keeps no props and no links. */
    sealed: v.optional(v.boolean()),
    /**
     * Set on the few notes the chaos score needs more than a key for (a note
     * past the long-note line, or a contact page waiting on review), so the
     * score reads them by index instead of every row's props.
     */
    chaosNote: v.optional(v.boolean()),
  })
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_workspace_chaos", ["workspaceId", "chaosNote"])
    .index("by_parent_name", ["workspaceId", "parentId", "name"])
    .index("by_workspace_observed", ["workspaceId", "observedAt"]),

  /**
   * One workspace's tree bookkeeping: how far a sweep has got, and whether the
   * rows can be trusted. Counts and times, never a path — except `cursor`,
   * the last key a running sweep listed, which is read only by the sweep.
   */
  nodeTrees: defineTable({
    workspaceId: v.id("workspaces"),
    status: v.union(
      v.literal("empty"),
      v.literal("filling"),
      v.literal("ready"),
      v.literal("unsupported"),
    ),
    /** Set while a sweep runs: the last key it listed, `""` before the first. */
    cursor: v.optional(v.string()),
    /** When the running sweep began; rows observed before it and not since are gone. */
    startedAt: v.optional(v.number()),
    /** A pass that ran this recently holds the sweep. */
    leaseAt: v.optional(v.number()),
    sweptAt: v.optional(v.number()),
    /** A change too big to re-check asked for a sweep. */
    dirty: v.boolean(),
    /** Live file rows after the last finished sweep. */
    files: v.number(),
    /** A fixed, path-free label for a failing pass (never a raw storage error). */
    error: v.optional(v.string()),
    /**
     * Notes whose text alone changed (a save in the editor), gathered for a
     * few seconds and then re-checked together (`nodes.queueEdits`), so a
     * typing pause is not a bucket listing each.
     */
    edits: v.optional(v.array(v.string())),
    /** When the gathered `edits` are due to be re-checked; set while a flush is scheduled. */
    editsDueAt: v.optional(v.number()),
    /** The last parity check: how many paths disagreed with the bucket, over every clearance checked. */
    parity: v.optional(
      v.object({
        checkedAt: v.number(),
        clearances: v.number(),
        mismatches: v.number(),
        privacyMatches: v.boolean(),
      }),
    ),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * One workspace's privacy rules, parsed from the `privacy.md` the bucket
   * holds (`etag`). Rules only: the prose around the managed block is note
   * text and is not kept. In phase 1 this is a mirror the parity check
   * compares; phase 3 makes it the authority and writes `privacy.md` from it.
   */
  nodePrivacy: defineTable({
    workspaceId: v.id("workspaces"),
    /** The `privacy.md` version these rules were read from; absent when there is none. */
    etag: v.optional(v.string()),
    /** Set when the file exists but its managed block does not parse. */
    invalid: v.boolean(),
    folders: v.array(v.object({ prefix: v.string(), visibility: v.string() })),
    notes: v.array(v.object({ path: v.string(), visibility: v.string() })),
    observedAt: v.number(),
    /**
     * Phase 3, while these rules are the authority: the bucket version of the
     * last `privacy.md` written from them. A listing that shows another
     * version means the file was edited past us, and it is written again.
     */
    exportedEtag: v.optional(v.string()),
    /** The rules changed and the bucket's `privacy.md` has not been written from them yet. */
    exportOwed: v.optional(v.boolean()),
    /**
     * Phase 3: these rules are only a copy of a `privacy.md` that has since
     * moved, so they are not the authority and the file decides until the
     * next read of it replaces them (`lib/nodes/privacyAuthority.ts`).
     */
    fileAhead: v.optional(v.boolean()),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * The tree's change log (phase 6): one row per change to a file row, in
   * commit order, so the desktop and phone apps catch up on what changed
   * since their last sync instead of walking the whole tree
   * (`lib/nodes/log.ts`, `functions/nodesFeed.ts`).
   *
   * `seq` orders the rows: each append reads the workspace's last row, so two
   * appends conflict and commit one after the other, and a later commit
   * always has the larger `seq`. It starts from the clock (`nextSeq`), so it
   * keeps rising after a purge and names nothing but a time a reader could
   * already see.
   *
   * A row names a path and whether it left. Who may hear of a path that is
   * there is decided when served, by `canSee` over the rules; a path that
   * left cannot be judged by today's rules (a delete forgets the exception
   * that held it back), so `audiences` records who could see it before it
   * left, from the rules as they stood, as `tree_log` does. Never stored on a
   * row of `nodes`. Rows older than `NODE_LOG_RETAIN_MS` are pruned, and they
   * leave with the workspace.
   */
  nodeLog: defineTable({
    workspaceId: v.id("workspaces"),
    seq: v.number(),
    path: v.string(),
    gone: v.boolean(),
    audiences: v.optional(v.array(v.string())),
  }).index("by_workspace_seq", ["workspaceId", "seq"]),

  /**
   * Moves the tree shows already and the bucket has not finished (phase 4).
   *
   * One row per move, oldest first. `from` and `to` are paths as they were
   * named when the move was made, so a move of a whole folder is this one row
   * however many notes it carries: every listing folds the rows' paths
   * through these (`apps/mcp/src/moves/queued.js`), and a scheduled pass
   * copies the objects behind it (`lib/nodes/moveWork.ts`), oldest move first.
   *
   * `preparing` holds the names while `privacy.md` is rewritten for the
   * destination, and nothing draws it yet; `moving` is drawn everywhere. A row
   * is deleted when its last object has moved. `added` is what the move wrote
   * into `privacy.md`, so Undo takes back exactly that.
   */
  moveQueue: defineTable({
    workspaceId: v.id("workspaces"),
    from: v.string(),
    to: v.string(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    state: v.union(v.literal("preparing"), v.literal("moving")),
    /** Who moved it, at what clearance: link rewriting at the end reaches only what they could see. */
    actorUserId: v.optional(v.id("users")),
    scope: v.union(v.literal("private"), v.literal("team")),
    grantedNames: v.array(v.string()),
    /** Objects under `from` when the move was made, and how many have moved since. Counts only. */
    total: v.number(),
    moved: v.number(),
    added: v.object({
      folders: v.array(v.object({ prefix: v.string(), visibility: v.string(), was: v.optional(v.string()) })),
      notes: v.array(v.object({ path: v.string(), visibility: v.string(), was: v.optional(v.string()) })),
    }),
    /** Set by Undo: the move now carries everything back. */
    undone: v.optional(v.boolean()),
    /**
     * A move into the hidden trash (`lib/nodes/trashStart.ts`): `to` is under
     * `.context/trash/`, so every listing drops the note at once. It carries no
     * rules and rewrites no links, as a trash made in one go never did, and a
     * Restore while it is pending turns it around (`undone`).
     */
    trash: v.optional(v.boolean()),
    /** A pass holding this move; another one waits. */
    leaseAt: v.optional(v.number()),
    /** Failed passes in a row, and a fixed, path-free label for the last one. */
    attempts: v.number(),
    lastError: v.optional(v.string()),
    /** The next pass is due at this time (a back-off after a failure). */
    nextAt: v.number(),
    /** Objects a second, smoothed over passes (`moveLag.ts`): what an estimate of the time left divides by. */
    rate: v.optional(v.number()),
    /** When staff were told this move fell behind; a recovery mail follows its finish. */
    lateAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_next", ["nextAt"]),

  /**
   * Which note links to which (decided by the owner, 2026-10-13: the tree's
   * link table moves from the workspace's search database into Convex). A
   * note's links were read at its row's `parsed` version.
   *
   * One row per link a note's text holds, parsed by the same `linkRowsOf` a
   * move's link rewrite runs (`apps/mcp/src/tree/links.js`): `source` is the
   * note's bucket key, `kind` is `path` for a link that names a path (relative
   * links resolved against the note's folder) or `name` for a bare
   * `[[name]]`, resolved only when read. Names of notes, as the `nodes` rows
   * are; **never note text**, and never who may see either end: the map and a
   * move judge that with `canSee` when they read.
   */
  nodeLinks: defineTable({
    workspaceId: v.id("workspaces"),
    source: v.string(),
    kind: v.union(v.literal("path"), v.literal("name")),
    target: v.string(),
  })
    .index("by_workspace_source", ["workspaceId", "source"])
    .index("by_workspace_target", ["workspaceId", "target", "kind"]),

  /**
   * How far the facts fill (links and front matter) has followed the tree. A
   * first fill walks every note (`after` is the last key it reached,
   * `startSeq` the change log's position when it began); after that, `seq` is
   * the last change-log row whose note has been read. Positions, never text.
   */
  nodeFactState: defineTable({
    workspaceId: v.id("workspaces"),
    ready: v.boolean(),
    seq: v.number(),
    after: v.optional(v.string()),
    startSeq: v.optional(v.number()),
    /** A pass that ran this recently holds the fill. */
    leaseAt: v.optional(v.number()),
    /** Notes whose read failed, tried again by the next pass and counted as unparsed until then. */
    retry: v.optional(v.array(v.string())),
    /** Why most of them failed, a `readFailure.js` word: what admin says. */
    retryKind: v.optional(v.string()),
    /** Passes in a row that read and still failed some, so a hiccup is told from a note that never reads. */
    retryPasses: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * The chaos score's closing number each day, for both audiences, so the
   * app and `orient` can say what it was a week ago (moved from the search
   * database's `chaos_daily` with the facts, 2026-10-13). Numbers only.
   */
  nodeChaosDays: defineTable({
    workspaceId: v.id("workspaces"),
    /** `YYYY-MM-DD`, UTC. */
    day: v.string(),
    all: v.number(),
    team: v.number(),
  }).index("by_workspace_day", ["workspaceId", "day"]),

  /**
   * The migration's one switch, a single row (absent means running). Staff
   * pause it from admin › Search › Indexes; while paused nothing new starts,
   * changes only mark trees dirty, and a running sweep stops at its next pass.
   */
  nodeMigration: defineTable({
    paused: v.boolean(),
    /**
     * Phase 3: the rules in `nodePrivacy` are the authority, and `privacy.md`
     * is written from them (`lib/nodes/privacyAuthority.ts`). Absent or false:
     * the file is, and the rules follow it.
     */
    privacyAuthority: v.optional(v.boolean()),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  }),
};
