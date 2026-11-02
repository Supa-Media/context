/**
 * Tex's notes wiped from a Durable Object (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/tex-durable-objects.md`).
 *
 * An owner is a person (`person:<workspaceId>`, their personal workspace) or
 * a group chat (`chat:<chatId>`). `wipeOwner` empties one of them through the
 * gateway's door (`lib/texStore.ts`), with a ticket that names only that owner,
 * and retries with backoff until it lands. Wiping an object that holds nothing
 * is a no-op. `wipeWorkspace` is the person case, kept for the workspace
 * cascade already scheduled in `account.ts`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { consoleTexBuckets } from "./lib/texStore";

/** Tries before it stops and says so in the logs: about a day with the backoff below. */
const MAX_ATTEMPTS = 12;

/** One minute, doubling, at most six hours. */
function backoffMs(attempt: number): number {
  return Math.min(60_000 * 2 ** attempt, 6 * 60 * 60 * 1000);
}

/** Only this workspace's own person object, or a group chat's (any chat, as the ticket's `mint` allows). */
function isWipeable(owner: string, workspaceId: Id<"workspaces">): boolean {
  if (owner.startsWith("person:")) return owner === `person:${workspaceId}`;
  return /^chat:[A-Za-z0-9_-]{1,64}$/.test(owner);
}

async function wipe(ctx: ActionCtx, owner: string, workspaceId: Id<"workspaces">, attempt: number): Promise<null> {
  if (!isWipeable(owner, workspaceId)) return null;
  const scope = owner.startsWith("chat:") ? "chat" : "person";
  const buckets = consoleTexBuckets(ctx, workspaceId, { ticketOwners: [owner] });
  // A deployment that cannot reach a gateway has no Tex objects either: nothing was ever kept in one.
  if (buckets === null) return null;
  try {
    await buckets(owner).wipe();
    console.log(JSON.stringify({ event: "tex_store_wiped", workspaceId, scope }));
  } catch {
    if (attempt + 1 >= MAX_ATTEMPTS) {
      console.error(JSON.stringify({ event: "tex_store_wipe_failed", workspaceId, scope, attempts: attempt + 1 }));
      return null;
    }
    const delay = backoffMs(attempt);
    await ctx.scheduler.runAfter(delay, internal.functions.texStoreWipe.wipeOwner, { owner, workspaceId, attempt: attempt + 1 });
  }
  return null;
}

export const wipeOwner = internalAction({
  args: { owner: v.string(), workspaceId: v.id("workspaces"), attempt: v.number() },
  returns: v.null(),
  handler: (ctx, { owner, workspaceId, attempt }) => wipe(ctx, owner, workspaceId, attempt),
});

export const wipeWorkspace = internalAction({
  args: { workspaceId: v.id("workspaces"), attempt: v.number() },
  returns: v.null(),
  handler: (ctx, { workspaceId, attempt }) => wipe(ctx, `person:${workspaceId}`, workspaceId, attempt),
});
