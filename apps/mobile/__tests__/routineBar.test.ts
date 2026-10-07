/**
 * @jest-environment jsdom
 *
 * A ROUTINE NOTE'S RUN BAR, ITS RECENT RUNS, AND THE ONE EDIT IT MAKES.
 *
 * The bar reads the schedule from the note's own text (so it changes as
 * somebody types) and the last run from the control plane's row, and Pause
 * writes `paused: yes` into the file through the Properties panel's one-line
 * front matter write — the file stays the whole truth
 * (`docs/decisions/routines.md`).
 *
 * SABOTAGE: make `routineBarView` ignore `settings.paused` for `canRun` and
 * "Run now is off while the file says paused" fails; make `pauseEdit` write
 * `paused: no` instead of removing the line and "Resume removes the line,
 * and only that line" fails.
 */

import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { pauseEdit, routineBarView, runWhen, runWords, WRITER_GONE_WORDS, type RoutineRow } from "../features/console/routines/model";
import { timeZoneToStore } from "../features/console/routines/TimeZoneSync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RoutineBar, NoteRoutineBar } =
  require("../features/console/routines/RoutineBar") as typeof import("../features/console/routines/RoutineBar");
const { RunList } =
  require("../features/console/routines/RecentRuns") as typeof import("../features/console/routines/RecentRuns");
const { RoutineHostFixture } =
  require("../features/console/routines/RoutineHost") as typeof import("../features/console/routines/RoutineHost");

const PATH = "routines/daily/morning-brief.md";
const TEXT = "---\nat: 7:30 am\n---\nText me what's due today.\n";
const NOW = new Date(2026, 9, 7, 12, 0).getTime();
const HOUR = 60 * 60 * 1000;

function row(extra: Partial<RoutineRow> = {}): RoutineRow {
  return { paused: false, send: "text", nextRunAt: NOW + HOUR, lastRunAt: NOW - 2 * HOUR, lastOutcome: "answered", ...extra };
}

function view(text = TEXT, r: RoutineRow | null | undefined = row(), path: string | null = PATH) {
  return routineBarView({ path, text, row: r, now: NOW });
}

function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  const el = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    host,
    el,
    text: (id: string) => el(id)?.textContent ?? null,
    done: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("the bar's words", () => {
  test("a note outside routines/ gets no bar", () => {
    expect(view(TEXT, row(), "1-projects/plan.md")).toEqual({ kind: "none" });
    expect(view(TEXT, row(), null)).toEqual({ kind: "none" });
  });

  test("a note under routines/ that will never run says why, in one quiet line", () => {
    const loose = view(TEXT, null, "routines/morning.md");
    expect(loose).toEqual({ kind: "unscheduled", line: "Put it in a folder that says how often, like routines/daily/." });
    const odd = view(TEXT, null, "routines/sometimes/morning.md");
    expect(odd.kind).toBe("unscheduled");
  });

  test("the schedule comes from the note's own front matter, so it follows typing", () => {
    expect(view()).toMatchObject({ kind: "bar", schedule: "Every day at 7:30 am" });
    expect(view("---\nat: 9 am\non: weekdays\n---\nGo.\n")).toMatchObject({ schedule: "Weekdays at 9 am" });
  });

  test("the last run, with a check when it went well and an x when it did not", () => {
    expect(view()).toMatchObject({ last: "Last ran 2 hours ago", mark: "ok", canRun: true });
    expect(view(TEXT, row({ lastOutcome: "skipped" }))).toMatchObject({ mark: "ok" });
    expect(view(TEXT, row({ lastOutcome: "failed" }))).toMatchObject({ mark: "failed" });
    expect(view(TEXT, row({ lastOutcome: "no_chat" }))).toMatchObject({ mark: "failed" });
  });

  test("not run yet, and nothing at all while the control plane has not answered", () => {
    expect(view(TEXT, row({ lastRunAt: null, lastOutcome: null }))).toMatchObject({ last: "Not run yet", mark: null });
    expect(view(TEXT, null)).toMatchObject({ last: "Not run yet", canRun: false });
    expect(routineBarView({ path: PATH, text: TEXT, row: undefined, now: NOW })).toMatchObject({ last: "", canRun: false });
  });

  test("Run now is off while the file says paused", () => {
    const paused = view("---\nat: 7:30 am\npaused: yes\n---\nGo.\n");
    expect(paused).toMatchObject({ last: "Paused", paused: true, canRun: false });
    // The row can lag the file; the file wins as soon as it is typed.
    expect(view(TEXT, row({ paused: true }))).toMatchObject({ paused: false, canRun: false });
  });

  test("a writer who lost access is said plainly, and cannot be run", () => {
    expect(view(TEXT, row({ lastOutcome: "writer_gone" }))).toMatchObject({
      last: WRITER_GONE_WORDS,
      mark: "failed",
      canRun: false,
    });
  });

  test("a line it can't read comes back as the shared module's sentence", () => {
    const bad = view("---\nat: half seven\n---\nGo.\n");
    expect(bad.kind === "bar" && bad.problems).toEqual([`"at: half seven" isn't a time. Write it like 7:30 am or 19:00.`]);
  });
});

