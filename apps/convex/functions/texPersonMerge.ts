/**
 * Moving every person's Tex into their workspace's object now, rather than on
 * their next text (Dev, 2026-11-02: "why not just do it now?";
 * `docs/decisions/texting-assistant/tex-durable-objects.md`, "One object for a
 * person's workspace and their Tex").
 *
 * The move itself is the gateway's: the first Tex call to a personal
 * workspace's object copies the person's Tex store in, checks it and only then
 * answers (`apps/mcp/src/texStore/merge.js`). This sweep makes that first call
 * for each personal workspace, one read of the person's history record through
 * the door (`lib/texStore.ts`), so nobody waits for a copy on a text. A person
 * already moved pays one read. Run from the `Tex into workspace objects`
 * workflow: first with `dryRun` (counts the personal workspaces, calls
 * nothing), then for real, paging with the cursor until `done`. It answers
 * counts only, never a key or a word: this repository is public, and so is the
 * job's log. Internal only, so only the workflow's deploy key can start it.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";
import { failureCode } from "./texHistoryMigration";

const WORKSPACES_PER_CALL = 10;
/** A key every person's Tex routes to its object (`store/texRouting.js` `isAgentHomeKey`): reading it is the first call. */
const FIRST_CALL_KEY = ".context/agent/history/texts.json";

type Counts = {
  workspaces: number;
  notPersonal: number;
  noBinding: number;
  would: number;
  reached: number;
  failed: number;
  failedCodes: Record<string, number>;
  cursor: string;
  done: boolean;
};

type HeadStore = { head(key: string): Promise<unknown> };

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<HeadStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId, { caller: "texPersonMerge" });
  return storeForBinding(routing.credential(credential), undefined, { managedEncryption, ...consoleTexRouting(ctx, workspaceId, { ticketOwners: [`person:${workspaceId}`] }), ...routing.options }) as unknown as HeadStore;
}

/** One page: up to `WORKSPACES_PER_CALL` workspaces. `only` names one workspace by id. */
export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), only: v.optional(v.id("workspaces")) },
  returns: v.object({
    workspaces: v.number(),
    notPersonal: v.number(),
    noBinding: v.number(),
    would: v.number(),
    reached: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<Counts> => {
    const counts: Counts = { workspaces: 0, notPersonal: 0, noBinding: 0, would: 0, reached: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
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
        if (args.dryRun) {
          counts.would += 1;
          continue;
        }
        // The workspace object answers only once the person's Tex is copied in and checked; a failed copy throws.
        await store.head(FIRST_CALL_KEY);
        counts.reached += 1;
      } catch (error) {
        // Counted by a fixed code, never named: the workflow's log is public. A person not moved here moves on their next text.
        const code = failureCode(error);
        counts.failed += 1;
        counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
        console.error(JSON.stringify({ event: "tex_person_merge_sweep_failed", workspaceId, code }));
      }
    }
    return { ...counts, cursor: page.cursor, done: page.done };
  },
});
