/**
 * The old daily transcript pages, `tex/transcripts/` in a personal workspace,
 * moved to the trash (Dev, 2026-11-02: "there's still a transcript folder.
 * Isn't this technically the same thing? Why do we still have duplicated
 * information?"; `docs/decisions/texting-assistant/chat-ledger.md`). Nothing
 * writes them any more (#2713), and every word they show is in the person's
 * chat ledger, copied in whole before this runs (the `backfilledv1` mark;
 * `texLedgerBackfill.ts`). A workspace whose chat is not copied in yet keeps
 * its folder and is counted as `notCopiedIn`.
 *
 * A trash is a row move of the whole folder, restorable for 30 days
 * (`lib/nodes/rowTrash.ts`), the workspace's object hearing first. Run from
 * the `Tex chats into their ledger` workflow (`scope: transcripts`), first
 * with `dryRun`. Counts and fixed codes only: the workflow's log is public.
 * Internal only.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { copiedIn } from "../../mcp/src/agent/ledgerConversation.js";
import type { FileStore } from "./lib/fileOps/store";
import { privateClearance } from "./lib/clearance";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import { startRowTrash } from "./lib/nodes/rowTrash";
import { objectFirst } from "./lib/rowWatch/objectFirst";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import { failureCode } from "./texHistoryMigration";

export const TRANSCRIPTS = "tex/transcripts";
const WORKSPACES_PER_CALL = 10;

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<FileStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId, { caller: "texTranscriptsTrash" });
  return storeForBinding(routing.credential(credential), undefined, {
    managedEncryption,
    ...consoleTexRouting(ctx, workspaceId, { ticketOwners: [`person:${workspaceId}`] }),
    ...routing.options,
  }) as unknown as FileStore;
}

type Counts = { workspaces: number; notPersonal: number; none: number; noBinding: number; notCopiedIn: number; would: number; trashed: number; failed: number; failedCodes: Record<string, number>; cursor: string; done: boolean };

export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()) },
  returns: v.object({
    workspaces: v.number(),
    notPersonal: v.number(),
    none: v.number(),
    noBinding: v.number(),
    notCopiedIn: v.number(),
    would: v.number(),
    trashed: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<Counts> => {
    const counts: Counts = { workspaces: 0, notPersonal: 0, none: 0, noBinding: 0, notCopiedIn: 0, would: 0, trashed: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
    const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } = await ctx.runQuery(internal.functions.folderNumbers.workspacePage, {
      ...(args.cursor ? { cursor: args.cursor } : {}),
      limit: WORKSPACES_PER_CALL,
    });
    for (const workspaceId of page.workspaceIds) {
      counts.workspaces += 1;
      try {
        if ((await ctx.runQuery(internal.functions.texHistoryMigrationRows.kindOf, { workspaceId })) !== "personal") {
          counts.notPersonal += 1;
          continue;
        }
        const plan = await ctx.runQuery(internal.functions.nodeRowMoves.plan, { workspaceId, from: TRANSCRIPTS });
        if (plan.kind !== "folder") {
          counts.none += 1;
          continue;
        }
        const store = await openStore(ctx, workspaceId);
        if (store === null) {
          counts.noBinding += 1;
          continue;
        }
        // Only once the chat is whole in its ledger: the pages are then a second copy of it, never the only one.
        if (!(await copiedIn(store))) {
          counts.notCopiedIn += 1;
          continue;
        }
        if (args.dryRun) {
          counts.would += 1;
          continue;
        }
        await objectFirst(ctx, workspaceId, () => startRowTrash(ctx, { workspaceId, store, path: TRANSCRIPTS, clearance: privateClearance(), now: Date.now() }));
        counts.trashed += 1;
      } catch (error) {
        const code = failureCode(error);
        counts.failed += 1;
        counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
        console.error(JSON.stringify({ event: "tex_transcripts_trash_failed", workspaceId, code }));
      }
    }
    return { ...counts, cursor: page.cursor, done: page.done };
  },
});
