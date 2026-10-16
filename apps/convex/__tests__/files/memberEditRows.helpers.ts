/**
 * Rows as the authority for the console's privacy reads, as a test deployment
 * switches it: the access rows answer every reader, and the bucket manifest
 * no longer does. The fixture already holds one `nodePrivacy` row; it is
 * marked as the authority here rather than inserted beside it.
 */

import type { Id } from "../../_generated/dataModel";
import type { Fixture } from "./fixtures.helpers";

export async function rowsAuthority(t: Fixture["t"], workspaceId: Id<"workspaces">): Promise<void> {
  await t.run(async (ctx) => {
    const migration = await ctx.db.query("nodeMigration").first();
    if (migration === null) await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", privacyAuthority: true, updatedAt: 1 });
    else await ctx.db.patch(migration._id, { accessSource: "rows", privacyAuthority: true });
    const privacy = await ctx.db.query("nodePrivacy").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).first();
    if (privacy === null) await ctx.db.insert("nodePrivacy", { workspaceId, etag: "e1", invalid: false, folders: [], notes: [], observedAt: 1 });
    else await ctx.db.patch(privacy._id, { etag: "e1", invalid: false, folders: [], notes: [] });
  });
}

export type { Fixture };
