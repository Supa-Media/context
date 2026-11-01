/**
 * Moving every workspace's one-to-one Tex history and turn records out of its
 * bucket into its Tex Durable Object (the owner, 2026-11-01:
 * `docs/decisions/texting-assistant/one-to-one-history.md`).
 *
 * Run from the `Tex history into its object` workflow: first with `dryRun`
 * (counts only, nothing written), then for real, paging with the cursor until
 * `done`. The move itself is the gateway's (`apps/mcp/src/agent/agentHomeMove.js`),
 * over the workspace's own store with its Tex keys routed to its object
 * (`lib/texStore.ts`). It answers counts only, never a key or a word: this
 * repository is public, and so is the job's log. Running it again moves
 * nothing already moved. Internal only, so only the workflow's deploy key can
 * start it.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { moveAgentHome } from "../../mcp/src/agent/agentHomeMove.js";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";

const WORKSPACES_PER_CALL = 20;

type Counts = {
  workspaces: number;
  noBinding: number;
  historyMoved: number;
  historyAlready: number;
  historyNone: number;
  historyWould: number;
  turnsCopied: number;
  turnsKept: number;
  turnsWould: number;
  failed: number;
  failedCodes: Record<string, number>;
  cursor: string;
  done: boolean;
};

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<unknown | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  // Opened as every console store is, workspace object routing included (`lib/rowWatch/consoleRouting.ts`).
  const routing = await consoleWorkspaceRouting(ctx, workspaceId);
  return storeForBinding(routing.credential(credential), undefined, { managedEncryption, ...consoleTexRouting(ctx, workspaceId, { ticketOwners: [`person:${workspaceId}`] }), ...routing.options });
}

/** A failure as a fixed code: the error's own code or name when it is a plain word, never its message. */
export function failureCode(error: unknown): string {
  const named = error as { code?: unknown; name?: unknown; message?: unknown } | null;
  // A bucket's refusal (`apps/mcp/src/store/s3.js` `s3Error`): its operation and status, never the key it names.
  const s3 = typeof named?.message === "string" ? /^S3 ([A-Za-z]{1,24}) .* failed with (\d{3})\b/s.exec(named.message) : null;
  if (s3) return `S3_${s3[1]}_${s3[2]}`;
  for (const value of [named?.code, named?.name]) if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(value)) return value;
  return "unknown";
}

/** One page: up to `WORKSPACES_PER_CALL` workspaces. `only` names one workspace by id. */
export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), only: v.optional(v.id("workspaces")) },
  returns: v.object({
    workspaces: v.number(),
    noBinding: v.number(),
    historyMoved: v.number(),
    historyAlready: v.number(),
    historyNone: v.number(),
    historyWould: v.number(),
    turnsCopied: v.number(),
    turnsKept: v.number(),
    turnsWould: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<Counts> => {
    const counts: Counts = { workspaces: 0, noBinding: 0, historyMoved: 0, historyAlready: 0, historyNone: 0, historyWould: 0, turnsCopied: 0, turnsKept: 0, turnsWould: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
    const page: { workspaceIds: Id<"workspaces">[]; cursor: string; done: boolean } =
      args.only !== undefined
        ? { workspaceIds: [args.only], cursor: "", done: true }
        : await ctx.runQuery(internal.functions.folderNumbers.workspacePage, { ...(args.cursor ? { cursor: args.cursor } : {}), limit: WORKSPACES_PER_CALL });
    for (const workspaceId of page.workspaceIds) {
      counts.workspaces += 1;
      try {
        const store = await openStore(ctx, workspaceId);
        if (store === null) {
          counts.noBinding += 1;
          continue;
        }
        const moved = await moveAgentHome(store, { dryRun: args.dryRun });
        if (moved.history === "moved") counts.historyMoved += 1;
        else if (moved.history === "already") counts.historyAlready += 1;
        else if (moved.history === "would") counts.historyWould += 1;
        else counts.historyNone += 1;
        counts.turnsCopied += moved.turns.copied;
        counts.turnsKept += moved.turns.kept;
        counts.turnsWould += moved.turns.would;
      } catch (error) {
        // Counted by a fixed code, never named: the workflow's log is public. A failed workspace's first text moves its history itself.
        const code = failureCode(error);
        counts.failed += 1;
        counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
        console.error(JSON.stringify({ event: "tex_history_migration_failed", workspaceId, code }));
      }
    }
    return { ...counts, cursor: page.cursor, done: page.done };
  },
});
