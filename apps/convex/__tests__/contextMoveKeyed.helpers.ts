import type { Id } from "../_generated/dataModel";
import type { TestConvex } from "./fixtures.helpers";
import type { MemoryS3 } from "./storeStub.helpers";

/** Key every live file row of `workspaceId`: its bytes move to its key, the path keeps a frozen copy. */
export async function keyWorkspace(t: TestConvex, workspaceId: Id<"workspaces">, bucket: MemoryS3): Promise<void> {
  const rows = await t.run(async (ctx) => {
    if ((await ctx.db.query("noteIdLayout").first()) === null) {
      await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    }
    await ctx.db.insert("noteIdCopies", {
      workspaceId,
      status: "done",
      runId: 1,
      files: 0,
      copied: 0,
      failed: 0,
      failures: [],
      updatedAt: 1,
      keyedAt: 1,
    });
    return await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
  });
  for (const row of rows) {
    if (row.kind !== "file" || row.noteId === undefined || row.goneAt !== undefined || row.path === "privacy.md") continue;
    const key = `notes/${row.noteId}.md`;
    const body = bucket.objects.get(row.path)?.body ?? "";
    bucket.seed(key, body);
    bucket.seed(row.path, "FROZEN COPY: never read\n");
    const etag = bucket.objects.get(key)!.etag;
    await t.run((ctx) => ctx.db.patch(row._id, { storageKey: key, etag }));
  }
}
