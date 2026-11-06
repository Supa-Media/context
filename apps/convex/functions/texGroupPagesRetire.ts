/**
 * Every group chat's memory page (`tex/groups/<words>/history.md` in the
 * pinned workspace, "Tex's memory of this group chat") copied into the chat's
 * ledger and then moved to the trash, and every group's history file made
 * (Dev, 2026-11-02, on a decision card: "Retire it, one copy";
 * `docs/decisions/texting-assistant/chat-ledger.md`, "Retiring the old copies").
 *
 * A group that texts copies its own page in on its next turn
 * (`apps/mcp/src/agent/groupTurn.js` `readGroupMemory`); this does the same for
 * the quiet ones, with the gateway's own code (`groupPageCopy.js`), and makes
 * each home's `history.ledger.json` (`historyFile.js`), which used to wait for
 * the chat's next text. A page is trashed only once its chat's ledger carries
 * the copied mark, read again just before: never the only copy. A trash is a
 * row move, restorable for 30 days (`lib/nodes/rowTrash.ts`).
 *
 * Run from the `Tex chats into their ledger` workflow (`scope: group_pages`),
 * first with `dryRun`. Counts and fixed codes only: the workflow's log is
 * public. Running it again does nothing already done. Internal only.
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { copyGroupPageIn, groupPageCopied } from "../../mcp/src/agent/groupPageCopy.js";
import { parseGroupNote } from "../../mcp/src/agent/groupPageFormat.js";
import { ensureHistoryFile } from "../../mcp/src/agent/historyFile.js";
import type { FileStore } from "./lib/fileOps/store";
import { privateClearance } from "./lib/clearance";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import { startRowTrash } from "./lib/nodes/rowTrash";
import { objectFirst } from "./lib/rowWatch/objectFirst";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import { consoleIdLayoutHooks } from "./lib/noteIds/consoleLayer";
import { pinnedContextWorkspace } from "./lib/pinnedContext";
import { chatHomePath } from "./lib/textGroupHome";
import { failureCode } from "./texHistoryMigration";

const CHATS_PER_CALL = 10;
const KEY = /^[0-9a-f]{64}$/;

/** The pin, and each chat with a home there: its key and its home's folder. */
export const homes = internalQuery({
  args: {},
  returns: v.object({ pin: v.union(v.id("workspaces"), v.null()), chats: v.array(v.object({ groupKey: v.string(), folder: v.string() })) }),
  handler: async (ctx) => {
    const pin = await pinnedContextWorkspace(ctx);
    if (pin === null) return { pin: null, chats: [] };
    const chats = [];
    for (const chat of await ctx.db.query("textGroups").collect()) {
      if (typeof chat.groupKey !== "string" || !KEY.test(chat.groupKey) || chat.homeWords === undefined || chat.workspaceId === pin._id) continue;
      chats.push({ groupKey: chat.groupKey, folder: chatHomePath(chat.homeWords) });
    }
    chats.sort((a, b) => (a.groupKey < b.groupKey ? -1 : 1));
    return { pin: pin._id, chats };
  },
});

type LedgerClient = Parameters<typeof copyGroupPageIn>[0];
type TexStore = FileStore & {
  keysAt(paths: string[]): Promise<Record<string, string | false>>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  texLedger(chat: string): LedgerClient | null;
};

async function openStore(ctx: ActionCtx, workspaceId: Id<"workspaces">, chats: string[]): Promise<TexStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId, { caller: "texGroupPagesRetire" });
  return storeForBinding(routing.credential(credential), undefined, {
    managedEncryption,
    // The id layer, as the gateway's group turn has it: `keysAt` and a new note's row (the history file's) come from it.
    idLayout: consoleIdLayoutHooks(ctx, workspaceId),
    ...consoleTexRouting(ctx, workspaceId, { ticketOwners: chats.map((chat) => `chat:${chat}`) }),
    texChats: chats,
    ...routing.options,
  }) as unknown as TexStore;
}

/** The person-chat mark (`apps/mcp/src/agent/ledger.js` `BACKFILLED`), named here so this file reaches no more of the agent. */
const BACKFILLED = "backfilledv1";

type Counts = {
  chats: number;
  noPage: number;
  notAPage: number;
  waiting: number;
  /** Of `waiting`, the ones whose ledger starts with the person-chat mark (`backfilledv1`), and with anything else. */
  waitingOldV1: number;
  waitingOldOther: number;
  would: number;
  copied: number;
  already: number;
  files: number;
  trashed: number;
  failed: number;
  failedCodes: Record<string, number>;
  cursor: string;
  done: boolean;
};

