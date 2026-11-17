import { describe, expect, it } from "vitest";
import { rememberText, threadUnder } from "./threads";
import { MemoryStorage } from "./memoryStorage.testing";

const DM = "photon:+15550000001:+15550000002";

describe("Photon 1:1: a check-in goes under the text it continues, as on Sendblue", () => {
  it("remembers a Photon text's guid and threads a check-in that continues it under that guid", async () => {
    const storage = new MemoryStorage();
    await rememberText(storage as never, DM, "8C7F0D2E-1B3A-4C5D-9E8F-0A1B2C3D4E5F", "can you hold the lane till 5?", 1_000);
    expect(await threadUnder(storage as never, DM, "can you hold the lane till 5?")).toBe("8C7F0D2E-1B3A-4C5D-9E8F-0A1B2C3D4E5F");
    expect(await threadUnder(storage as never, DM, "something else entirely")).toBeUndefined();
  });
});