describe("Pause and Resume edit the file's front matter", () => {
  test("Pause adds the line and keeps every other line as it was", () => {
    const source = "---\nat: 7:30 am\nsend: text\n---\nText me what's due.\n";
    const paused = pauseEdit(source, true);
    expect(paused).toEqual({ text: "---\nat: 7:30 am\nsend: text\npaused: yes\n---\nText me what's due.\n" });
  });

  test("Resume removes the line, and only that line", () => {
    const source = "---\nat: 7:30 am\npaused: yes\nsend: text\n---\nText me what's due.\n";
    expect(pauseEdit(source, false)).toEqual({ text: "---\nat: 7:30 am\nsend: text\n---\nText me what's due.\n" });
  });

  test("a note with no front matter yet gets a block holding just the line", () => {
    expect(pauseEdit("Text me what's due.\n", true)).toEqual({ text: "---\npaused: yes\n---\n\nText me what's due.\n" });
  });

  test("`paused: no` becomes yes rather than a second line", () => {
    expect(pauseEdit("---\npaused: no\n---\nGo.\n", true)).toEqual({ text: "---\npaused: yes\n---\nGo.\n" });
  });
});

describe("the bar on screen", () => {
  test("schedule, last run and both buttons", () => {
    const bar = mount(createElement(RoutineBar, { view: view(), gutter: 0, onRunNow: async () => null, onPause: () => null }));
    expect(bar.text("routine-schedule")).toBe("Every day at 7:30 am");
    expect(bar.text("routine-last")).toBe("Last ran 2 hours ago");
    expect(bar.el("routine-mark-ok")).not.toBeNull();
    expect(bar.text("routine-run-now")).toBe("Run now");
    expect(bar.el("routine-run-now")?.getAttribute("aria-disabled")).not.toBe("true");
    expect(bar.text("routine-pause")).toBe("Pause");
    expect(bar.el("routine-quiet")).toBeNull();
    bar.done();
  });

  test("paused: Run now is off and the other button says Resume", () => {
    const bar = mount(
      createElement(RoutineBar, {
        view: view("---\npaused: yes\n---\nGo.\n"),
        gutter: 0,
        onRunNow: async () => null,
        onPause: () => null,
      }),
    );
    expect(bar.text("routine-last")).toBe("Paused");
    expect(bar.el("routine-run-now")?.getAttribute("aria-disabled")).toBe("true");
    expect(bar.text("routine-pause")).toBe("Resume");
    bar.done();
  });

  test("someone who can only read sees the schedule and no buttons", () => {
    const bar = mount(createElement(RoutineBar, { view: view(), gutter: 0 }));
    expect(bar.text("routine-schedule")).toBe("Every day at 7:30 am");
    expect(bar.el("routine-run-now")).toBeNull();
    expect(bar.el("routine-pause")).toBeNull();
    bar.done();
  });

  test("problems and an unscheduled note's reason are one quiet line", () => {
    const bad = mount(createElement(RoutineBar, { view: view("---\nsend: shout\n---\nGo.\n"), gutter: 0 }));
    expect(bad.text("routine-quiet")).toBe(`"send: shout" should be text, note or both.`);
    bad.done();
    const loose = mount(createElement(RoutineBar, { view: view(TEXT, null, "routines/morning.md"), gutter: 0 }));
    expect(loose.text("routine-quiet")).toContain("routines/daily/");
    expect(loose.el("routine-schedule")).toBeNull();
    loose.done();
  });

  test("Pause goes through the editor's change path and writes paused: yes", () => {
    let note = TEXT;
    const host = {
      path: PATH,
      row: row(),
      runs: [],
      canEdit: true,
      runNow: async () => null,
    };
    const bar = mount(
      createElement(
        RoutineHostFixture,
        { value: host },
        createElement(NoteRoutineBar, {
          text: note,
          gutter: 0,
          onEdit: (change) => {
            const changed = change(note);
            if ("error" in changed) return changed.error;
            note = changed.text;
            return null;
          },
        }),
      ),
    );
    act(() => bar.el("routine-pause")!.click());
    expect(note).toBe("---\nat: 7:30 am\npaused: yes\n---\nText me what's due today.\n");
    bar.done();
  });

  test("with no control plane above it, a routine note draws no bar", () => {
    const bar = mount(createElement(NoteRoutineBar, { text: TEXT, gutter: 0 }));
    expect(bar.el("routine-bar")).toBeNull();
    bar.done();
  });
});

