import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * A workspace's small stored data, held in the control plane (decided by the
 * owner, 2026-10-14, "Names only"): the icons people gave folders and notes,
 * the names of the workspace's own emoji, and the forwarding ledger a moved
 * note's old path follows to its new one.
 *
 * Each was a file in the bucket (`.context/folder-icons.json`, the
 * `emoji-<name>` objects in the image store, `.context/forwarding.json`) and
 * every reader read it there. Now every reader on a request path reads these
 * rows, and the files are **written, never read back**: each change here is
 * rendered into its file in the same format (`lib/smallData/sync.ts`), so an
 * export, a hand-off or a revoked credential still leaves the customer
 * holding all three. An emoji's picture is still its object in the bucket;
 * only its name and the leaf it is stored under are here.
 *
 * Names and paths only, never note text. Who may see a row is decided when
 * served, by `canSee` over the workspace's rules, and never stored on it.
 * See `docs/decisions/app-and-console/convex-small-data.md`.
 */
export const smallDataTables = {
  /**
   * One icon, keyed by the folder's or the note's path. `icon` is one emoji
   * or a workspace emoji's `:name:` (`folderIcons.cjs`). `null` is a removal
   * made before the workspace's file was imported: the import skips a path
   * that has a row, so a removed icon does not come back from the file. The
   * import deletes them once it has run.
   */
  folderIcons: defineTable({
    workspaceId: v.id("workspaces"),
    path: v.string(),
    icon: v.union(v.string(), v.null()),
  }).index("by_workspace_path", ["workspaceId", "path"]),

  /**
   * One of the workspace's own emoji: its name and the image-store leaf its
   * picture is under (`emoji-<name>.<ext>`). The picture never comes here.
   */
  customEmoji: defineTable({
    workspaceId: v.id("workspaces"),
    name: v.string(),
    leaf: v.string(),
  }).index("by_workspace_name", ["workspaceId", "name"]),

  /**
   * One forwarding address (`apps/mcp/src/forwarding.js`): a note or a whole
   * folder that moved from `from` to `to`. `seq` is the ledger's order, oldest
   * first, which the engine's "newest wins" and its cap read; `at` is when the
   * move was recorded.
   */
  forwardingEntries: defineTable({
    workspaceId: v.id("workspaces"),
    seq: v.number(),
    from: v.string(),
    to: v.string(),
    kind: v.union(v.literal("note"), v.literal("folder")),
    at: v.number(),
  }).index("by_workspace_seq", ["workspaceId", "seq"]),

  /**
   * Where each workspace's small data stands. `importedAt` is when its bucket
   * files were read in (once; until then readers answer from what is here,
   * never from the bucket). Each version moves with every change to its rows,
   * and the file is owed a write while its `…Exported` is behind it; `syncAt`
   * is a lease, so one import-and-export runs at a time.
   */
  smallDataState: defineTable({
    workspaceId: v.id("workspaces"),
    importedAt: v.optional(v.number()),
    forwardingVersion: v.number(),
    forwardingExported: v.number(),
    iconsVersion: v.number(),
    iconsExported: v.number(),
    syncAt: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),
};
