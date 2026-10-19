import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { clearTold, noteTold, owedTold } from "./told";

/** THE FIXED TEXTS A TURN'S HISTORY IS OWED (`told.ts`): kept by name, dropped only once delivered. */
describe("told", () => {
  it("keeps what was sent in order, and drops only what a turn delivered", async () => {
    const storage = new MemoryStorage();
    await noteTold(storage, "setup");
    await noteTold(storage, "ready");
    const delivered = await owedTold(storage);
    expect(delivered).toEqual(["setup", "ready"]);
    // Noted while that turn ran: still owed to the next.
    await noteTold(storage, "ready_late");
    await clearTold(storage, delivered);
    expect(await owedTold(storage)).toEqual(["ready_late"]);
    await clearTold(storage, ["ready_late"]);
    expect(await owedTold(storage)).toEqual([]);
  });
});
