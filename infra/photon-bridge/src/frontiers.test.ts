import { describe, expect, it } from "vitest";
import { checkpointWrites } from "./frontiers";

describe("checkpointWrites", () => {
  it("writes a reported frontier that is ahead of the stored checkpoint, or has none yet", () => {
    expect(checkpointWrites({ "+15550100123": 1196 }, { "+15550100123": 1210 })).toEqual({ "+15550100123": 1210 });
    expect(checkpointWrites({}, { "+15550100123": 7 })).toEqual({ "+15550100123": 7 });
  });

  it("never moves a checkpoint backwards or leaves it where it is", () => {
    expect(checkpointWrites({ "+15550100123": 1210 }, { "+15550100123": 1196 })).toEqual({});
    expect(checkpointWrites({ "+15550100123": 1210 }, { "+15550100123": 1210 })).toEqual({});
  });

  it("writes only the lines that moved", () => {
    expect(
      checkpointWrites({ "+15550100123": 5, "+15550100999": 9 }, { "+15550100123": 6, "+15550100999": 9, "+15550100000": 1 }),
    ).toEqual({ "+15550100123": 6, "+15550100000": 1 });
  });

  it("refuses a frontier that is not a safe integer, and a malformed body", () => {
    expect(checkpointWrites({}, { a: 1.5, b: Number.NaN, c: 2 ** 60, d: "12", e: null, f: 3 })).toEqual({ f: 3 });
    expect(checkpointWrites({}, null)).toEqual({});
    expect(checkpointWrites({}, [1, 2])).toEqual({});
    expect(checkpointWrites({}, "checkpoints")).toEqual({});
    expect(checkpointWrites({}, undefined)).toEqual({});
  });
});
