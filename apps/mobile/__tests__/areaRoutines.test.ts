/**
 * AN AREA'S ROUTINES, AS THE SIDE PANEL DRAWS AND WRITES THEM (`areas/areaRoutines.ts`).
 *
 * Dev approved the artboards on 2026-11-27 ("please build end to end"). A routine is a note at
 * `<area>/routines/<how often>/<name>.md`; its row comes from that note's front matter and the workspace object's
 * state, and the editor writes the folder (Repeats), `on:`, `at:` (a list when there are several) and `paused:`.
 * Times are said in Eastern, on a 12-hour clock.
 */

import { describe, expect, test } from "@jest/globals";
import {
  areaBotOf,
  blankDraft,
  budgetOf,
  clockAt,
  draftChanges,
  draftOf,
  draftWords,
  folderOf,
  movedPath,
  newRoutineNote,
  pulsePlan,
  pulseTitles,
  readRoutineState,
  readTime,
  routineRows,
  withRepeats,
  type RoutineState,
} from "../features/console/files/folderPage/areas/areaRoutines";
import { areaTree } from "../features/console/files/folderPage/areas/seat";
import type { ListNote } from "../features/console/files/listBlock/model";

const note = (path: string, properties: Record<string, string | readonly string[]> = {}, heading?: string): ListNote => ({ path, properties, updatedAt: 1, ...(heading === undefined ? {} : { heading }) });

/** Friday 27 November 2026, 2:20 pm in New York. */
const NOW = Date.UTC(2026, 10, 27, 19, 20);
const ET = (day: number, hour: number, minute = 0) => Date.UTC(2026, 10, day, hour + 5, minute);
const AREA = "areas/finance";

const NOTES: ListNote[] = [
  note("areas/finance/about.md", { owner: "@dev", delegate: "Grok Bot", modes: ["Manager"] }),
  note("areas/finance/routines/daily/improve-your-metric.md", { at: "9am", template: "improve-your-metric" }, "Improve your metric"),
  note("areas/finance/routines/daily/manager-loop.md", { at: "10am", on: "weekdays", mode: "Manager" }, "Manager loop"),
  note("areas/finance/routines/daily/revenue-digest.md", { at: ["9am", "1pm", "5pm"] }),
  note("areas/finance/routines/monthly/month-end-close.md", { at: "4pm", paused: "true" }, "Month-end close"),
  note("areas/finance/routines/daily/pipeline.md", { at: "9ish" }),
  note("areas/finance/payroll/routines/daily/not-this-area.md", { at: "9am" }),
  note("areas/finance/pricing-notes.md"),
];

const STATE: RoutineState = {
  week: "2026-11-23",
  routines: [
    { path: "areas/finance/routines/daily/improve-your-metric.md", area: AREA, nextAt: ET(28, 9), lastAt: ET(27, 9), outcome: "sent", bot: "grok-bot", answeredAt: ET(27, 9, 14), problem: null },
    { path: "areas/finance/routines/daily/manager-loop.md", area: AREA, nextAt: ET(30, 10), lastAt: ET(27, 10), outcome: "held", bot: "grok-bot", answeredAt: null, problem: null },
  ],
  usage: [{ bot: "grok-bot", area: AREA, used: 12 }],
  checks: [],
};

describe("rows", () => {
  test("one per note in the area's own routines folder, named and said from its front matter", () => {
    const rows = routineRows(AREA, "areas", NOTES, null, NOW);
    expect(rows.map((row) => row.title)).toEqual(["Improve your metric", "Manager loop", "Pipeline", "Revenue digest", "Month-end close"]);
    const by = (title: string) => rows.find((row) => row.title === title)!;
    expect(by("Improve your metric").when).toBe("Every day at 9 am");
    expect(by("Manager loop")).toMatchObject({ when: "Weekdays at 10 am", mode: "Manager" });
    expect(by("Revenue digest").when).toBe("Every day at 9 am, 1 pm and 5 pm");
    expect(by("Month-end close")).toMatchObject({ when: "Monthly on the 1st at 4 pm", paused: true, next: null });
    // The routine format's own sentence, word for word.
    expect(by("Pipeline").problem).toBe(`"at: 9ish" isn't a time. Write it like 7:30 am or 19:00.`);
    // With no state to ask, the next run is worked out here and nothing is said of the last.
    expect(by("Improve your metric")).toMatchObject({ next: ET(28, 9), last: null });
    expect(by("Manager loop").next).toBe(ET(30, 10));
    expect(by("Revenue digest").next).toBe(ET(27, 17));
  });

  test("while the state loads, a row says nothing of its runs; once it answers, each says its own", () => {
    const loading = routineRows(AREA, "areas", NOTES, "loading", NOW);
    expect(loading[0]).not.toHaveProperty("next");
    expect(loading[0]).not.toHaveProperty("last");
    const rows = routineRows(AREA, "areas", NOTES, STATE, NOW);
    expect(rows[0]).toMatchObject({ next: ET(28, 9), last: { at: ET(27, 9), outcome: "sent", answeredAt: ET(27, 9, 14) } });
    expect(rows[1]!.last).toEqual({ at: ET(27, 10), outcome: "held", answeredAt: null });
    // One the state doesn't name has never run.
    expect(rows.find((row) => row.title === "Revenue digest")!.last).toEqual({ at: null, outcome: null, answeredAt: null });
  });

  test("the routines folder is the section, never one of the area's notes", () => {
    const tree = areaTree(AREA, "areas", NOTES);
    const files = tree.files.map((file) => file.path);
    expect(files).toContain("areas/finance/pricing-notes.md");
    expect(files).not.toContain("areas/finance/routines");
  });
});

