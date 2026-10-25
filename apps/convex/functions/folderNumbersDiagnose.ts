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
import {
  MAIN_ROLES,
  folderRole,
  plainFolderName,
} from "@context/shared/src/folderRoles.cjs";
import type { Doc, Id } from "../_generated/dataModel";
import { TRASH_ROOT } from "./lib/fileOps/store";
import type { DatabaseReader } from "../_generated/server";
import { located, nodeAt, nodePaths } from "./lib/nodes/paths";

/** Rows read under one numbered folder: past the biggest Inbox, a bound on the query. */
const SCAN = 12_000;
/** Rows shown for one job, oldest first: gone and trashed ones keep the job, so a few is not enough. */
const JOB_ROWS_SHOWN = 12;
/** Workspaces one page reads. */
const PAGE = 25;

const builtIn = (path: string): string | null =>
  !path.includes("/") && folderRole(path) !== null ? path : null;

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
  /** The first few unkeyed files: what they are, without a name (`unkeyedShape`). */
  unkeyedWhere: v.array(
    v.object({
      depth: v.number(),
      /** The Inbox channel folder it sits in, when its first folder is one; "other" for a folder of the person's own; null at the top. */
      channel: v.union(v.string(), v.null()),
      ext: v.string(),
      etag: v.boolean(),
      noteId: v.boolean(),
      observedDaysAgo: v.number(),
    }),
  ),
  folders: v.number(),
  scanCapped: v.boolean(),
});

/** The Inbox's own channel folders, the only folder names an unkeyed file's description may print. */
const CHANNELS = new Set(["calendar", "contacts", "email", "forms", "google-chat", "imessage", "meetings", "memories", "sessions"]);
const UNKEYED_SHOWN = 5;

/** An unkeyed file described by its shape only: this is printed in a public job log. */
function unkeyedShape(path: string, prefix: string, row: Doc<"nodes">, now: number) {
  const rest = path.slice(prefix.length).split("/");
  const first = rest.length > 1 ? rest[0].toLowerCase().replace(/\s+/g, "-") : null;
  const dot = rest[rest.length - 1].lastIndexOf(".");
  const ext = dot < 0 ? "" : rest[rest.length - 1].slice(dot + 1).toLowerCase();
  return {
    depth: rest.length,
    channel: first === null ? null : CHANNELS.has(first) ? first : "other",
    ext: /^[a-z0-9]{1,8}$/.test(ext) ? ext : "?",
    etag: row.etag !== undefined,
    noteId: row.noteId !== undefined,
    observedDaysAgo: Math.floor((now - row.observedAt) / 86_400_000),
  };
}

const jobValidator = v.object({
  role: v.string(),
  /** The row's name when it is a built-in name, else null. */
  name: v.union(v.string(), v.null()),
  depth: v.number(),
  atRoot: v.boolean(),
  gone: v.boolean(),
  /** Under the trash: no longer doing its job, though the row keeps it. */
  trashed: v.boolean(),
  /** The parent's role, or null (no parent, or one doing no job). */
  parentRole: v.union(v.string(), v.null()),
  files: v.number(),
});

const plainValidator = v.object({
  path: v.string(),
  kind: v.string(),
  role: v.union(v.string(), v.null()),
  gone: v.boolean(),
  /** Whether the row says it has no parent, as a top-level row must. */
  noParent: v.boolean(),
});

async function filesUnder(
  db: DatabaseReader,
  workspaceId: Id<"workspaces">,
  path: string,
): Promise<{
  files: number;
  unkeyed: number;
  unkeyedWhere: ReturnType<typeof unkeyedShape>[];
  folders: number;
  capped: boolean;
}> {
  let files = 0;
  let unkeyed = 0;
  const unkeyedWhere: ReturnType<typeof unkeyedShape>[] = [];
  const now = Date.now();
  let folders = 0;
  let scanned = 0;
  const prefix = `${path}/`;
  const whole = await (
    await nodePaths(db, workspaceId)
  ).below(path, (below) => {
    if (scanned >= SCAN) return false;
    scanned += 1;
    if (below.goneAt !== undefined) return;
    if (below.kind === "folder") folders += 1;
    else {
      files += 1;
      if (below.storageKey === undefined) {
        unkeyed += 1;
        if (unkeyedWhere.length < UNKEYED_SHOWN) unkeyedWhere.push(unkeyedShape(below.path, prefix, below, now));
      }
    }
  });
  return { files, unkeyed, unkeyedWhere, folders, capped: !whole };
}

