/**
 * Tell every workspace object whether its workspace holds a data key (`apps/mcp/src/workspaceStore/rows.js`
 * `encryption`), from the key rows themselves.
 *
 * A copy sets this since #2655 (`workspaceObjects.ts`), and turning encryption on sets `keyed`
 * (`encryptionKeys.ts`); a workspace copied before #2655 was never told, so its object answers `null`. A request
 * there can never open its store from the object (`apps/mcp/src/store/objectBinding.js` asks for `none`) and keeps
 * paying the control plane's `/gateway/binding`. The gateway must not fill this in itself: its binding answer reads
 * "no key" and "a key that would not open" the same way (`controlPlane.ts`), and a wrong `none` would serve locked
 * notes. Only the key rows decide. `keyed` sticks at the object, so a run racing an owner turning encryption on
 * never undoes it.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";

export const record = internalAction({
  args: { dryRun: v.boolean() },
  returns: v.object({ checked: v.number(), keyed: v.number(), none: v.number(), unreachable: v.number(), failed: v.number() }),
  handler: async (ctx, { dryRun }) => {
    const counts = { checked: 0, keyed: 0, none: 0, unreachable: 0, failed: 0 };
    const homes = await Promise.all(
      (["dual", "object"] as const).map(async (home) => await ctx.runQuery(internal.functions.workspaceObjectsRows.atHome, { home })),
    );
    for (const workspaceId of homes.flat()) {
      counts.checked += 1;
      const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "workspaceObjectEncryption" });
      if (client === null) {
        counts.unreachable += 1;
        continue;
      }
      try {
        const keyRows = await ctx.runQuery(internal.functions.encryptionKeys.listDataKeyRows, { workspaceId });
        const state = keyRows.length > 0 ? "keyed" : "none";
        counts[state] += 1;
        if (!dryRun) await client.setEncryption(state);
      } catch (error) {
        counts.failed += 1;
        console.warn(JSON.stringify({ event: "workspace_object_encryption_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
      }
    }
    return counts;
  },
});
