/**
 * @jest-environment jsdom
 */

/**
 * Settings › Check-ins, quiet hours and more (Dev2, 2026-11-13): the settings
 * Tex changes by text, as switches. Each change goes to the gateway as the
 * Tex page's `setting.set`, the handler a text uses, and a refused one is put
 * back and said.
 *
 * ## Sabotage record
 *
 *  1. The optimistic value kept after a refusal. → `a refused change goes back and says why` fails.
 *  2. `setting.set` sent for a group chat's key instead of "me". → every test reading `sent` fails.
 *  3. Quiet hours "Turn off" sending "" instead of "off". → `quiet hours save the words, and turn off` fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({ useConvex: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TexHabitsFrom } from "../features/console/settings/panels/TexHabits";
import type { TexPageSource } from "../features/tex/page/texPageSource";
import type { PageAction, TexHabits } from "../features/tex/page/texPageTypes";

let root: Root | null = null;
let host: HTMLElement | null = null;
const sent: { chat: string; action: PageAction }[] = [];
let refuse: string | null = null;

function source(habits: TexHabits | null): TexPageSource {
  return {
    list: async () => (habits === null ? { kind: "failed" } : { kind: "ok", value: { items: [], habits } }),
    act: async (chat: string, action: PageAction) => {
      sent.push({ chat, action });
      return refuse === null ? { ok: true } : { ok: false, error: refuse };
    },
  } as unknown as TexPageSource;
}

const START: TexHabits = { checkins: true, quietHours: "", pings: "strict", overnight: true, tidy: false };

async function render(habits: TexHabits | null = START) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(TexHabitsFrom, { source: source(habits) }));
  });
  return host;
}

function byTestId(id: string): HTMLElement {
  const found = host!.querySelector(`[data-testid="${id}"]`);
  if (found === null) throw new Error(`no ${id}`);
  return found as HTMLElement;
}

const press = (id: string) => act(async () => byTestId(id).click());

async function type(id: string, words: string) {
  const box = byTestId(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(box), "value")!.set!.call(box, words);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  sent.length = 0;
  refuse = null;
});

describe("Settings › Check-ins, quiet hours and more", () => {
  test("every by-text setting shows its value", async () => {
    const view = await render({ ...START, quietHours: "11 pm to 7 am" });
    expect(byTestId("tex-habit-checkins").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("tex-habit-quiet-value").textContent).toBe("11 pm to 7 am");
    expect(byTestId("tex-habit-pings-value").textContent).toBe("Important");
    expect(byTestId("tex-habit-overnight").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("tex-habit-tidy").getAttribute("aria-checked")).toBe("false");
    expect(view.textContent).not.toContain("Text Tex");
  });

  test("a switch sends its setting for their own chat and shows the new value", async () => {
    await render();
    await press("tex-habit-checkins");
    await press("tex-habit-tidy");
    expect(sent).toEqual([
      { chat: "me", action: { type: "setting.set", key: "checkins", value: false } },
      { chat: "me", action: { type: "setting.set", key: "tidy", value: true } },
    ]);
    expect(byTestId("tex-habit-checkins").getAttribute("aria-checked")).toBe("false");
    expect(byTestId("tex-habit-tidy").getAttribute("aria-checked")).toBe("true");
  });

  test("quiet hours save the words, and turn off", async () => {
    await render();
    expect(byTestId("tex-habit-quiet-value").textContent).toBe("None");
    await press("tex-habit-quiet-change");
    await type("tex-habit-quiet-field", "10 pm to 6 am");
    await press("tex-habit-quiet-save");
    expect(sent.at(-1)).toEqual({ chat: "me", action: { type: "setting.set", key: "quiet_hours", value: "10 pm to 6 am" } });
    expect(byTestId("tex-habit-quiet-value").textContent).toBe("10 pm to 6 am");
    await press("tex-habit-quiet-change");
    await press("tex-habit-quiet-off");
    expect(sent.at(-1)).toEqual({ chat: "me", action: { type: "setting.set", key: "quiet_hours", value: "off" } });
    expect(byTestId("tex-habit-quiet-value").textContent).toBe("None");
  });

  test("texts from other AIs pick one of four levels", async () => {
    await render();
    await press("tex-habit-pings-change");
    await press("tex-habit-pings-emergencies");
    expect(sent.at(-1)).toEqual({ chat: "me", action: { type: "setting.set", key: "pings", value: "emergencies" } });
    expect(byTestId("tex-habit-pings-value").textContent).toBe("Emergencies only");
  });

  test("a refused change goes back and says why", async () => {
    await render();
    refuse = "invalid";
    await press("tex-habit-quiet-change");
    await type("tex-habit-quiet-field", "whenever");
    await press("tex-habit-quiet-save");
    expect(byTestId("tex-habit-quiet-value").textContent).toBe("None");
    expect(byTestId("tex-habits-unsaved").textContent).toContain("11 pm to 7 am");
    refuse = "failed";
    await press("tex-habit-overnight");
    expect(byTestId("tex-habit-overnight").getAttribute("aria-checked")).toBe("true");
    expect(byTestId("tex-habits-unsaved").textContent).toBe("Not saved. Try again.");
  });

  test("an unreadable read says so instead of drawing guesses", async () => {
    const view = await render(null);
    expect(byTestId("tex-habits-failed")).toBeTruthy();
    expect(view.querySelector('[data-testid="tex-habits"]')).toBeNull();
  });
});