async function jobsOf(db: DatabaseReader, workspaceId: Id<"workspaces">) {
  const jobs = [];
  for (const role of [...MAIN_ROLES, "meetings", "website", "tex"]) {
    const rows: Doc<"nodes">[] = await db
      .query("nodes")
      .withIndex("by_workspace_role", (q) =>
        q.eq("workspaceId", workspaceId).eq("role", role),
      )
      .take(JOB_ROWS_SHOWN);
    for (const found of rows) {
      const row = await located(db, found);
      if (row === null) continue;
      const parent =
        row.parentId === undefined ? null : await db.get(row.parentId);
      jobs.push({
        role,
        name: folderRole(row.name) !== null ? row.name : null,
        depth: row.path.split("/").length,
        atRoot: row.parentId === undefined,
        gone: row.goneAt !== undefined,
        trashed: row.path.startsWith(`${TRASH_ROOT}/`),
        parentRole: parent?.role ?? null,
        files: (await filesUnder(db, workspaceId, row.path)).files,
      });
    }
  }
  return jobs;
}

async function plainRowsOf(db: DatabaseReader, workspaceId: Id<"workspaces">) {
  const rows = [];
  for (const path of MAIN_ROLES as readonly string[]) {
    const row = await nodeAt(db, workspaceId, path);
    if (row === null) continue;
    rows.push({
      path,
      kind: row.kind,
      role: row.role ?? null,
      gone: row.goneAt !== undefined,
      noParent: row.parentId === undefined,
    });
  }
  return rows;
}

export const page = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    workspaces: v.array(
      v.object({
        at: v.number(),
        moves: v.array(moveValidator),
        otherMoves: v.number(),
        numbered: v.array(folderValidator),
        jobs: v.array(jobValidator),
        plain: v.array(plainValidator),
      }),
    ),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const result = await ctx.db
      .query("workspaces")
      .paginate({ cursor: cursor ?? null, numItems: PAGE });
    const workspaces = [];
    for (const [at, workspace] of result.page.entries()) {
      const workspaceId = workspace._id;
      const moves = [];
      let otherMoves = 0;
      for (const move of await ctx.db
        .query("rowMoves")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(50)) {
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
          .withIndex("by_parent_name", (q) =>
            q.eq("workspaceId", workspaceId).eq("parentId", undefined),
          )
          .take(2_000)
      ).filter((row) => row.goneAt === undefined);
      const numbered = [];
      for (const row of roots) {
        if (row.kind !== "folder") continue;
        const plain = plainFolderName(row.name);
        if (plain === null) continue;
        const twin = roots.find(
          (other) =>
            other._id !== row._id &&
            other.name.toLowerCase() === plain.toLowerCase(),
        );
        // A top-level row's path is its name.
        const under = await filesUnder(ctx.db, workspaceId, row.name);
        numbered.push({
          name: row.name,
          role: row.role ?? null,
          plainTaken: twin !== undefined,
          plainRole: twin?.role ?? null,
          files: under.files,
          unkeyedFiles: under.unkeyed,
          unkeyedWhere: under.unkeyedWhere,
          folders: under.folders,
          scanCapped: under.capped,
        });
      }
      if (moves.length > 0 || otherMoves > 0 || numbered.length > 0) {
        workspaces.push({
          at,
          moves,
          otherMoves,
          numbered,
          jobs: await jobsOf(ctx.db, workspaceId),
          plain: await plainRowsOf(ctx.db, workspaceId),
        });
      }
    }
    return { workspaces, cursor: result.continueCursor, done: result.isDone };
  },
});
