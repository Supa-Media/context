import { describe, expect, test } from "vitest";
import { copyChatIn } from "../functions/texLedgerBackfill";

/**
 * The sweep that copies a quiet person's old chat into their ledger
 * (`functions/texLedgerBackfill.ts`), so the old copies can go. The copy-in
 * itself is the gateway's (`apps/mcp/test/chatLedgerBackfill.test.mjs`); this
 * holds the sweep to running it to the end, once.
 *
 * Sabotage record (2026-11-02): `copyChatIn` running one part only → "a long
 * chat goes in part after part, then is done".
 */

type Entry = { id: string; at: number; kind: string };

/** A store with `events` old log events and a ledger that keeps what is put before it. */
function storeWith(events: number) {
  const ledger: Entry[] = [];
  const at = Date.UTC(2026, 9, 1);
  const keys = Array.from({ length: events }, (_, n) => `.context/agent/log/abc/${String(at + n * 1000).padStart(13, "0")}-${String(n).padStart(6, "0")}.json`);
  const store = {
    list: async ({ prefix }: { prefix: string }) => ({ objects: keys.filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    get: async (key: string) => {
      const n = keys.indexOf(key);
      if (n < 0) return null;
      const id = key.slice(key.lastIndexOf("/") + 1, -5);
      return { text: async () => JSON.stringify({ id, at: Number(id.slice(0, 13)), chat: "chat-1", from: { kind: "person" }, kind: "text", text: `text ${n}` }) };
    },
    texLedger: () => ({
      oldest: async () => (ledger.length === 0 ? null : ledger[0]),
      prepend: async (_chat: string, entries: Entry[]) => (ledger.unshift(...entries), { added: entries.length }),
      read: async () => ({ entries: ledger }),
    }),
  };
  return { store, ledger };
}

describe("a quiet chat is copied into its ledger by the sweep", () => {
  test("a short chat goes in at once, marked done, and a second run copies nothing", async () => {
    const { store, ledger } = storeWith(3);
    expect(await copyChatIn(store, { dryRun: false })).toMatchObject({ state: "finished" });
    expect(ledger[0].id).toBe("backfilledv1");
    const size = ledger.length;
    expect(await copyChatIn(store, { dryRun: false })).toEqual({ state: "done", entries: 0 });
    expect(ledger.length).toBe(size);
  });

  test("a long chat goes in part after part, then is done", async () => {
    const { store, ledger } = storeWith(900);
    expect(await copyChatIn(store, { dryRun: false })).toMatchObject({ state: "finished" });
    expect(ledger[0].id).toBe("backfilledv1");
    expect(ledger.filter((entry) => entry.kind === "text").length).toBe(900);
  });

  test("a dry run writes nothing", async () => {
    const { store, ledger } = storeWith(3);
    expect((await copyChatIn(store, { dryRun: true })).state).toBe("would");
    expect(ledger).toEqual([]);
  });

  test("a store with no ledger is left alone", async () => {
    expect(await copyChatIn({}, { dryRun: false })).toEqual({ state: "none", entries: 0 });
  });
});

describe("a quiet group chat's old log is found and copied into its ledger", () => {
  const LINE = "+15555550199";
  const OTHER = "+15555550198";
  const GROUP_ID = "group-1";

  /** A shared workspace's store holding one group's log, a person's chat folder, and a ledger per chat key. */
  async function sharedStore() {
    const { groupKeyOf } = await import("../functions/textGroups");
    const { sha256Hex } = await import("../../mcp/src/ingestion/inbox.js");
    const groupFolder = await sha256Hex(GROUP_ID);
    const otherFolder = await sha256Hex("someone-else");
    const at = Date.UTC(2026, 9, 1);
    const events = new Map<string, string>();
    for (let n = 0; n < 3; n += 1) {
      const id = `${String(at + n * 1000).padStart(13, "0")}-${String(n).padStart(6, "0")}`;
      events.set(`.context/agent/log/${groupFolder}/${id}.json`, JSON.stringify({ id, at: at + n * 1000, chat: GROUP_ID, from: { kind: "person" }, kind: "text", text: `group text ${n}` }));
    }
    const lone = `${String(at).padStart(13, "0")}-000000`;
    events.set(`.context/agent/log/${otherFolder}/${lone}.json`, JSON.stringify({ id: lone, at, chat: "someone-else", from: { kind: "person" }, kind: "text", text: "not a group" }));
    const ledgers = new Map<string, Entry[]>();
    const store = {
      list: async ({ prefix }: { prefix: string }) => ({ objects: [...events.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
      get: async (key: string) => (events.has(key) ? { text: async () => events.get(key)! } : null),
      texLedger: (chat: string | null) => {
        if (chat === null) return null;
        const ledger = ledgers.get(chat) ?? [];
        ledgers.set(chat, ledger);
        return {
          oldest: async () => (ledger.length === 0 ? null : ledger[0]),
          prepend: async (_chat: string, entries: Entry[]) => (ledger.unshift(...entries), { added: entries.length }),
          read: async () => ({ entries: ledger }),
        };
      },
    };
    return { store, ledgers, groupKey: await groupKeyOf(LINE, GROUP_ID) };
  }

  test("its folder is matched to its chat by Tex's line, and the person's folder is left alone", async () => {
    const { groupsInStore } = await import("../functions/texLedgerBackfillGroups");
    const { store, groupKey } = await sharedStore();
    expect(await groupsInStore(store, [OTHER, LINE], new Set([groupKey]))).toEqual({ found: [{ groupKey, logChat: GROUP_ID }], unmatched: 1 });
    expect(await groupsInStore(store, [OTHER], new Set([groupKey]))).toEqual({ found: [], unmatched: 2 });
  });

  test("its log is looked for in the pin too, where a group with a home and no bound workspace texted", async () => {
    // Crystal Care Agency's, 2026-11-03: its log was never read, so its memory page waited.
    const { logPlaces } = await import("../functions/texLedgerBackfillGroups");
    const id = (name: string) => name as never;
    const plan = { pin: id("pin"), chats: [{ groupKey: "a", bound: null, homed: true }, { groupKey: "b", bound: id("team"), homed: false }], workspaces: [{ id: id("team"), slug: "team", paths: [] }] };
    expect(logPlaces(plan).sort()).toEqual(["pin", "team"]);
    expect(logPlaces({ ...plan, pin: null })).toEqual(["team"]);
  });

  test("its log goes into its own ledger under the group's mark, once", async () => {
    const { store, ledgers, groupKey } = await sharedStore();
    expect(await copyChatIn(store, { dryRun: false, group: groupKey, logChat: GROUP_ID })).toMatchObject({ state: "finished" });
    const ledger = ledgers.get(groupKey)!;
    expect(ledger[0].id).toBe("backfilledv2");
    expect(ledger.filter((entry) => entry.kind === "text").length).toBe(3);
    expect(await copyChatIn(store, { dryRun: false, group: groupKey, logChat: GROUP_ID })).toEqual({ state: "done", entries: 0 });
  });
});