describe("recent runs", () => {
  test("each run in plain words, with what it texted", () => {
    const runs = [
      { at: NOW - HOUR, outcome: "answered", text: "Due: Ferris proposal." },
      { at: NOW - 25 * HOUR, outcome: "skipped", text: "" },
      { at: NOW - 49 * HOUR, outcome: "finished", text: "The launch shipped." },
      { at: NOW - 73 * HOUR, outcome: "failed", text: "" },
    ];
    const list = mount(createElement(RunList, { runs, send: "text", now: NOW }));
    const labels = [...list.host.querySelectorAll('[data-testid="routine-run-label"]')].map((el) => el.textContent);
    expect(labels).toEqual(["Texted", "Skipped", "Finished", "Failed"]);
    expect(list.host.textContent).toContain("Due: Ferris proposal.");
    expect(list.host.textContent).toContain("The launch shipped.");
    expect(list.host.textContent).toContain("Nothing worth saying, so no text.");
    list.done();
  });

  test("none yet says so", () => {
    const list = mount(createElement(RunList, { runs: [], send: "text", now: NOW }));
    expect(list.text("routine-runs-empty")).toBe("No runs yet.");
    list.done();
  });

  test("when, in words", () => {
    expect(runWhen(new Date(2026, 9, 7, 7, 30).getTime(), NOW)).toBe("Today, 7:30 am");
    expect(runWhen(new Date(2026, 9, 6, 19, 5).getTime(), NOW)).toBe("Yesterday, 7:05 pm");
    expect(runWhen(new Date(2026, 9, 4, 7, 30).getTime(), NOW)).toBe("Sunday, 7:30 am");
    expect(runWhen(new Date(2026, 8, 3, 0, 15).getTime(), NOW)).toBe("3 Sep, 12:15 am");
  });

  test("an answer kept as a note is not called a text", () => {
    expect(runWords({ at: 0, outcome: "answered", text: "x" }, "note").label).toBe("Answered");
  });
});

describe("the time zone routines fall back to", () => {
  test("is written only when the stored one has arrived and differs", () => {
    expect(timeZoneToStore(undefined, "Europe/London")).toBeNull();
    expect(timeZoneToStore("Europe/London", "Europe/London")).toBeNull();
    expect(timeZoneToStore("Europe/London", null)).toBeNull();
    expect(timeZoneToStore(null, "Europe/London")).toBe("Europe/London");
    expect(timeZoneToStore("America/New_York", "Europe/London")).toBe("Europe/London");
  });
});
