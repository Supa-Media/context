/**
 * Every group chat's memory moved out of the workspace folders (decided by the owner, 2026-11-01: "be sure to move
 * ALL group chats, do a complete migration"; `docs/decisions/texting-assistant/group-memory-one-copy.md`).
 *
 * Two steps, each run from the `Tex group chats migration` workflow, first with `dryRun` (counts only, nothing
 * written):
 *
 *  1. `homeEveryChat` (`texGroupMigrationRows.ts`, which reads no credential): a chat with no home in the pin gets one, named for the people it was last seen with, in the
 *     name of the person who brought Tex in (`lib/textGroupHome.ts`). Each refusal is counted by its code.
 *  2. `sweep`: an old memory note in a workspace folder (`tex/groups/chat-<id>.md`) is trashed once its chat's record
 *     says its words were carried in (`carriedFrom`, `apps/mcp/src/agent/groupMemoryCarry.js`), and with it the voice
 *     note of the same name when the chat keeps its voice in its home. A trash is a row move, restorable for 30 days
 *     (`lib/nodes/rowTrash.ts`). A note no record names is counted, never trashed: its words would have nowhere else.
 *
 * Internal only, so only the workflow's own deploy key can start them. The answers are counts and fixed codes, never
 * a workspace, a path, a name or a key: the workflow's log is public.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import type { FileStore } from "./lib/fileOps/store";
import { privateClearance } from "./lib/clearance";
import { hashToken } from "./lib/crypto";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import { startRowTrash } from "./lib/nodes/rowTrash";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexBuckets, consoleTexRouting } from "./lib/texStore";
import { OLD_NOTE, type SweepPlan } from "./texGroupMigrationRows";


const count = (counts: Record<string, number>, code: string) => {
  counts[code] = (counts[code] ?? 0) + 1;
};

/**
 * `<workspace> <path>` of every old note a chat's record says it carried (`records`, by chat key), and the voice note
 * of the same name beside it when the chat keeps its voice in its home. "default" is the chat's bound workspace; a
 * home's own notes and anything not shaped as an old memory note are never named.
 */
export function carriedNotes(plan: SweepPlan, records: Map<string, { where: string; path: string }[]>): Set<string> {
  const bySlug = new Map(plan.workspaces.map((workspace) => [workspace.slug, workspace.id]));
  const carried = new Set<string>();
  for (const chat of plan.chats) {
    for (const place of records.get(chat.groupKey) ?? []) {
      const workspace = place.where === "default" ? chat.bound : place.where.startsWith("@") ? bySlug.get(place.where.slice(1)) : undefined;
      const match = OLD_NOTE.exec(place.path);
      if (!workspace || workspace === plan.pin || match === null || match[1] !== "chat") continue;
      carried.add(`${workspace} ${place.path}`);
      if (chat.homed) carried.add(`${workspace} tex/groups/voice-${match[2]}.md`);
    }
  }
  return carried;
}

/** The places a chat's record says its old notes were carried from, or null when it has not carried them. */
async function carriedFrom(ctx: ActionCtx, pin: Id<"workspaces">, groupKey: string): Promise<{ where: string; path: string }[] | null> {
  const owner = `chat:${groupKey}`;
  const buckets = consoleTexBuckets(ctx, pin, { ticketOwners: [owner] });
  if (buckets === null) return null;
  // The record's one name in its chat's object: sha256 of "memory" (`apps/mcp/src/agent/chatMemoryRecord.js`).
  const held = await buckets(owner).get(`state/${await hashToken("memory")}.json`);
  if (held === null) return null;
  const record = JSON.parse(await held.text()) as { carried?: number; carriedFrom?: unknown };
  if (record.carried !== 1 || !Array.isArray(record.carriedFrom)) return null;
  return record.carriedFrom.filter((entry): entry is { where: string; path: string } => typeof entry?.where === "string" && typeof entry?.path === "string");
}

async function openWorkspaceStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<FileStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  return storeForBinding(credential, undefined, { managedEncryption, ...consoleTexRouting(ctx, workspaceId) }) as unknown as FileStore;
}

type SweepCounts = { chats: number; carried: number; oldNotes: number; wouldTrash: number; trashed: number; notCarried: number; failed: Record<string, number> };

const sweepCounts = v.object({
  chats: v.number(),
  carried: v.number(),
  oldNotes: v.number(),
  wouldTrash: v.number(),
  trashed: v.number(),
  notCarried: v.number(),
  failed: v.record(v.string(), v.number()),
});

export const sweep = internalAction({
  args: { dryRun: v.boolean() },
  returns: sweepCounts,
  handler: async (ctx, { dryRun }): Promise<SweepCounts> => {
    const plan: SweepPlan = await ctx.runQuery(internal.functions.texGroupMigrationRows.sweepPlan, {});
    const failed: Record<string, number> = {};
    const result: SweepCounts = { chats: plan.chats.length, carried: 0, oldNotes: 0, wouldTrash: 0, trashed: 0, notCarried: 0, failed };
    if (plan.pin === null) {
      count(failed, "no_pin");
      return result;
    }
    const records = new Map<string, { where: string; path: string }[]>();
    for (const chat of plan.chats) {
      try {
        const places = await carriedFrom(ctx, plan.pin, chat.groupKey);
        if (places !== null) records.set(chat.groupKey, places);
      } catch {
        count(failed, "record_unreadable");
      }
    }
    result.carried = records.size;
    const carried = carriedNotes(plan, records);
    for (const workspace of plan.workspaces) {
      const due = workspace.paths.filter((path) => carried.has(`${workspace.id} ${path}`));
      result.oldNotes += workspace.paths.length;
      result.notCarried += workspace.paths.length - due.length;
      result.wouldTrash += due.length;
      if (dryRun || due.length === 0) continue;
      const store = await openWorkspaceStore(ctx, workspace.id);
      if (store === null) {
        for (const _ of due) count(failed, "no_storage");
        continue;
      }
      for (const path of due) {
        try {
          await startRowTrash(ctx, { workspaceId: workspace.id, store, path, clearance: privateClearance(), now: Date.now() });
          result.trashed += 1;
        } catch (error) {
          count(failed, (error as { code?: string })?.code ?? "trash_failed");
        }
      }
    }
    return result;
  },
});
