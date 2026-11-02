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
