/**
 * The bucket half of emptying the trash (`trash.ts`, `lib/trash/erase.ts`):
 * the only module of the trash that reaches a bucket's credential. Scheduled
 * by `trash.emptyDue` for a keyed workspace owed an erasure.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import type { FileStore } from "./lib/fileOps/store";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { eraseWorkspaceTrash } from "./lib/trash/erase";

export const eraseWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ claimed: v.number(), finished: v.number(), failed: v.number() }),
  handler: async (ctx, { workspaceId }) =>
    await eraseWorkspaceTrash(ctx, workspaceId, async () => {
      const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
      if (credential === null) return null;
      // Sealed history is read in its own mode; a mode whose key cannot be opened fails here, and the erasure waits.
      const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
      return storeForBinding(credential, undefined, { managedEncryption }) as unknown as FileStore;
    }),
});
