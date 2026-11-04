/**
 * @jest-environment jsdom
 */

/**
 * The minion characters (Dev2, 2026-11-04): a busy minion is the calm # Tex
 * holding what its job is doing now, read from the step it is on, so the
 * figure changes as the job goes.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-04):
 *  1. `activityOf` reading the job's title instead of its step → "the step a
 *     job is on picks its character" fails.
 *  2. The card drawing `Figure` for busy slots again → "a busy card swaps its
 *     character as a new step arrives" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Minion } from "../features/tex/page/TexHome";
import { HOLD_MS, MINION_PROPS, activityOf, stepTool, type Activity } from "../features/tex/page/minionProps";
import type { JobSummary } from "../features/tex/page/texPageTypes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const job = (over: Partial<JobSummary> = {}): JobSummary => ({ id: "j", title: "Find flights to Lisbon", state: "running", startedAt: 0, failedSteps: 0, ...over });

describe("what a minion is doing", () => {
  test("the step a job is on picks its character", () => {
    const cases: [string, Activity][] = [
      ["search_web: flights to Lisbon", "researching"],
      ["search action: lisbon", "researching"],
      ["read_email: from Dana", "researching"],
      ["fetch: projects/trip.md", "researching"],
      ["browse: thecut.co", "browsing"],
      ["browse: click, type (failed)", "browsing"],
      ["fill_card: checkout", "browsing"],
      ["write_note: trips/lisbon.page.md", "writing"],
      ["write save: notes/a.md", "writing"],
      ["save_email_draft: Dana", "writing"],
      ["move_folder: projects/", "building"],
      ["manage move: a.md", "building"],
      ["make_picture: birthday card", "painting"],
      ["draw_visual: map", "painting"],
      ["send_email: Dana (waiting for their yes)", "sending"],
      ["calendar_event create: Haircut", "planning"],
      ["read_calendar: this week", "planning"],
      ["ask_advisor: is this done?", "thinking"],
      ["some_new_tool: x", "working"],
    ];
    for (const [now, activity] of cases) expect([now, activityOf(job({ now, title: "Write a song" }))]).toEqual([now, activity]);
  });

  test("a job with no step yet is thinking; one waiting on the person asks; one on their computer codes", () => {
    expect(activityOf(job())).toBe("thinking");
    expect(activityOf(job({ now: "  " }))).toBe("thinking");
    expect(activityOf(job({ state: "waiting", now: "browse: thecut.co", needs: "Pick a time" }))).toBe("waiting");
    expect(activityOf(job({ machine: "m1", now: "Bash npm test" }))).toBe("coding");
    expect(activityOf(job({ tool: "Codex" }))).toBe("coding");
  });

  test("the tool is the step's first word, whatever follows it", () => {
    expect(stepTool("search_web: x")).toBe("search_web");
    expect(stepTool("write_note save: x")).toBe("write_note");
    expect(stepTool("Claude Code edit src/a.ts")).toBe("claude");
    expect(stepTool(": nothing")).toBe("");
  });

  test("every prop is drawn inside the card's square, and the plain # has none", () => {
    for (const [activity, prop] of Object.entries(MINION_PROPS)) {
      for (const part of [...prop.still, ...prop.moving]) {
        // Absolute points only (relative moves are small): every absolute coordinate sits in the 100 box.
        for (const [, x, y] of part.d.matchAll(/[MLQ]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
          expect([activity, Number(x) >= 0 && Number(x) <= 100 && Number(y) >= 0 && Number(y) <= 100]).toEqual([activity, true]);
        }
      }
    }
    expect(MINION_PROPS.working.still.length + MINION_PROPS.working.moving.length).toBe(0);
  });
});

describe("a minion card", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });
  const later = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
  const figure = (activity: string) => container.querySelector(`[data-testid="tex-minion-figure-cloud-1-${activity}"]`);
  const draw = (now?: string) =>
    act(() => root.render(createElement(Minion, { slot: { slot: 1, job: job(now ? { now } : {}) }, now: 60_000, wide: false, go: () => {} })));

  test("a busy card swaps its character as a new step arrives", () => {
    draw();
    expect(figure("thinking")).not.toBeNull();
    later(HOLD_MS);
    draw("search_web: lisbon hotels");
    expect(figure("researching")).not.toBeNull();
    expect(figure("thinking")).toBeNull();
    later(HOLD_MS);
    draw("browse: booking.com");
    expect(figure("browsing")).not.toBeNull();
  });

  test("a quick run of steps doesn't flicker: the character holds, then shows the latest", () => {
    draw("search_web: lisbon hotels");
    draw("fetch: a.md");
    draw("write_note: trips/lisbon.page.md");
    draw("browse: booking.com");
    expect(figure("researching")).not.toBeNull();
    later(HOLD_MS - 1);
    expect(figure("researching")).not.toBeNull();
    later(1);
    expect(figure("browsing")).not.toBeNull();
  });

  test("waiting on the person shows at once, and a step that didn't work makes the # sweat", () => {
    draw("browse: thecut.co");
    act(() =>
      root.render(createElement(Minion, { slot: { slot: 1, job: job({ state: "waiting", needs: "Pick a time", failedSteps: 1 }) }, now: 60_000, wide: false, go: () => {} })),
    );
    expect(figure("waiting")).not.toBeNull();
    expect(figure("trouble")).not.toBeNull();
  });

  test("the card's words say what the picture shows", () => {
    draw("search_web: lisbon hotels");
    expect(container.textContent).toContain("Researching · 1\u00a0min");
    expect(container.querySelector('[aria-label^="Minion 1: Find flights to Lisbon. Researching · 1 min"]')).not.toBeNull();
  });

  test("a free card stays the dimmed plain #", () => {
    act(() => root.render(createElement(Minion, { slot: { slot: 1, job: null }, now: 0, wide: false, go: () => {} })));
    expect(container.querySelector('[data-testid^="tex-minion-figure-cloud-1-"]')).toBeNull();
    expect(container.querySelector('[data-testid="tex-minion-figure-cloud-1"]')).not.toBeNull();
  });
});
