/**
 * The shape of each group chat's event log in a window of time (2026-11-02): how many events, how many bytes, and
 * the runs of events filed under one set of people. A group turn is shown only the latest unbroken run filed under
 * the chat's current people (`apps/mcp/src/agent/logRender.js` `seenBy`), and at most 400 events or 120,000
 * characters of the log (`log.js` `readEvents`); a person asked for the day's summary and Tex saw one joke.
 *
 * Read only. It answers fixed codes, minutes from the window's start and counts, never an id, a name or a word: it
 * is run from the `Tex group log shape` workflow, whose log is public. A chat is told apart by the first six
 * characters of its log folder's name (already a hash), and each set of people by a letter in order of appearance.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import type { FileStore } from "./lib/fileOps/store";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import { consoleWorkspaceRouting } from "./lib/rowWatch/consoleRouting";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import type { SweepPlan } from "./texGroupMigrationRows";

const LOG = ".context/agent/log/";

type Listed = { objects?: { key: string }[]; truncated?: boolean; cursor?: string; delimitedPrefixes?: string[] };
type Store = { list(options: { prefix: string; cursor?: string; delimiter?: string }): Promise<Listed>; get(key: string): Promise<{ text(): Promise<string> } | null> };
type Event = { id?: unknown; at?: unknown; people?: unknown; from?: { kind?: unknown }; kind?: unknown };

async function openWorkspaceStore(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<Store | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  const routing = await consoleWorkspaceRouting(ctx, workspaceId);
  return storeForBinding(routing.credential(credential), undefined, { managedEncryption, ...consoleTexRouting(ctx, workspaceId), ...routing.options }) as unknown as FileStore as unknown as Store;
}

async function listAll(store: Store, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const listed = await store.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const object of listed?.objects ?? []) keys.push(object.key);
    if (!listed?.truncated || !listed.cursor) break;
    cursor = listed.cursor;
  }
  return keys;
}

export const shape = internalAction({
  args: { from: v.string(), to: v.string() },
  returns: v.any(),
  handler: async (ctx, { from, to }): Promise<unknown> => {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: "bad_window" };
    const plan: SweepPlan = await ctx.runQuery(internal.functions.texGroupMigrationRows.sweepPlan, {});
    const bound = [...new Set(plan.chats.map((chat) => chat.bound).filter((id): id is Id<"workspaces"> => id !== null))];
    const out: unknown[] = [];
    for (const workspaceId of bound) {
      let store: Store | null;
      try {
        store = await openWorkspaceStore(ctx, workspaceId);
      } catch {
        out.push({ error: "store_unopened" });
        continue;
      }
      if (store === null) continue;
      let keys: string[];
      try {
        keys = await listAll(store, LOG);
      } catch {
        out.push({ error: "log_unlisted" });
        continue;
      }
      const byChat = new Map<string, string[]>();
      for (const key of keys) {
        const folder = key.slice(LOG.length).split("/")[0] ?? "";
        if (!/^[0-9a-f]{64}$/.test(folder)) continue;
        byChat.set(folder, [...(byChat.get(folder) ?? []), key]);
      }
      for (const [folder, chatKeys] of byChat) {
        const events: (Event & { bytes: number })[] = [];
        for (const key of chatKeys) {
          // The key names its time (`log.js`: `<id>.json`, id = 13-digit ms and a sequence).
          const at = Number(key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("/") + 14));
          if (!Number.isFinite(at) || at < start || at > end) continue;
          try {
            const held = await store.get(key);
            if (held === null) continue;
            const text = await held.text();
            events.push({ ...(JSON.parse(text) as Event), bytes: text.length });
          } catch {
            events.push({ bytes: 0, kind: "unreadable" });
          }
        }
        if (events.length === 0) continue;
        events.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const letters = new Map<string, string>();
        const runs: { p: string; n: number; person: number; tex: number; fromMin: number; toMin: number }[] = [];
        for (const event of events) {
          const people = typeof event.people === "string" ? event.people : "none";
          if (!letters.has(people)) letters.set(people, people === "none" ? "_" : String.fromCharCode(65 + letters.size));
          const p = letters.get(people)!;
          const min = typeof event.at === "number" ? Math.round((event.at - start) / 60_000) : -1;
          const last = runs[runs.length - 1];
          const run = last && last.p === p ? last : { p, n: 0, person: 0, tex: 0, fromMin: min, toMin: min };
          if (run !== last) runs.push(run);
          run.n += 1;
          run.toMin = min;
          if (event.from?.kind === "person") run.person += 1;
          if (event.from?.kind === "tex") run.tex += 1;
        }
        out.push({
          chat: folder.slice(0, 6),
          events: events.length,
          bytes: events.reduce((sum, event) => sum + event.bytes, 0),
          runs,
        });
      }
    }
    return { workspaces: bound.length, chats: out };
  },
});
