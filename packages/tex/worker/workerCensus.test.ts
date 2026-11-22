// The census of the Worker's SenderInbox objects (`workerCensus.ts`), asked by id before the class is deleted (Dev2
// chose "sweep, then delete", 2026-11-22). What these prove: a moved object counts moved until its copy is cleared,
// then purged; an object with data and no move counts here, by kind from key names alone; nothing answered carries a
// key or a value; a malformed id or a failed ask counts failed, never moved.
//
// Sabotage (temporary local edits, reverted, 2026-11-22):
//   `censusOf` treating any PLACE_KEY as moved (ignoring movedTo)   "an object with data and no move is here" fails
//   `census` counting a failed ask as empty                          "a malformed id or a failed ask" fails
//   `census` dropping `nameAt` (no `named` index)                    "an object still here answers the index ..." fails
//   `adoptable` keeping a name without checking its id                "a 1:1 object works out its own name ..." fails
import { describe, expect, it } from "vitest";
import { adoptable, census, censusOf, maskKey, namesById, selfNames, type ObjectCensus } from "./workerCensus";
import { PLACE_KEY } from "./inboxMove";

function storage(seed: Record<string, unknown>) {
  const map = new Map(Object.entries(seed));
  return { get: async <T,>(key: string) => map.get(key) as T | undefined, list: async () => new Map(map) };
}

describe("a Worker object's census", () => {
  it("moved until its copy is cleared, then purged", async () => {
    expect(await censusOf(storage({ [PLACE_KEY]: { movedTo: "gateway", movedAt: 1, purgeAt: 2 }, history: 1 }))).toEqual({ state: "moved", keys: 0 });
    expect(await censusOf(storage({ [PLACE_KEY]: { movedTo: "gateway", movedAt: 1, purgeAt: 2, purgedAt: 3 } }))).toEqual({ state: "purged", keys: 0 });
  });

  it("an object with data and no move is here, by kind from key names alone", async () => {
    expect(await censusOf(storage({}))).toEqual({ state: "empty", keys: 0 });
    expect(await censusOf(storage({ [PLACE_KEY]: { arrivedAt: 5, keys: 3 }, history: "x", about: "y" }))).toEqual({ state: "here", keys: 2, kind: "chat", shape: ["about", "history"] });
    expect(await censusOf(storage({ jobrun: {}, steps: [] }))).toEqual({ state: "here", keys: 2, kind: "job", shape: ["jobrun", "steps"] });
    expect(await censusOf(storage({ chatwhere: { secret: "+15555550100" } }))).toEqual({ state: "here", keys: 1, kind: "directory", shape: ["chatwhere"] });
    expect(await censusOf(storage({ "gm:pending:x": 1, "gmove:told": 1 }))).toEqual({ state: "here", keys: 2, kind: "group-moves", shape: ["gm:pending:x", "gmove:told"] });
    expect(JSON.stringify(await censusOf(storage({ chatwhere: { secret: "+15555550100" } })))).not.toContain("5555");
  });

  it("a malformed id or a failed ask counts failed, never moved; ids of objects here come back", async () => {
    const answers: Record<string, ObjectCensus | Error> = {
      ["a".repeat(64)]: { state: "moved", keys: 0 },
      ["b".repeat(64)]: { state: "here", keys: 4, kind: "job" },
      ["c".repeat(64)]: new Error("down"),
      ["d".repeat(64)]: { state: "purged", keys: 0 },
    };
    const ask = async (id: string) => {
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer ?? { state: "empty" as const, keys: 0 };
    };
    const counts = await census(ask, [...Object.keys(answers), "e".repeat(64), "../x", 7]);
    expect(counts).toEqual({ looked: 4, moved: 1, purged: 1, empty: 1, here: { chat: 0, job: 1, directory: 0, "group-moves": 0 }, hereIds: ["b".repeat(64)], hereObjects: [{ id: "b".repeat(64), kind: "job", keys: 4, shape: [] }], failed: 3 });
    await expect(census(ask, Array(51).fill("a".repeat(64)))).rejects.toThrow(TypeError);
    await expect(census(ask, "a")).rejects.toThrow(TypeError);
  });
});

