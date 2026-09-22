import { describe, expect, test } from "@jest/globals";
import { presenceChipLabel } from "../features/console/ConsoleShell";

const member = (id: string, name: string) => ({
  id,
  name,
  color: "#8b5cf6",
  anchor: null,
  head: null,
  canWrite: true,
  isAgent: false,
});

describe("presence chip copy", () => {
  test("names one remote editor and distinguishes it from the current person", () => {
    expect(
      presenceChipLabel({ phase: "live", summary: "1 here", members: [member("m1", "@ana")] }),
    ).toBe("@ana · 1 other here");
  });

  test("names the first two remote editors and keeps the total count", () => {
    expect(
      presenceChipLabel({
        phase: "live",
        summary: "3 here",
        members: [member("m1", "@ana"), member("m2", "@bo"), member("m3", "@cy")],
      }),
    ).toBe("@ana, @bo +1 · 3 others here");
  });

  test("does not claim stale names while reconnecting", () => {
    expect(
      presenceChipLabel({ phase: "reconnecting", summary: "Reconnecting", members: [member("m1", "@ana")] }),
    ).toBe("Reconnecting");
  });
});
