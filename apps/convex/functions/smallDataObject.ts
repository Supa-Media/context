/**
 * The forwarding ledger's copy in the workspace object
 * (`lib/smallData/objectLedger.ts`, `apps/mcp/src/workspaceStore/forwardingRows.js`):
 * the whole ledger, sent with the version it is at. The object keeps a send
 * only when its version is at least the one it holds, so sends that land out
 * of order leave the newest. Best-effort: a send that fails leaves the object
 * on its older copy, or none, and the next change or the next read the object
 * could not answer sends again.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { ledgerOf, ledgerRows } from "./lib/smallData/forwarding";
import { smallDataStateOf } from "./lib/smallData/state";
import { consoleWorkspaceClient } from "./lib/workspaceObjects/door";

const kind = v.union(v.literal("note"), v.literal("folder"));
const entry = v.object({ from: v.string(), to: v.string(), kind, at: v.number() });

/** The ledger, oldest first, with the version it is at and where the workspace's notes live. */
export const ledgerToSend = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ home: v.string(), version: v.number(), entries: v.array(entry) }),
  handler: async (ctx, { workspaceId }) => {
    const record = await ctx.db
      .query("workspaceObjectHomes")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    const state = await smallDataStateOf(ctx.db, workspaceId);
    return {
      home: record?.home ?? "bucket",
      version: state?.forwardingVersion ?? 0,
      entries: ledgerOf(await ledgerRows(ctx.db, workspaceId)).entries,
    };
  },
});

/** Send the whole ledger to the workspace's object. Logs a failure and never throws. */
export const sendLedger = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    try {
      const ledger = await ctx.runQuery(internal.functions.smallDataObject.ledgerToSend, { workspaceId });
      if (ledger.home !== "object") return null;
      const client = consoleWorkspaceClient(ctx, workspaceId, { caller: "forwarding" });
      if (client === null) return null;
      const answer = (await client.forwardingPut({ version: ledger.version, entries: ledger.entries })) as { kept?: unknown } | null;
      console.log(JSON.stringify({ event: "forwarding.object_sent", workspaceId, version: ledger.version, entries: ledger.entries.length, kept: answer?.kept === true }));
    } catch (error) {
      console.error(JSON.stringify({ event: "forwarding.object_send_failed", workspaceId, error: String((error as Error)?.name ?? "Error") }));
    }
    return null;
  },
});
