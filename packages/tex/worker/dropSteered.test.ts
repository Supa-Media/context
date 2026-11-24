/**
 * The asker's texts a group turn took in behind it are dropped from the queue and answered under their own message
 * (`groupModelTurn.ts` `dropSteered`; `packages/tex/gateway/agent/takenBehind.js`; bot battle, 2026-11-23: BRAVO-24
 * was answered once under ALPHA's prompt and again under its own).
 *
 * Sabotage record (2026-11-24), applied, run, observed failing, reverted:
 *  1. `dropSteered` matching only the line's event id, not the chat's → "a text named by the chat's own id…" fails.
 *  2. `dropSteered` not filling `messages` → "…and its part goes under its own message" fails.
 */
import { describe, expect, it } from "vitest";
import { dropSteered } from "./groupModelTurn";
import { MemoryStorage } from "./memoryStorage.testing";

describe("dropSteered", () => {
  it("a text named by the chat's own id is dropped, covered, and its part goes under its own message", async () => {
    const storage = new MemoryStorage();
    const bravo = { message: { eventId: "photon:message.received:bravo", messageId: "msg-bravo", text: "tex, burst test B" }, attempts: 0, at: 1_795_478_664_033, ev: "1795478664033-001658" };
    const other = { message: { eventId: "photon:message.received:other", messageId: "msg-other", text: "tex, mine?" }, attempts: 0, at: 1_795_478_665_000, ev: "1795478665000-001660" };
    await storage.put("gpending:1", bravo);
    await storage.put("gpending:2", other);
    const covers = ["1795478662794-001654"];
    const messages: Record<string, string> = { "1795478662794-001654": "msg-alpha" };
    const newest = await dropSteered(storage, ["1795478664033-001658"], covers, messages);
    expect(covers).toEqual(["1795478662794-001654", "1795478664033-001658"]);
    expect(messages["1795478664033-001658"]).toBe("msg-bravo");
    expect(newest).toBe(bravo.at);
    expect(await storage.get("gpending:1")).toBeUndefined();
    expect(await storage.get("gpending:2")).toBeDefined();
  });

  it("a steered text is still dropped by the line's event id", async () => {
    const storage = new MemoryStorage();
    await storage.put("gpending:1", { message: { eventId: "photon:x", messageId: "m" }, attempts: 0, ev: "1795478664033-000001" });
    await dropSteered(storage, ["photon:x"], []);
    expect(await storage.get("gpending:1")).toBeUndefined();
  });
});