describe("telling which chat an object still here is, without a name crossing back", () => {
  it("key names are masked: a phone, an id, an email and any long run", () => {
    expect(maskKey("gm:alias:+15555550100")).toBe("gm:alias:#");
    expect(maskKey("evfull:c0ffee00c0ffee00")).toBe("evfull:#");
    expect(maskKey("mail:someone@example.invalid")).toBe("#@#");
    expect(maskKey("group:AbCdEfGhIjKlMnOpQr")).toBe("group:#");
    expect(maskKey("gstate")).toBe("gstate");
    expect(maskKey("seen:sendblue:7CD1E2F3-A0E5-4B3C-9D8E-1F2A3B4C5D6E")).toBe("seen:sendblue:#");
    const shape = (maskKey("x".repeat(60)) + maskKey("pending:" + "5".repeat(10))).length;
    expect(shape).toBeLessThan(60);
  });

  it("an object still here answers the index of the candidate name it was made from", async () => {
    const idOf = (name: string) => (name === "+15555550100" ? "a".repeat(64) : name === "group-key:x" ? "b".repeat(64) : "f".repeat(64));
    const byId = namesById(["+15555550199", "+15555550100", "group-key:x", 7, ""], idOf);
    const ask = async () => ({ state: "here" as const, keys: 1, kind: "chat" as const, shape: ["history"] });
    const counts = await census(ask, ["a".repeat(64), "c".repeat(64)], (id) => byId.get(id));
    expect(counts.hereObjects).toEqual([
      { id: "a".repeat(64), kind: "chat", keys: 1, shape: ["history"], named: 1 },
      { id: "c".repeat(64), kind: "chat", keys: 1, shape: ["history"] },
    ]);
    expect(JSON.stringify(counts)).not.toContain("5555");
    expect(() => namesById(Array(2001).fill("x"), idOf)).toThrow(TypeError);
  });
});

describe("a 1:1 object no known name matches", () => {
  it("works out its own name from the chat it last answered, and keeps it only when its id is the object's", async () => {
    const chat = (chatId: unknown) => ({ get: async <T,>(key: string) => (key === "chat" ? ({ chatId, at: 1 } as T) : undefined) });
    expect(await selfNames(chat("sendblue:+15555550199:+15555550100"))).toEqual(["+15555550199", "+15555550100"]);
    expect(await selfNames(chat("whapi:15555550100@s.whatsapp.net"))).toEqual(["+15555550100", "15555550100@s.whatsapp.net"]);
    expect(await selfNames(chat("sendblue:+15555550199:someone@example.invalid"))).toEqual(["+15555550199", "someone@example.invalid"]);
    expect(await selfNames(chat("sendblue:../x:a b"))).toEqual([]);
    expect(await selfNames(chat(7))).toEqual([]);
    expect(await selfNames({ get: async () => undefined })).toEqual([]);
    const idOf = (name: string) => (name === "+15555550100" ? "a".repeat(64) : "f".repeat(64));
    const here = [
      { id: "a".repeat(64), kind: "chat" as const, keys: 8, shape: [] },
      { id: "b".repeat(64), kind: "chat" as const, keys: 8, shape: [] },
      { id: "c".repeat(64), kind: "chat" as const, keys: 8, shape: [], named: 0 },
      { id: "d".repeat(64), kind: "directory" as const, keys: 1, shape: [] },
    ];
    const asked: string[] = [];
    const found = await adoptable(here, async (id) => (asked.push(id[0]), ["+15555550199", "+15555550100"]), idOf);
    expect(found).toEqual([{ id: "a".repeat(64), name: "+15555550100" }]);
    expect(asked).toEqual(["a", "b"]);
  });
});
