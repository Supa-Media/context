/**
 * Sends the pinned workspace's object its access set now, so it holds every chat home's key by its words
 * (`lib/nodes/accessSet.ts` `chatHomeKeys`) without waiting for the next access change (2026-11-20, Dev2: no note
 * save needs Convex). The object places a new note in a home from that map (`apps/mcp/src/workspaceStore/
 * lookupMiss.js` `texHomeOwner`). Run after each deploy (`deploy-convex.yml`); a new home's own access row pushes
 * the set with its words in the same mutation (`lib/textGroupHome.ts` `makeChatHome`), so nothing else needs it.
 *
 * Answers only whether a push was queued: no words, keys or ids leave.
 */

import { v } from "convex/values";
import { internalMutation, flushRowChanges } from "./lib/rowWatch/mutations";
import type { WorkspaceChange } from "./lib/rowWatch/watch";
import { sealedPin } from "./lib/textGroupHome";

export const push = internalMutation({
  args: {},
  returns: v.object({ queued: v.boolean() }),
  handler: async (ctx) => {
    const pinned = await sealedPin(ctx);
    if (pinned === null) return { queued: false };
    const change: WorkspaceChange = { nodeIds: new Set(), access: true, narrows: false, binding: false, born: new Set(), bornPaths: new Set(), goneObjectIds: new Set() };
    await flushRowChanges(ctx, new Map([[pinned, change]]), "chatHomesPush");
    return { queued: true };
  },
});
