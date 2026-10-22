/**
 * What a stuck rename of a built-in folder left behind (`folderNumbers.ts`):
 * for each workspace on one page, the chunked moves still recorded and the
 * numbered folders still at the top. Printed by the `Folder names without
 * numbers` workflow in a public repository, so it answers built-in names
 * (`0-inbox`, `inbox`, …), counts and ages only: a workspace is its place on
 * the page, and a move or folder under any other name is just counted.
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { folderRole, plainFolderName } from "@context/shared/src/folderRoles.cjs";

/** Rows read under one numbered folder: past the biggest Inbox, a bound on the query. */
const SCAN = 12_000;
/** Workspaces one page reads. */
const PAGE = 25;

const builtIn = (path: string): string | null => (!path.includes("/") && folderRole(path) !== null ? path : null);

const moveValidator = v.object({
  from: v.union(v.string(), v.null()),
  to: v.union(v.string(), v.null()),
  trash: v.boolean(),
  state: v.string(),
  pass: v.number(),
  moved: v.number(),
  left: v.number(),
  /** Whether it waits for the rules to be carried again (file mode). */
  privacyEtag: v.boolean(),
  idleMinutes: v.number(),
});

const folderValidator = v.object({
  name: v.string(),
  role: v.union(v.string(), v.null()),
  plainTaken: v.boolean(),
  plainRole: v.union(v.string(), v.null()),
  files: v.number(),
  unkeyedFiles: v.number(),
  folders: v.number(),
  scanCapped: v.boolean(),
});

export const page = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    workspaces: v.array(v.object({ at: v.number(), moves: v.array(moveValidator), otherMoves: v.number(), numbered: v.array(folderValidator) })),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const result = await ctx.db.query("workspaces").paginate({ cursor: cursor ?? null, numItems: PAGE });
    const workspaces = [];
    for (const [at, workspace] of result.page.entries()) {
      const workspaceId = workspace._id;
      const moves = [];
      let otherMoves = 0;
      for (const move of await ctx.db.query("rowMoves").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).take(50)) {
        const from = builtIn(move.from);
        const to = builtIn(move.to);
        if (from === null && to === null) {
          otherMoves += 1;
          continue;
        }
        moves.push({
          from,
          to,
          trash: move.trash,
          state: move.state,
          pass: move.pass,
          moved: move.moved,
          left: move.left,
          privacyEtag: move.privacyEtag !== null,
          idleMinutes: Math.round((now - move.updatedAt) / 60_000),
        });
      }
      const roots = (
        await ctx.db
          .query("nodes")
          .withIndex("by_parent_name", (q) => q.eq("workspaceId", workspaceId).eq("parentId", undefined))
          .take(2_000)
      ).filter((row) => row.goneAt === undefined);
      const numbered = [];
      for (const row of roots) {
        if (row.kind !== "folder") continue;
        const plain = plainFolderName(row.name);
        if (plain === null) continue;
        const twin = roots.find((other) => other._id !== row._id && other.name.toLowerCase() === plain.toLowerCase());
        let files = 0;
        let unkeyedFiles = 0;
        let folders = 0;
        let scanned = 0;
        let scanCapped = false;
        const prefix = `${row.path}/`;
        for await (const below of ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).gt("path", prefix))) {
          if (!below.path.startsWith(prefix)) break;
          if (scanned >= SCAN) {
            scanCapped = true;
            break;
          }
          scanned += 1;
          if (below.goneAt !== undefined) continue;
          if (below.kind === "folder") folders += 1;
          else {
            files += 1;
            if (below.storageKey === undefined) unkeyedFiles += 1;
          }
        }
        numbered.push({
          name: row.name,
          role: row.role ?? null,
          plainTaken: twin !== undefined,
          plainRole: twin?.role ?? null,
          files,
          unkeyedFiles,
          folders,
          scanCapped,
        });
      }
      if (moves.length > 0 || otherMoves > 0 || numbered.length > 0) workspaces.push({ at, moves, otherMoves, numbered });
    }
    return { workspaces, cursor: result.continueCursor, done: result.isDone };
  },
});
