// The census of the Worker's SenderInbox objects (`workerCensus.ts`), asked by id before the class is deleted (Dev2
// chose "sweep, then delete", 2026-11-22). What these prove: a moved object counts moved until its copy is cleared,
// then purged; an object with data and no move counts here, by kind from key names alone; nothing answered carries a
// key or a value; a malformed id or a failed ask counts failed, never moved.
//
// Sabotage (temporary local edits, reverted, 2026-11-22):
//   `censusOf` treating any PLACE_KEY as moved (ignoring movedTo)   "an object with data and no move is here" fails
//   `census` counting a failed ask as empty                          "a malformed id or a failed ask" fails
import { describe, expect, it } from "vitest";
import { census, censusOf, type ObjectCensus } from "./workerCensus";
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
    expect(await censusOf(storage({ [PLACE_KEY]: { arrivedAt: 5, keys: 3 }, history: "x", about: "y" }))).toEqual({ state: "here", keys: 2, kind: "chat" });
    expect(await censusOf(storage({ jobrun: {}, steps: [] }))).toEqual({ state: "here", keys: 2, kind: "job" });
    expect(await censusOf(storage({ chatwhere: { secret: "+15555550100" } }))).toEqual({ state: "here", keys: 1, kind: "directory" });
    expect(await censusOf(storage({ "gm:pending:x": 1, "gmove:told": 1 }))).toEqual({ state: "here", keys: 2, kind: "group-moves" });
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
    expect(counts).toEqual({ looked: 4, moved: 1, purged: 1, empty: 1, here: { chat: 0, job: 1, directory: 0, "group-moves": 0 }, hereIds: ["b".repeat(64)], failed: 3 });
    await expect(census(ask, Array(51).fill("a".repeat(64)))).rejects.toThrow(TypeError);
    await expect(census(ask, "a")).rejects.toThrow(TypeError);
  });
});
