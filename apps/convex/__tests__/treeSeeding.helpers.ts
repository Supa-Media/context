/**
 * Test-only tree seeding: the rows a finished first copy leaves in the Convex
 * tree, laid down directly from a test's bucket. Production rows come from the
 * product's own writes through the seam (`lib/noteIds/*`), never from a listing,
 * so these helpers are the only place a test writes `nodes` rows by hand.
 * Re-exported from `fixtures.helpers.ts`.
 */

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { convexNodeTable } from "../functions/lib/nodes/convexTable";
import { latestS3Of } from "./storeStub.helpers";
import { copyRowOf } from "../functions/lib/noteIds/state";
import type { TestConvex } from "./fixtures.helpers";

/**
 * Lay the path objects of the workspace's bucket (as the test seeded them) into
 * `nodes`, and mark the tree served. Test-only: production rows come from the
 * product's own writes, never from a listing.
 */
export async function seedTreeFromBucket(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  // Once keyed, the bucket's path objects are frozen copies: laying them again would bring back every note moved
  // or trashed since, so a keyed workspace's rows change only through the product.
  if (await t.run(async (ctx) => (await copyRowOf(ctx.db, workspaceId))?.keyedDoneAt !== undefined)) return;
  const binding = await t.run((ctx) =>
    ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .first(),
  );
  const backend = binding?.bucket === undefined ? null : latestS3Of(binding.bucket);
  if (backend === null) await seedTreeRows(t, workspaceId, []);
  else await seedTreeFromStore(t, workspaceId, backend);
}

/**
 * `seedTreeRows` for a test bucket. Access comes from the rows and the rules a
 * test seeds (`translateBucketRules`), never from a `privacy.md` in the bucket.
 */
export async function seedTreeFromStore(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  store: { objects: Map<string, { etag: string; bytes: Uint8Array }> },
): Promise<void> {
  await seedTreeRows(t, workspaceId, pathObjectsOf(store));
}

/** A note's or file's id key (`notes/<id>.md`, `files/<id>.<ext>`): the bytes a row names, never a name of its own. */
const ID_KEY = /^(notes|files)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^/]*)?$/;

/**
 * A test bucket's path objects as `seedTreeRows` takes them: top-level dot folders, folder markers and the id keys a
 * keyed workspace's rows already name are not rows.
 */
export function pathObjectsOf(store: { objects: Map<string, { etag: string; bytes: Uint8Array }> }): { path: string; etag: string; size: number }[] {
  return [...store.objects.entries()]
    .filter(([key]) => !key.startsWith(".") && !key.endsWith("/") && !ID_KEY.test(key))
    .map(([path, value]) => ({ path, etag: value.etag, size: value.bytes.byteLength }));
}

/**
 * Write `nodes` rows for path objects, with their folders, and the served
 * `nodeTrees` row a finished copy leaves. Test-only: the product writes these
 * rows through its seam (`lib/noteIds/*`), never by listing the bucket.
 */
export async function seedTreeRows(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  objects: readonly (string | { path: string; etag?: string; size?: number; uploaded?: number; noteId?: string })[],
): Promise<void> {
  const rows = objects.map((object) => (typeof object === "string" ? { path: object, etag: object } : object));
  await t.run(async (ctx) => {
    // The seam's own table writes the rows: a folder takes its job and a file its id as the product's writes do.
    const table = convexNodeTable(ctx as MutationCtx, workspaceId);
    const now = Date.now();
    const folders = new Map<string, string>();
    const folderFor = async (path: string): Promise<string | undefined> => {
      if (path === "") return undefined;
      const known = folders.get(path) ?? (await table.byPath(path))?.id;
      if (known !== undefined) {
        folders.set(path, known);
        return known;
      }
      const slash = path.lastIndexOf("/");
      const parentId = await folderFor(slash < 0 ? "" : path.slice(0, slash));
      const id = await table.insert({
        path,
        parentId,
        name: slash < 0 ? path : path.slice(slash + 1),
        kind: "folder",
        observedAt: now,
      });
      folders.set(path, id);
      return id;
    };
    let files = 0;
    for (const object of rows) {
      // A folder marker (`1-projects/`) is a folder row, never a file.
      if (object.path.endsWith("/")) {
        await folderFor(object.path.slice(0, -1));
        continue;
      }
      // Laid once: a second call (a test that seeded more notes) adds only the paths the tree does not hold yet.
      if ((await table.byPath(object.path)) !== null) {
        files += 1;
        continue;
      }
      const slash = object.path.lastIndexOf("/");
      const parentId = await folderFor(slash < 0 ? "" : object.path.slice(0, slash));
      await table.insert({
        path: object.path,
        parentId,
        name: slash < 0 ? object.path : object.path.slice(slash + 1),
        kind: "file",
        etag: object.etag,
        size: object.size,
        uploaded: object.uploaded,
        ...(object.noteId === undefined ? {} : { noteId: object.noteId }),
        observedAt: now,
      });
      // The change log hears of a new file as the seam's own write does (`convexTable.ts` `logChange`).
      await table.logChange?.(object.path, false);
      files += 1;
    }
    const tree = await ctx.db
      .query("nodeTrees")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const served = { status: "ready" as const, dirty: false, files, sweptAt: now };
    if (tree === null) await ctx.db.insert("nodeTrees", { workspaceId, ...served });
    else await ctx.db.patch(tree._id, served);
  });
}
