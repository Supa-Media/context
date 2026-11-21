import { describe, expect, test } from "@jest/globals";
import { dayLabels } from "../features/tex/chat/appChatDays";

const at = (y: number, m: number, d: number, h: number) => new Date(y, m - 1, d, h).getTime();

describe("app chat day labels", () => {
  const now = new Date(2026, 10, 21, 9);
  test("labels the first line of each day, Yesterday then Today", () => {
    const lines = [{ at: at(2026, 11, 20, 8) }, { at: at(2026, 11, 20, 9) }, { at: at(2026, 11, 21, 7) }, { at: at(2026, 11, 21, 8) }];
    const labels = dayLabels(lines, now);
    expect([...labels.values()]).toEqual(["Yesterday", "Today"]);
    expect(labels.get(lines[0]!)).toBe("Yesterday");
    expect(labels.get(lines[2]!)).toBe("Today");
    expect(labels.has(lines[1]!)).toBe(false);
  });
  test("names an older day by its date", () => {
    expect([...dayLabels([{ at: at(2026, 11, 14, 12) }], now).values()]).toEqual(["Saturday, Nov 14"]);
  });
  test("draws nothing for an empty chat", () => {
    expect(dayLabels([], now).size).toBe(0);
  });
});
