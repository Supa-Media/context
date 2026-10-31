/**
 * Moving Tex's existing notes into their person's Durable Object (decided by
 * the owner, 2026-10-31; `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * Run from the `Tex notes into their objects` workflow: first with `dryRun`
 * (counts only, nothing written), then for real, paging with the cursor until
 * `done`. The steps are in `lib/texMigration/run.ts`; the tree's side of them
 * (the rows a page reads, and the key switch) is `texMigrationRows.ts`. This
 * file is the entry point, and the only one of the three that opens a bucket.
 * Internal only, so only the workflow's own deploy key can start it.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import type { FileStore } from "./lib/fileOps/store";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexStore } from "./lib/texStore";
import { migrateTexNotes } from "./lib/texMigration/run";

/** The bucket, as the console opens it for this workspace, with Tex keys routed to the person's object; `null` without a binding. */
async function openWorkspaceStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<FileStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  return storeForBinding(credential, undefined, { managedEncryption, texStore: consoleTexStore(ctx, workspaceId) }) as unknown as FileStore;
}

const countsValidator = v.object({
  workspaces: v.number(),
  rows: v.number(),
  wouldMove: v.number(),
  moved: v.number(),
  alreadyMoved: v.number(),
  swept: v.number(),
  other: v.number(),
  refused: v.record(v.string(), v.number()),
  paths: v.optional(v.array(v.string())),
  cursor: v.string(),
  done: v.boolean(),
});

/**
 * One page of the migration. Counts only, unless `listPaths` is passed (never
 * by the workflow, whose log is public). `dryRun` writes nothing.
 */
export const run = internalAction({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    listPaths: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    /** A handle: move only that person's notes. Unknown or shared, and nothing moves. */
    only: v.optional(v.string()),
  },
  returns: countsValidator,
  handler: async (ctx, args) => {
    const only = args.only === undefined ? undefined : await ctx.runQuery(internal.functions.texMigrationRows.personalWorkspaceBySlug, { slug: args.only });
    if (only === null) {
      return { workspaces: 0, rows: 0, wouldMove: 0, moved: 0, alreadyMoved: 0, swept: 0, other: 0, refused: { NO_WORKSPACE: 1 }, cursor: "", done: true };
    }
    return await migrateTexNotes(ctx, {
      dryRun: args.dryRun,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
      ...(args.listPaths === undefined ? {} : { listPaths: args.listPaths }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(only === undefined ? {} : { only }),
      openStore: (workspaceId) => openWorkspaceStore(ctx, workspaceId),
    });
  },
});
