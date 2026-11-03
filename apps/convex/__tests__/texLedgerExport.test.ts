/**
 * The person's chat with Tex in their Download as folders
 * (`functions/texLedgerExport.ts`): the one-to-one chat's ledger read through
 * the gateway's door (`apps/mcp/src/texStore/door.js`), a page at a time, for
 * its owner only.
 *
 * Sabotage, each confirmed to fail a case here (2026-11-02): drop the owner
 * check (a member reads the chat); answer `next: null` after the first page
 * (the rest is never read); drop the group chat's people check (an owner
 * reads a chat they are not in).
 */

import { createRequire } from "node:module";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { handleTexStoreDoor } from "../../mcp/src/texStore/door.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { texLedger } from "../../mcp/src/texStore/ledger.js";
import { serveTexStore } from "../../mcp/src/texStore/wire.js";
import { LEDGER_EXPORT_PAGE } from "../functions/texLedgerExport";
import { TEST_GATEWAY_SECRET, addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const GATEWAY = "https://gateway.example.invalid";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function durableSql() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query: string, ...binds: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const all = statement.all(...(binds as never[]));
        return { toArray: () => all };
      }
      statement.run(...(binds as never[]));
      return { toArray: () => [] };
    },
  };
}

async function chatted(entries: number) {
  const t = setupTest();
  const ownerId = await createUser(t, "ledger-owner@example.invalid");
  const memberId = await createUser(t, "ledger-member@example.invalid");
  const workspaceId = await createWorkspace(t, ownerId, "ledger-owner");
  await addMember(t, workspaceId, memberId, "member");
  const objects = new Map<string, ReturnType<typeof texObjects> & { ledger?: ReturnType<typeof texLedger> }>();
  const open = (name: string) => {
    if (!objects.has(name)) {
      const sql = durableSql();
      objects.set(name, Object.assign(texObjects(sql), { ledger: texLedger(sql) }));
    }
    return objects.get(name)!;
  };
  const env = {
    GATEWAY_SECRET: TEST_GATEWAY_SECRET,
    TEX_STORE: { idFromName: (name: string) => name, get: (placed: string) => ({ fetch: (request: Request) => serveTexStore(open(placed.replace(/^enam:/, "")), request) }) },
  };
  const controlPlane = {
    async openTexStoreTicket(ticket: string) {
      const response = await gatewayPost(t, "/gateway/tex-store/open", { ticket });
      return ((await response.json()) as { opened: { workspaceId: string; owners: string[] } | null }).opened;
    },
  };
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => await handleTexStoreDoor(new Request(url, init), env, { controlPlane }));
  const ledger = open(`person:${workspaceId}`).ledger!;
  for (let at = 0; at < entries; at += 100) {
    ledger.append("texts", Array.from({ length: Math.min(100, entries - at) }, (_, i) => ({ id: `e${at + i}`, kind: "text", at: 1_700_000_000_000 + at + i, text: `text ${at + i}` })));
  }
  return { t, ownerId, memberId, open, workspaceId, owner: asUser(t, ownerId), member: asUser(t, memberId) };
}

test("the owner reads their whole chat with Tex, page after page, oldest first, with its manifest", async () => {
  const f = await chatted(LEDGER_EXPORT_PAGE + 7);
  const first = await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId });
  expect(first.lines).toHaveLength(LEDGER_EXPORT_PAGE);
  expect(JSON.parse(first.manifest!)).toMatchObject({ schema: "tex-ledger", version: 1, chat: "texts", count: LEDGER_EXPORT_PAGE + 7 });
  expect(first.next).toBe(LEDGER_EXPORT_PAGE);
  const second = await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId, after: first.next! });
  expect(second.next).toBeNull();
  const texts = [...first.lines, ...second.lines].map((line) => JSON.parse(line).text);
  expect(texts).toEqual(Array.from({ length: LEDGER_EXPORT_PAGE + 7 }, (_, i) => `text ${i}`));
});

test("anyone but the owner is answered an empty, finished page", async () => {
  const f = await chatted(3);
  expect(await f.member.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId })).toEqual({ manifest: null, lines: [], next: null });
});

test("a person who never texted Tex has no ledger, and nothing is written", async () => {
  const f = await chatted(0);
  expect(await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId })).toEqual({ manifest: null, lines: [], next: null });
});

// A group chat's ledger rides its people's own exports (owner, 2026-11-02; `chat-ledger.md`), and nobody else's.
async function inGroups() {
  const f = await chatted(1);
  const outsiderId = await createUser(f.t, "ledger-outsider@example.invalid");
  const outsiderSpace = await createWorkspace(f.t, outsiderId, "ledger-outsider");
  const sharedId = await createWorkspace(f.t, f.ownerId, "ledger-team", { kind: "shared" });
  const mine = "a".repeat(64);
  const theirs = "b".repeat(64);
  await f.t.run(async (ctx) => {
    await ctx.db.insert("textGroups", { groupKey: mine, homeUsers: [f.ownerId, outsiderId], lastSeenAt: 1 } as never);
    await ctx.db.insert("textGroups", { groupKey: theirs, homeUsers: [outsiderId], lastSeenAt: 2 } as never);
  });
  f.open(`chat:${mine}`).ledger!.append(mine, [{ id: "g1", kind: "text", at: 1_700_000_000_000, text: "group text" }]);
  f.open(`chat:${theirs}`).ledger!.append(theirs, [{ id: "g2", kind: "text", at: 1_700_000_000_000, text: "not yours" }]);
  return { ...f, mine, theirs, sharedId, outsiderSpace, outsider: asUser(f.t, outsiderId) };
}

test("a person's export lists and reads the group chats they are in, and only those", async () => {
  const f = await inGroups();
  expect(await f.owner.action(api.functions.texLedgerExport.listChatLedgersForExport, { workspaceId: f.workspaceId })).toEqual({ chats: [f.mine] });
  const page = await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId, chat: f.mine });
  expect(page.lines.map((line) => JSON.parse(line).text)).toEqual(["group text"]);
  expect(JSON.parse(page.manifest!)).toMatchObject({ chat: f.mine, count: 1 });
  expect(await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId, chat: f.theirs })).toEqual({ manifest: null, lines: [], next: null });
});

test("a group chat rides only its people's personal exports: not a shared workspace's, not a member's", async () => {
  const f = await inGroups();
  expect(await f.owner.action(api.functions.texLedgerExport.listChatLedgersForExport, { workspaceId: f.sharedId })).toEqual({ chats: [] });
  expect(await f.owner.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.sharedId, chat: f.mine })).toEqual({ manifest: null, lines: [], next: null });
  expect(await f.member.action(api.functions.texLedgerExport.listChatLedgersForExport, { workspaceId: f.workspaceId })).toEqual({ chats: [] });
  expect(await f.member.action(api.functions.texLedgerExport.readChatLedgerForExport, { workspaceId: f.workspaceId, chat: f.mine })).toEqual({ manifest: null, lines: [], next: null });
  // The other person in the chat reads it from their own export.
  expect((await f.outsider.action(api.functions.texLedgerExport.listChatLedgersForExport, { workspaceId: f.outsiderSpace })).chats).toEqual([f.mine, f.theirs]);
});
