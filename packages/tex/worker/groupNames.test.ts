/**
 * The names a group's judge calls people by (`groupTurn.ts` `keepNames`/`keptNames`; Dev2, 2026-11-12).
 *
 * Sabotage record (2026-11-12): `keepNames` dropping guests → "a guest is kept by its label…" fails.
 */
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { keepNames, keptNames } from "./groupTurn";
import { sha256Hex } from "./groupChat";

describe("names kept for the judge", () => {
  it("a guest is kept by its label, and a handle wins over a label for the same phone", async () => {
    const storage = new MemoryStorage();
    await keepNames(storage, [{ phone: "+15550000001", handle: "rosa" }], [{ phone: "+15550000002", label: "guest-ab12" }, { phone: "+15550000001", label: "guest-cd34" }]);
    const names = await keptNames(storage);
    expect(names.get(await sha256Hex("+15550000002"))).toBe("guest-ab12");
    expect(names.get(await sha256Hex("+15550000001"))).toBe("rosa");
    expect([...names.values()].some((name) => name.includes("+1555"))).toBe(false);
  });
});