describe("the gateway's answer", () => {
  test("is read by name, and anything not served is no state", () => {
    expect(readRoutineState({ served: false })).toBeNull();
    expect(readRoutineState(null)).toBeNull();
    const read = readRoutineState({
      served: true,
      week: "2026-11-23",
      routines: [{ path: "a/routines/daily/x.md", area: "a", nextAt: 5, lastAt: 4, outcome: "nope", bot: "b", answeredAt: null, extra: 1 }, { nopath: true }],
      usage: [{ bot: "b", area: "a", used: 20 }, { bot: "b" }],
      checks: [{ bot: "b", at: 9 }, { bot: "c" }],
    });
    expect(read).toEqual({ week: "2026-11-23", routines: [{ path: "a/routines/daily/x.md", area: "a", nextAt: 5, lastAt: 4, outcome: null, bot: "b", answeredAt: null, problem: null }], usage: [{ bot: "b", area: "a", used: 20 }], checks: [{ bot: "b", at: 9 }] });
  });
});

describe("the budget", () => {
  const isBot = (name: string) => name === "Grok Bot";
  test("goes to a bot owner, or a person owner's delegate bot, never Tex", () => {
    expect(areaBotOf("Grok Bot", null, isBot)).toBe("Grok Bot");
    expect(areaBotOf("@dev", "Grok Bot", isBot)).toBe("Grok Bot");
    expect(areaBotOf("@dev", "Tex", (name) => name !== "@dev")).toBeNull();
    expect(areaBotOf("@dev", null, isBot)).toBeNull();
    expect(areaBotOf(null, "Grok Bot", isBot)).toBeNull();
  });

  test("is the card's cap here against what the state says it used", () => {
    expect(budgetOf(AREA, "Grok Bot", ["areas/finance · 20%"], STATE)).toEqual({ bot: "Grok Bot", used: 12, cap: 20 });
    expect(budgetOf(AREA, "Grok Bot", ["areas/growth"], STATE)).toEqual({ bot: "Grok Bot", used: 12, cap: null });
    expect(budgetOf(AREA, "Grok Bot", undefined, { ...STATE, usage: [] })).toEqual({ bot: "Grok Bot", used: 0, cap: null });
    expect(budgetOf(AREA, "Grok Bot", undefined, null)).toEqual({ bot: "Grok Bot", used: null, cap: null });
    expect(budgetOf(AREA, "Grok Bot", undefined, "loading")).toBeUndefined();
    expect(budgetOf(AREA, null, undefined, STATE)).toBeNull();
  });
});

describe("times", () => {
  test("are Eastern, 12-hour, said from today", () => {
    expect(clockAt(ET(27, 10, 12), NOW)).toBe("today 10:12 am");
    expect(clockAt(ET(28, 9), NOW)).toBe("tomorrow 9 am");
    expect(clockAt(ET(26, 17, 9), NOW)).toBe("yesterday 5:09 pm");
    expect(clockAt(ET(30, 10), NOW)).toBe("Mon 10 am");
    expect(clockAt(ET(1, 16, 20), NOW)).toBe("Nov 1, 4:20 pm");
  });

  test("a typed time is read as the routine format reads it", () => {
    expect(readTime("2pm")).toBe("2 pm");
    expect(readTime("14:30")).toBe("2:30 pm");
    expect(readTime("9ish")).toBeNull();
  });
});

