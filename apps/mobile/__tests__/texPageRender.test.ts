/**
 * @jest-environment jsdom
 */

/**
 * The Tex page ON THE GLASS, on the mock's data through the same source
 * interface the gateway answers: the mock's words, the chat picker switching
 * the whole page, a change made somewhere else arriving live on an open page,
 * a write from the page reaching the store and coming back, and a chat that is
 * not the person's showing nothing of it.
 *
 * ## Sabotage record
 *
 * Applied, run, named test seen failing, reverted (2026-11-02):
 *  1. `useTexPage` ignoring list patches → "a change made elsewhere shows up
 *     on the open page without a reload" fails.
 *  2. Stop wired to Tex's browser instead of the job (as first written) →
 *     "a job's page shows why a step failed and steers the job" fails.
 *  3. A check-in edit sending its unchanged text as well → "editing a
 *     check-in sends the gateway's time form, and only what changed" fails.
 *  4. The chat picker's list drawn inside the header again (as first written,
 *     painted under the tiles on the web) → "the chat picker switches the
 *     whole page to the group" fails.
 *
 * Applied, run, named test seen failing, reverted (2026-11-04):
 *  5. "Open full history" going to the History page without the hub's
 *     filters → "the hub's history opens the full page with its filters" fails.
 *  6. Tex's cloud's heading made a link like a machine's → "a connected
 *     machine's heading opens its settings; Tex's cloud's does not" fails.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider, type Metrics } from "react-native-safe-area-context";

jest.mock("../features/tex/history/useSeesTurnTiming", () => ({ useSeesTurnTiming: () => false }));
jest.mock("expo-router", () => ({ Redirect: () => null, Stack: () => null, router: { push: () => {} }, useLocalSearchParams: () => ({}) }));

import { TexPageBody, type Place } from "../features/tex/page/TexPageBody";
import { machineFixtureSource } from "../features/tex/page/texMachineFixture";
import { fixtureNow, fixtureSource } from "../features/tex/page/texPageFixture";
import type { TexPageSource } from "../features/tex/page/texPageSource";
import type { LedgerQuery, PageAction } from "../features/tex/page/texPageTypes";
import { useTexPage } from "../features/tex/page/useTexPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

let exits = 0;
function Harness({ source, start }: { source: TexPageSource; start: Place }) {
  const [place, setPlace] = useState<Place>(start);
  const page = useTexPage(source, place.chat);
  return createElement(TexPageBody, { source, page, place, go: setPlace, computer: null, openComputer: () => {}, exit: () => (exits += 1), now: fixtureNow });
}

const tick = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });

async function render(source: TexPageSource, start: Place = { chat: "me" }) {
  act(() => root.render(createElement(SafeAreaProvider, { initialMetrics: METRICS }, createElement(Harness, { source, start }))));
  await tick();
}

const text = () => container.textContent ?? "";
// A dropdown's list is drawn in a layer over the whole page (`TexSelect`), outside the page's own box.
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function press(id: string) {
  const el = byTestId(id);
  if (el === null) throw new Error(`no ${id}`);
  act(() => el.click());
  await tick();
}

describe("the Tex page", () => {
  test("draws the mock's first screen", async () => {
    await render(fixtureSource());
    for (const words of [
      "Working on 2 jobs · 1 needs you",
      "3 on · next 8:00",
      "History",
      "Standup at 10 and the dentist at 3.",
      "Open full history ›",
      "Minions · 2 of 3 busy",
      "3 steps didn't work",
      "Needs your sign-in code",
      "Ready for the next job",
      "Done · 20 min ago ›",
      "Show all 7 from this week",
      "Helped twice today · last: what to compare on maritime.sh",
      "Checked 3 emails today · 1 waiting for your yes",
    ]) {
      expect(text()).toContain(words);
    }
  });

  // In the app the hub had no way out (Dev2, 2026-11-06): the first screen leads back to the notes, a sub-page to Tex.
  test("the first screen has a way out", async () => {
    exits = 0;
    await render(fixtureSource());
    expect(byTestId("tex-exit")?.textContent).toBe("‹ Notes");
    await press("tex-exit");
    expect(exits).toBe(1);
  });

  test("a sub-page has no way out of Tex, only back to its first screen", async () => {
    await render(fixtureSource(), { chat: "me", view: "routines" });
    expect(byTestId("tex-exit")).toBeNull();
    expect(byTestId("tex-back")).not.toBeNull();
  });

  test("the chat picker switches the whole page to the group", async () => {
    await render(fixtureSource());
    await press("tex-chat-picker");
    // The list is drawn over the whole page, not inside the header, where the tiles after it painted over it.
    expect(byTestId("tex-chat-picker-menu")).not.toBeNull();
    expect(container.contains(byTestId("tex-chat-picker-menu"))).toBe(false);
    await press("tex-chat-picker-option-g-team");
    expect(text()).toContain("Tex in Team Night");
    expect(text()).toContain("5 people · working on 1 job");
    expect(text()).toContain("I'll bring snacks to standup");
    expect(text()).not.toContain("maritime");
  });

  test("the hub's history opens the full page with its filters", async () => {
    await render(fixtureSource());
    expect(byTestId("tex-history-mini-box")).not.toBeNull();
    // The same lines as the History page, thinking off until asked for.
    expect(text()).not.toContain("Look at today's calendar");
    await press("tex-history-show-thinking");
    expect(text()).toContain("Look at today's calendar");
    expect(text()).toContain("2 tool calls");
    await press("tex-history-show-tools");
    expect(text()).not.toContain("2 tool calls");
    await press("tex-history-open-full");
    expect(byTestId("tex-history")).not.toBeNull();
    expect(byTestId("tex-history-mini-box")).toBeNull();
    // Thinking still on, tool calls still off.
    expect(text()).toContain("Look at today's calendar");
    expect(text()).not.toContain("2 tool calls");
  });

  test("a connected machine's heading opens its settings; Tex's cloud's does not", async () => {
    await render(machineFixtureSource("full"));
    expect(byTestId("tex-pool-settings-cloud")).toBeNull();
    expect(byTestId("tex-pool-settings-m-mbp")?.textContent).toContain("Settings ›");
    await press("tex-pool-settings-m-mbp");
    expect(byTestId("tex-pool")).toBeNull();
    expect(text()).toContain("Your machines");
  });

  test("a chat that is not yours shows nothing of it", async () => {
    await render(fixtureSource(), { chat: "g-someone-elses" });
    expect(byTestId("tex-page-notice")).not.toBeNull();
    expect(text()).not.toContain("Minions");
  });

  test("a change made elsewhere shows up on the open page without a reload", async () => {
    const source = fixtureSource();
    await render(source, { chat: "me", view: "routines" });
    expect(text()).toContain("Gym nudge");
    // Somebody else, or Tex itself, removes the routine: the page's copy is not touched.
    await act(async () => {
      await source.act("me", { type: "routine.remove", id: "r4" });
    });
    await tick();
    expect(text()).not.toContain("Gym nudge");
    expect(text()).toContain("Morning brief");
  });

  test("an edit to About the group by another member arrives live", async () => {
    const source = fixtureSource();
    await render(source, { chat: "g-team", view: "about" });
    expect(text()).toContain("Cy doesn't eat sushi.");
    await act(async () => {
      await source.act("g-team", { type: "about.fix", line: "g2", text: "Cy eats sushi now." });
    });
    await tick();
    expect(text()).toContain("Cy eats sushi now.");
  });

  test("switching a routine off from the page changes the store and the page", async () => {
    const source = fixtureSource();
    const sent: PageAction[] = [];
    const watched: TexPageSource = { ...source, act: (chat, a) => (sent.push(a), source.act(chat, a)) };
    await render(watched, { chat: "me", view: "routines" });
    const toggle = container.querySelector('[role="switch"]') as HTMLElement;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    await tick();
    expect(sent).toEqual([{ type: "routine.toggle", id: "r1", on: false }]);
    const stored = await source.list("me", "routines");
    expect(stored.kind === "ok" && stored.value.items[0]!.on).toBe(false);
    expect((container.querySelector('[role="switch"]') as HTMLElement).getAttribute("aria-checked")).toBe("false");
  });

  test("editing a check-in sends the gateway's time form, and only what changed", async () => {
    const source = fixtureSource();
    const sent: PageAction[] = [];
    await render({ ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) }, { chat: "me", view: "checkins" });
    const when = byTestId("tex-checkin-form-c1-when") as HTMLInputElement;
    expect(when.value).toBe("2026-11-02 21:30");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(when, "2026-11-02 22:00");
      when.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("tex-checkin-form-c1-save");
    expect(sent).toEqual([{ type: "checkin.edit", id: "c1", when: "2026-11-02 22:00" }]);
  });

  test("a job's page shows why a step failed and steers the job", async () => {
    const source = fixtureSource();
    const sent: PageAction[] = [];
    await render({ ...source, act: async (chat, a) => (sent.push(a), source.act(chat, a)) }, { chat: "me", job: "maritime" });
    expect(text()).toContain("Research maritime.sh for managing Tex's agents");
    await press("tex-why-0");
    expect(text()).toContain("the page took too long to load");
    await press("tex-report-0");
    expect(sent).toContainEqual({ type: "report", job: "maritime", step: 0 });
    const input = byTestId("tex-steer-input") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setValue.call(input, "skip the blog");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press("tex-steer-send");
    expect(sent).toContainEqual({ type: "steer", job: "maritime", text: "skip the blog" });
    await press("tex-stop");
    expect(sent).toContainEqual({ type: "stop", job: "maritime" });
  });

  test("a job's page shows what it did: its own lines from the chat's history, none of the chat's", async () => {
    const source = fixtureSource();
    const asked: LedgerQuery[] = [];
    await render({ ...source, ledger: (chat, q) => (asked.push(q), source.ledger(chat, q)) }, { chat: "me", job: "maritime" });
    expect(asked.at(-1)?.job).toBe("maritime");
    const work = byTestId("tex-job-work")?.textContent ?? "";
    expect(work).toContain("2 tool calls · browse ×2 · 1 failed");
    expect(work).toContain("advisor · Pricing page is the one to read");
    expect(work).not.toContain("Standup at 10");
    expect(byTestId("tex-history-show-jobs")).toBeNull();
  });
});
