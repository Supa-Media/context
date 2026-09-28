/**
 * A task's words: priority as Urgent…Low (never "P0" on screen), a due date
 * as Today or "Oct 3", tags from what the project uses, and `@name` in a
 * title resolved to one owner or to nobody — never a guess.
 */

import { describe, expect, test } from "@jest/globals";
import {
  cleanTag,
  dueLabel,
  duePreset,
  parseDueText,
  parseMention,
  priorityLabel,
  priorityOf,
  resolveMention,
  tagsInUse,
  toggleWord,
} from "../features/console/files/folderPage/tasks/taskWords";
import type { OwnerResults } from "../features/console/files/owners";

// Monday 28 September 2026, local time.
const NOW = new Date(2026, 8, 28, 15, 30);

describe("priority", () => {
  test("p0…p3 read as Urgent, High, Medium, Low; anything else is no priority", () => {
    expect(["p0", "P1", " p2 ", "p3"].map((value) => priorityLabel(priorityOf(value)))).toEqual(["Urgent", "High", "Medium", "Low"]);
    expect(priorityOf("p4")).toBeNull();
    expect(priorityOf(undefined)).toBeNull();
    expect(priorityLabel(null)).toBe("No priority");
  });
});

describe("due", () => {
  test("presets: today, tomorrow, and next week is the coming Monday", () => {
    expect(duePreset("today", NOW)).toBe("2026-09-28");
    expect(duePreset("tomorrow", NOW)).toBe("2026-09-29");
    expect(duePreset("next-week", NOW)).toBe("2026-10-05");
    expect(duePreset("next-week", new Date(2026, 9, 3))).toBe("2026-10-05");
    expect(duePreset("tomorrow", new Date(2026, 11, 31))).toBe("2027-01-01");
  });

  test("typed dates: ISO, Oct 3, 3 Oct, with a year; a past month-day is next year's", () => {
    expect(parseDueText("2026-10-03", NOW)).toBe("2026-10-03");
    expect(parseDueText("Oct 3", NOW)).toBe("2026-10-03");
    expect(parseDueText("3 october", NOW)).toBe("2026-10-03");
    expect(parseDueText("Jan 2", NOW)).toBe("2027-01-02");
    expect(parseDueText("Sep 28", NOW)).toBe("2026-09-28");
    expect(parseDueText("Feb 29 2028", NOW)).toBe("2028-02-29");
    for (const bad of ["", "soon", "Feb 30", "2026-13-01", "Oct", "32 Oct", "Oct 3 26"]) expect(parseDueText(bad, NOW)).toBeNull();
  });

  test("shown short: Today, Tomorrow, a weekday this week, else the month and day", () => {
    expect(dueLabel("2026-09-28", NOW)).toBe("Today");
    expect(dueLabel("2026-09-29", NOW)).toBe("Tomorrow");
    expect(dueLabel("2026-10-02", NOW)).toBe("Fri");
    expect(dueLabel("2026-10-05", NOW)).toBe("Oct 5");
    expect(dueLabel("2026-09-01", NOW)).toBe("Sep 1");
    expect(dueLabel("2027-01-02", NOW)).toBe("Jan 2, 2027");
  });
});

describe("tags", () => {
  test("the project's tags, most used first, one spelling each", () => {
    const notes = [
      { path: "p/a.md", properties: { tags: ["Kitchen", "bug"] } },
      { path: "p/b.md", properties: { tags: ["bug"] } },
      { path: "p/c.md", properties: { tags: "setup, kitchen" } },
      { path: "q/d.md", properties: { tags: ["elsewhere"] } },
    ];
    expect(tagsInUse(notes, "p")).toEqual(["Kitchen", "bug", "setup"]);
  });

  test("a tag is cleaned of a leading # and refused when a list can't hold it", () => {
    expect(cleanTag("  #bug ")).toBe("bug");
    expect(cleanTag("front  end")).toBe("front end");
    for (const bad of ["", "#", "a,b", "[x]", "it's", 'say "hi"', "a#b"]) expect(cleanTag(bad)).toBeNull();
  });

  test("toggling adds, and takes off ignoring case", () => {
    expect(toggleWord(["bug"], "Setup")).toEqual(["bug", "Setup"]);
    expect(toggleWord(["bug", "Setup"], "setup")).toEqual(["bug"]);
  });
});

describe("@name in a title", () => {
  test("the first @word is the mention, and the title is left without it", () => {
    expect(parseMention("Order the beans @Sayo")).toEqual({ title: "Order the beans", mention: "Sayo" });
    expect(parseMention("@seyi sign the lease")).toEqual({ title: "sign the lease", mention: "seyi" });
    expect(parseMention("Call @sayo.")).toEqual({ title: "Call .", mention: "sayo" });
    expect(parseMention("Email sayo@example.com")).toEqual({ title: "Email sayo@example.com", mention: null });
    expect(parseMention("just @")).toEqual({ title: "just @", mention: null });
  });

  const RESULTS: OwnerResults = {
    people: [
      { value: "@sayo", name: "Sayo Adé", isMe: true },
      { value: "@seyi", name: "Seyi Olujide", isMe: false },
      { value: "@seyi2", name: "Seyi Bello", isMe: false },
      { value: "John Adé", isMe: false },
    ],
    agents: ["Claude", "Codex"],
    truncated: false,
  };

  test("resolves a handle, a unique first name, or an agent", () => {
    expect(resolveMention("Sayo", RESULTS)).toBe("@sayo");
    expect(resolveMention("seyi", RESULTS)).toBe("@seyi");
    expect(resolveMention("john", RESULTS)).toBe("John Adé");
    expect(resolveMention("claude", RESULTS)).toBe("Claude");
  });

  test("nobody, rather than a guess, when two people or nobody fit", () => {
    const twoSeyis = { ...RESULTS, people: RESULTS.people.filter((person) => person.value !== "@seyi") .concat([{ value: "@olu", name: "Seyi Olu", isMe: false }]) };
    expect(resolveMention("seyi", twoSeyis)).toBeNull();
    expect(resolveMention("nobody", RESULTS)).toBeNull();
    expect(resolveMention("", RESULTS)).toBeNull();
  });
});
