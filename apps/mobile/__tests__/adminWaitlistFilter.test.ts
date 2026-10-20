/**
 * The words beside the Waitlist's answer search, and the marking of the
 * term inside an answer. Pure helpers from `features/admin/waitlist.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import { editedAgo, filterSentence, highlightParts } from "../features/admin/waitlist";

describe("filterSentence", () => {
  test("counts people who mention the search", () => {
    expect(filterSentence("calendar", false, { matches: 7, capped: false }, 214)).toBe("7 people mention “calendar”");
    expect(filterSentence(" bills ", true, { matches: 1, capped: false }, 214)).toBe("1 person mentions “bills”");
  });

  test("says so when nothing matched", () => {
    expect(filterSentence("zebra", false, { matches: 0, capped: false }, 214)).toBe("No answers mention “zebra”.");
    expect(filterSentence("zebra", false, { matches: 0, capped: true }, 214)).toBe("No recent answers mention “zebra”.");
  });

  test("a scan cut short says at least", () => {
    expect(filterSentence("kids", false, { matches: 40, capped: true }, 9000)).toBe("At least 40 people mention “kids”");
    expect(filterSentence("", true, { matches: 40, capped: true }, 9000)).toBe("At least 40 people answered");
  });

  test("answered only counts against the list", () => {
    expect(filterSentence("", true, { matches: 131, capped: false }, 214)).toBe("131 of 214 answered");
    expect(filterSentence("", true, { matches: 2, capped: false }, null)).toBe("2 people answered");
  });

  test("no filter, no sentence", () => {
    expect(filterSentence("  ", false, { matches: 3, capped: false }, 3)).toBeNull();
  });
});

describe("highlightParts", () => {
  test("marks every match, ignoring case, and keeps the original letters", () => {
    expect(highlightParts("Calendar and calendar", "CALENDAR")).toEqual([
      { text: "Calendar", hit: true },
      { text: " and ", hit: false },
      { text: "calendar", hit: true },
    ]);
  });

  test("an empty or missing term marks nothing", () => {
    expect(highlightParts("anything", " ")).toEqual([{ text: "anything", hit: false }]);
    expect(highlightParts("anything", "zebra")).toEqual([{ text: "anything", hit: false }]);
  });
});

describe("editedAgo", () => {
  const now = Date.UTC(2026, 9, 20, 12);
  test("minutes, hours, then days", () => {
    expect(editedAgo(now - 30_000, now)).toBe("edited just now");
    expect(editedAgo(now - 5 * 60_000, now)).toBe("edited 5m ago");
    expect(editedAgo(now - 2 * 3_600_000, now)).toBe("edited 2h ago");
    expect(editedAgo(now - 3 * 86_400_000, now)).toBe("edited 3d ago");
  });
});
