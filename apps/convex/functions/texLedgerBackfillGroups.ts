/**
 * Copying every group chat's old log into its ledger, for the groups that have
 * not texted since the ledger began (Dev, 2026-11-02: "Tex needs message
 * history please lets migrate it over"; `docs/decisions/texting-assistant/chat-ledger.md`).
 * A group that texts copies itself in after the Worker's post
 * (`apps/mcp/src/agent/ledgerBackfill.js` `startBackfill`, `backfilledv2`); a
 * quiet one never would.
 *
 * A group's old log sits in the shared workspace its chat was bound to, under
 * `.context/agent/log/<sha256(group id)>/`, and its ledger in the chat's own
 * object, named by its key: sha256 of `<line>:<group id>`
 * (`textGroups.ts` `groupKeyOf`). Neither name holds the other, so each log
 * folder's first event gives the group id, and each of Tex's lines
 * (`TEX_LINE_NUMBERS`) is tried until one makes a key a chat is filed under.
 * A folder no line matches is counted (`unmatched`), never guessed at.
 *
 * Run from the `Tex chats into their ledger` workflow (`scope: groups`),
 * first with `dryRun`. It answers counts and fixed codes only: the workflow's
 * log is public. Running it again copies nothing already in. Internal only.
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
import { dedicatedTexLines } from "./lib/adminFns/texAllowlist";
import { failureCode } from "./texHistoryMigration";
import { copyChatIn } from "./texLedgerBackfill";
import { groupKeyOf } from "./textGroups";
import type { SweepPlan } from "./texGroupMigrationRows";

const LOG = ".context/agent/log/";
const FOLDER = /^[0-9a-f]{64}$/;
const EVENT_KEY = /\/\d{13}-\d{6}\.json$/;
const LIST_PAGES = 200;

type Listed = { objects?: { key: string }[]; truncated?: boolean; cursor?: string };
type LogStore = { list(options: { prefix: string; cursor?: string }): Promise<Listed>; get(key: string): Promise<{ text(): Promise<string> } | null> };

/** Each chat's log folder in a store, with the key of one of its events. */
async function logFolders(store: LogStore): Promise<Map<string, string>> {
  const folders = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const listed = await store.list({ prefix: LOG, ...(cursor ? { cursor } : {}) });
    for (const { key } of listed?.objects ?? []) {
      const folder = key.slice(LOG.length).split("/")[0] ?? "";
      if (FOLDER.test(folder) && EVENT_KEY.test(key) && !folders.has(folder)) folders.set(folder, key);
    }
    if (!listed?.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return folders;
}

/**
 * The group chats whose old log is in this store: `{groupKey, logChat}` for
 * each folder whose event's chat, on one of `lines`, makes a key in `keys`.
 * `unmatched` counts the folders no line matched (a person's own chat among them).
 */
export async function groupsInStore(store: LogStore, lines: string[], keys: Set<string>): Promise<{ found: { groupKey: string; logChat: string }[]; unmatched: number }> {
  const found: { groupKey: string; logChat: string }[] = [];
  let unmatched = 0;
  for (const key of (await logFolders(store)).values()) {
    let chat: unknown = null;
    try {
      const held = await store.get(key);
      chat = held === null ? null : (JSON.parse(await held.text()) as { chat?: unknown }).chat;
    } catch {
      chat = null;
    }
    let groupKey: string | null = null;
    if (typeof chat === "string" && chat !== "") {
      for (const line of lines) {
        const candidate = await groupKeyOf(line, chat);
        if (keys.has(candidate)) {
          groupKey = candidate;
          break;
        }
      }
    }
    if (groupKey === null || typeof chat !== "string") unmatched += 1;
    else found.push({ groupKey, logChat: chat });
  }
  return { found, unmatched };
}

/**
 * Every workspace a group's old log may be in: the ones chats were bound to,
 * those the old notes' plan names, and the pin. A group with a home and no
 * bound workspace texted under a grant in the pin (`texChatHomeGrants.ts`),
 * so its log is there; leaving the pin out left that group's log unread and
 * its memory page waiting (Crystal Care Agency's, 2026-11-03). Only keys of
 * known chats are matched in it, so nothing else there is read past its
 * first event.
 */
export function logPlaces(plan: SweepPlan): Id<"workspaces">[] {
  return [...new Set([...plan.chats.map((chat) => chat.bound), ...plan.workspaces.map((workspace) => workspace.id), plan.pin].filter((id): id is Id<"workspaces"> => id !== null))];
}

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">, chats: string[]): Promise<unknown | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId, { caller: "texLedgerBackfillGroups" });
  const tex = chats.length === 0 ? {} : { ...consoleTexRouting(ctx, workspaceId, { ticketOwners: chats.map((chat) => `chat:${chat}`) }), texChats: chats };
  return storeForBinding(routing.credential(credential), undefined, { managedEncryption, ...tex, ...routing.options });
}

type Counts = { workspaces: number; noBinding: number; chats: number; unmatched: number; already: number; finished: number; partly: number; would: number; noLedger: number; entries: number; failed: number; failedCodes: Record<string, number> };

export const run = internalAction({
  args: { dryRun: v.boolean() },
  returns: v.object({
    workspaces: v.number(),
    noBinding: v.number(),
    chats: v.number(),
    unmatched: v.number(),
    already: v.number(),
    finished: v.number(),
    partly: v.number(),
    would: v.number(),
    noLedger: v.number(),
    entries: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
  }),
  handler: async (ctx, { dryRun }): Promise<Counts> => {
    const counts: Counts = { workspaces: 0, noBinding: 0, chats: 0, unmatched: 0, already: 0, finished: 0, partly: 0, would: 0, noLedger: 0, entries: 0, failed: 0, failedCodes: {} };
    const fail = (code: string) => {
      counts.failed += 1;
      counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
    };
    const plan: SweepPlan = await ctx.runQuery(internal.functions.texGroupMigrationRows.sweepPlan, {});
    const keys = new Set(plan.chats.map((chat) => chat.groupKey));
    const lines = dedicatedTexLines(process.env.TEX_LINE_NUMBERS);
    const places = logPlaces(plan);
    for (const workspaceId of places) {
      counts.workspaces += 1;
      try {
        const bare = (await openStore(ctx, workspaceId, [])) as LogStore | null;
        if (bare === null) {
          counts.noBinding += 1;
          continue;
        }
        const { found, unmatched } = await groupsInStore(bare, lines, keys);
        counts.unmatched += unmatched;
        if (found.length === 0) continue;
        const store = await openStore(ctx, workspaceId, found.map((chat) => chat.groupKey));
        for (const chat of found) {
          counts.chats += 1;
          try {
            const { state, entries } = await copyChatIn(store, { dryRun, group: chat.groupKey, logChat: chat.logChat });
            counts.entries += entries;
            if (state === "done") counts.already += 1;
            else if (state === "finished") counts.finished += 1;
            else if (state === "would") counts.would += 1;
            else if (state === "none") counts.noLedger += 1;
            else counts.partly += 1;
          } catch (error) {
            fail(failureCode(error));
          }
        }
      } catch (error) {
        fail(failureCode(error));
      }
    }
    return counts;
  },
});
