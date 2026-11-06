/**
 * Copying every person's old Tex chat into their chat's ledger, for the chats
 * that have not texted since the ledger began (Dev, 2026-11-02: retire the old
 * copies of a chat; `docs/decisions/texting-assistant/chat-ledger.md`,
 * "Retiring the old copies"). A chat that texts copies itself in after the
 * Worker's post (`apps/mcp/src/agent/ledgerBackfill.js` `startBackfill`); a
 * quiet one never would, and its old copies (the bucket's event log, the
 * history record) cannot be deleted until it is in.
 *
 * Run from the `Tex chats into their ledger` workflow: first with `dryRun`
 * (counts only, nothing written), then for real, paging with the cursor until
 * `done`. The copy-in is the gateway's own code, run over the workspace's
 * store with its Tex keys routed to its object (`lib/texStore.ts`), part after
 * part until the chat's `backfilledv1` mark is in. Personal workspaces only:
 * only they have a one-to-one chat. It answers counts only, never a key or a
 * word: this repository is public, and so is the job's log. Running it again
 * copies nothing already in. Internal only, so only the workflow's deploy key
 * can start it.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { backfillLedger } from "../../mcp/src/agent/ledgerBackfill.js";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";
import { failureCode } from "./texHistoryMigration";

const WORKSPACES_PER_CALL = 10;
/** Parts of one chat copied in one call, each `BACKFILL_EVENTS` of its log: a longer chat goes on in the next run. */
const PARTS_PER_CHAT = 20;

type Counts = {
  workspaces: number;
  notPersonal: number;
  noBinding: number;
  noLedger: number;
  already: number;
  finished: number;
  partly: number;
  would: number;
  entries: number;
  failed: number;
  failedCodes: Record<string, number>;
  cursor: string;
  done: boolean;
};

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<unknown | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId, { caller: "texLedgerBackfill" });
  return storeForBinding(routing.credential(credential), undefined, { managedEncryption, ...consoleTexRouting(ctx, workspaceId, { ticketOwners: [`person:${workspaceId}`] }), ...routing.options });
}

/**
 * One person's old chat into their ledger: part after part until it is all in
 * (`finished`), already was (`done`), there is no ledger (`none`), a dry run
 * (`would`), or `PARTS_PER_CHAT` parts went in and more are left (`copied`).
 */
export async function copyChatIn(
  store: unknown,
  { dryRun, group = null, logChat = null }: { dryRun: boolean; group?: string | null; logChat?: string | null },
): Promise<{ state: string; entries: number }> {
  let state = "copied";
  let entries = 0;
  for (let part = 0; part < PARTS_PER_CHAT && state === "copied"; part += 1) {
    // `backfillLedger` is plain JS whose `group` defaults to null, so its inferred type admits no key: widened here.
    const options = (group === null ? { dryRun } : { dryRun, group, logChat }) as { dryRun: boolean };
    const ran = await backfillLedger(store, options);
    state = ran.state;
    entries += ran.entries;
  }
  return { state, entries };
}

/** One page: up to `WORKSPACES_PER_CALL` workspaces. `only` names one workspace by id. */
export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), only: v.optional(v.id("workspaces")) },
  returns: v.object({
    workspaces: v.number(),
    notPersonal: v.number(),
    noBinding: v.number(),
    noLedger: v.number(),
    already: v.number(),
    finished: v.number(),
    partly: v.number(),
    would: v.number(),
    entries: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<Counts> => {
    const counts: Counts = { workspaces: 0, notPersonal: 0, noBinding: 0, noLedger: 0, already: 0, finished: 0, partly: 0, would: 0, entries: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
    const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } =
      args.only !== undefined
        ? { workspaceIds: [args.only], cursor: "", done: true }
        : await ctx.runQuery(internal.functions.folderNumbers.workspacePage, { ...(args.cursor ? { cursor: args.cursor } : {}), limit: WORKSPACES_PER_CALL });
    for (const workspaceId of page.workspaceIds) {
      counts.workspaces += 1;
      try {
        if ((await ctx.runQuery(internal.functions.texHistoryMigrationRows.kindOf, { workspaceId })) !== "personal") {
          counts.notPersonal += 1;
          continue;
        }
        const store = await openStore(ctx, workspaceId);
        if (store === null) {
          counts.noBinding += 1;
          continue;
        }
        const { state, entries } = await copyChatIn(store, { dryRun: args.dryRun });
        counts.entries += entries;
        if (state === "done") counts.already += 1;
        else if (state === "finished") counts.finished += 1;
        else if (state === "would") counts.would += 1;
        else if (state === "none") counts.noLedger += 1;
        else counts.partly += 1;
      } catch (error) {
        // Counted by a fixed code, never named: the workflow's log is public. A failed chat copies itself in on its next text.
        const code = failureCode(error);
        counts.failed += 1;
        counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
        console.error(JSON.stringify({ event: "tex_ledger_backfill_sweep_failed", workspaceId, code }));
      }
    }
    return { ...counts, cursor: page.cursor, done: page.done };
  },
});