export const run = internalAction({
  args: { dryRun: v.boolean(), cursor: v.optional(v.string()), withoutLog: v.optional(v.boolean()) },
  returns: v.object({
    chats: v.number(),
    noPage: v.number(),
    notAPage: v.number(),
    waiting: v.number(),
    waitingOldV1: v.number(),
    waitingOldOther: v.number(),
    would: v.number(),
    copied: v.number(),
    already: v.number(),
    files: v.number(),
    trashed: v.number(),
    failed: v.number(),
    failedCodes: v.record(v.string(), v.number()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, args): Promise<Counts> => {
    const counts: Counts = { chats: 0, noPage: 0, notAPage: 0, waiting: 0, waitingOldV1: 0, waitingOldOther: 0, would: 0, copied: 0, already: 0, files: 0, trashed: 0, failed: 0, failedCodes: {}, cursor: "", done: false };
    const plan: { pin: Id<"workspaces"> | null; chats: { groupKey: string; folder: string }[] } = await ctx.runQuery(internal.functions.texGroupPagesRetire.homes, {});
    const start = Math.max(0, Number.parseInt(args.cursor ?? "0", 10) || 0);
    const batch = plan.chats.slice(start, start + CHATS_PER_CALL);
    const next = start + batch.length;
    if (plan.pin === null || batch.length === 0) return { ...counts, cursor: String(next), done: true };
    const pin = plan.pin;
    const store = await openStore(ctx, pin, batch.map((chat) => chat.groupKey));
    if (store === null) return { ...counts, failed: 1, failedCodes: { no_binding: 1 }, cursor: String(next), done: true };
    for (const chat of batch) {
      counts.chats += 1;
      try {
        const ledger = store.texLedger(chat.groupKey);
        const page = `${chat.folder}/history.md`;
        const history = `${chat.folder}/history.ledger.json`;
        if (typeof store.keysAt !== "function") throw Object.assign(new Error("the store has no id layer"), { code: "NoIdLayer" });
        const keys = await store.keysAt([page, history]);
        // The history file the chat's next text would make (`historyFile.js`): made now, never written over.
        if (keys?.[history] === false) {
          if (!args.dryRun) await ensureHistoryFile(store, history, keys);
          counts.files += 1;
        }
        const pageKey = keys?.[page];
        if (typeof pageKey !== "string") {
          counts.noPage += 1;
          continue;
        }
        let state = (await groupPageCopied(ledger, chat.groupKey)) ? "done" : null;
        if (state === null) {
          const held = await store.get(pageKey);
          const turns = held === null ? null : parseGroupNote(await held.text());
          if (turns === null) {
            counts.notAPage += 1;
            continue;
          }
          state = (await copyGroupPageIn(ledger, chat.groupKey, turns, { dryRun: args.dryRun, withoutLog: args.withoutLog === true })).state;
        }
        if (state === "waiting") {
          counts.waiting += 1;
          // What the ledger starts with, as a fixed count only: why the page waits (Crystal Care Agency's, 2026-11-03).
          const oldest = (await (ledger as { oldest?: (chat: string) => Promise<{ id: string } | null> } | null)?.oldest?.(chat.groupKey)) ?? null;
          if (oldest?.id === BACKFILLED) counts.waitingOldV1 += 1;
          else counts.waitingOldOther += 1;
        }
        else if (state === "would") counts.would += 1;
        else if (state === "copied") counts.copied += 1;
        else if (state === "done") counts.already += 1;
        if (args.dryRun || (state !== "copied" && state !== "done")) continue;
        // Read again just before: the page goes only while the ledger holds it.
        if (!(await groupPageCopied(ledger, chat.groupKey))) continue;
        await objectFirst(ctx, pin, () => startRowTrash(ctx, { workspaceId: pin, store, path: page, clearance: privateClearance(), now: Date.now() }));
        counts.trashed += 1;
      } catch (error) {
        const code = failureCode(error);
        counts.failed += 1;
        counts.failedCodes[code] = (counts.failedCodes[code] ?? 0) + 1;
        console.error(JSON.stringify({ event: "tex_group_page_retire_failed", code }));
      }
    }
    return { ...counts, cursor: String(next), done: next >= plan.chats.length };
  },
});