describe("drafts", () => {
  const manager = NOTES[2]!;
  test("a note's draft, and the sentence it reads as", () => {
    const draft = draftOf(manager, "Manager loop");
    expect(draft).toMatchObject({ name: "Manager loop", repeats: "Daily", folder: "daily", days: [0, 1, 2, 3, 4], times: ["10 am"], paused: false });
    expect(draftWords(AREA, "areas", draft)).toBe("Weekdays at 10 am");
    expect(draftOf(NOTES[3]!, "Revenue digest").times).toEqual(["9 am", "1 pm", "5 pm"]);
    expect(draftOf(NOTES[4]!, "Month-end close")).toMatchObject({ repeats: "Monthly", paused: true });
  });

  test("On, At and the switch write `on:`, `at:` (a list when several) and `paused:`", () => {
    const draft = draftOf(manager, "Manager loop");
    expect(draftChanges(draft, { ...draft, times: ["10 am", "2:30 pm"] })).toEqual([["at", ["10am", "2:30pm"]]]);
    expect(draftChanges(draft, { ...draft, days: [0, 2] })).toEqual([["on", "mon, wed"]]);
    expect(draftChanges(draft, { ...draft, days: [0, 1, 2, 3, 4, 5, 6] })).toEqual([["on", null]]);
    expect(draftChanges(draft, { ...draft, days: [5, 6] })).toEqual([["on", "weekends"]]);
    expect(draftChanges(draft, { ...draft, paused: true })).toEqual([["paused", "true"]]);
    expect(draftChanges({ ...draft, paused: true }, draft)).toEqual([["paused", null]]);
  });

  test("Repeats is the folder, so changing it moves the note", () => {
    const draft = draftOf(manager, "Manager loop");
    const weekly = withRepeats(draft, "Weekly");
    expect(folderOf(weekly)).toBe("weekly");
    expect(movedPath(manager.path, folderOf(weekly))).toBe("areas/finance/routines/weekly/manager-loop.md");
    const hourly = withRepeats(draft, "Hourly");
    expect(folderOf(hourly)).toBe("every-3-hours");
    expect(folderOf({ ...hourly, everyHours: 1 })).toBe("hourly");
    // Hourly has no days or times of its own.
    expect(draftChanges(draft, hourly)).toEqual([["on", null], ["at", null]]);
    // A folder Repeats still agrees with stays as it is.
    expect(folderOf({ ...draft, folder: "every-2-days" })).toBe("every-2-days");
    // Monthly's `on:` is a day of the month, so the weekdays go.
    expect(draftChanges(draft, withRepeats(draft, "Monthly"))).toEqual([["on", null]]);
  });

  test("Add writes the note with its schedule and its name as the heading", () => {
    const draft = { ...blankDraft(), name: "Pipeline check", days: [0, 1, 2, 3, 4], times: ["9 am", "1 pm", "5 pm"] };
    expect(draftWords(AREA, "areas", draft)).toBe("Weekdays at 9 am, 1 pm and 5 pm");
    expect(newRoutineNote(AREA, draft)).toEqual({
      path: "areas/finance/routines/daily/pipeline-check.md",
      text: "---\non: weekdays\nat: [9am, 1pm, 5pm]\n---\n# Pipeline check\n\n",
    });
    expect(newRoutineNote(AREA, blankDraft())).toEqual({ error: "Give the routine a name." });
    expect(newRoutineNote(AREA, { ...draft, times: Array.from({ length: 13 }, (_, i) => `${i + 1} am`) })).toHaveProperty("error");
  });
});

describe("pulse checks", () => {
  test("write the templates the modes ask for, keep any already there, and resume one a pulse paused", () => {
    expect(pulseTitles(["Manager"])).toEqual(["Improve metric loop", "Manager loop"]);
    const plan = pulsePlan(AREA, ["Manager", "Doer"], [
      note("areas/finance/routines/daily/improve-metric-loop.md", { at: "8am" }),
      note("areas/finance/routines/daily/manager-loop.md", { paused: "yes", template: "manager-loop" }),
    ]);
    expect(plan.resume).toEqual(["areas/finance/routines/daily/manager-loop.md"]);
    expect(plan.create.map((one) => one.path)).toEqual(["areas/finance/routines/daily/ship-the-next-item.md"]);
    expect(plan.create[0]!.text).toContain("# Ship the next item");
    // A paused note no template made is the person's: left alone.
    expect(pulsePlan(AREA, [], [note("areas/finance/routines/daily/improve-metric-loop.md", { paused: "true" })])).toEqual({ create: [], resume: [] });
  });
});

describe("a long bot name", () => {
  test("its usage is found under the mail name the workspace object counts it by", () => {
    const { budgetOf } = require("../features/console/files/folderPage/areas/areaRoutines");
    const state = { week: "2026-11-23", routines: [], usage: [{ bot: "tex-quality-tex-reply-qu", area: "areas/x", used: 7 }] };
    expect(budgetOf("areas/x", "Tex Quality · Tex reply quality", ["areas/x · 20%"], state)).toEqual({ bot: "Tex Quality · Tex reply quality", used: 7, cap: 20 });
  });
});
