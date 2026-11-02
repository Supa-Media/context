/**
 * The storage binding a workspace's object keeps, sealed, for the gateway (decided by the owner, 2026-11-02;
 * `docs/decisions/storage-and-credentials/credential-basics.md`, "A binding kept in its workspace's object is sealed
 * to it"; `apps/mcp/src/workspaceStore/bindingRows.js`).
 *
 * The control plane never puts one there and cannot read one: the gateway seals what `/gateway/binding` answered
 * with a key only it derives. What the control plane does is take it away whenever what it is made of changes
 * (`lib/rowWatch/watch.ts` `BINDING_TABLES`). For a workspace judged in its object that rides the push
 * (`workspaceObjectPush.ts`), behind its outbox; for any other, it is this.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { objectDoor } from "./lib/rowWatch/objectDoor";

/** Clear the binding `workspaceId`'s object keeps. A failure is logged: the kept copy also ages out on its own. */
export const clear = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }) => {
    try {
      await objectDoor(ctx, workspaceId)("ws.binding.clear");
    } catch (error) {
      console.warn(JSON.stringify({ event: "workspace_binding_clear_failed", workspaceId, reason: error instanceof Error ? error.message : "failed" }));
    }
    return null;
  },
});
