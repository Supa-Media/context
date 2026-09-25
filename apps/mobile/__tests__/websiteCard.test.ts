/**
 * @jest-environment jsdom
 *
 * Settings › Website, the switch card, in every state it can be in.
 *
 * What this holds: the card draws the server's view and never decides it — an
 * owner gets the switch, a member gets the state and no control (absent, not
 * disabled); both switches arm and say what they do before doing it; turning
 * on names the one file it may add and that nothing outside the folder goes
 * live; turning off says the folder and the domain stay; a failed switch is
 * said in words.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { WebsiteStateView } from "@context/shared";
import { WebsiteCard } from "../features/console/settings/panels/WebsiteCard";
import type { WebsiteActions, WebsiteCardView } from "../features/console/website/useWebsite";
import { describeWebsiteFailure, websiteAddress, websiteWarning } from "../features/console/website/website";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(view: WebsiteCardView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(createElement(WebsiteCard, { view, origin: "https://context.lc" })));
  return container;
}

const off = (canManage = true): WebsiteStateView => ({
  contractVersion: 1,
  state: "disabled",
  root: "website",
  handlePath: "/@acme/",
  canManage,
});
const on = (canManage = true): WebsiteStateView => ({ ...off(canManage), state: "enabled", enabledAt: 1 }) as WebsiteStateView;

const actions = (fail?: Error): WebsiteActions => ({
  enable: jest.fn(async () => {
    if (fail) throw fail;
  }) as WebsiteActions["enable"],
  disable: jest.fn(async () => {
    if (fail) throw fail;
  }) as WebsiteActions["disable"],
});

const button = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-testid="website-switch"]');
const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};

describe("the words", () => {
  test("the address is the origin and the handle, whole and short", () => {
    expect(websiteAddress("https://context.lc/", "/@acme/")).toEqual({
      url: "https://context.lc/@acme",
      short: "context.lc/@acme",
    });
  });

  test("turning on names the file it may add and what stays private", () => {
    expect(websiteWarning(off(), "context.lc/@acme")).toBe(
      "Pages in the website folder go live at context.lc/@acme. Nothing outside it is published. If there's no homepage, website/index.md is created.",
    );
  });

  test("turning off says nothing is deleted", () => {
    expect(websiteWarning(on(), "context.lc/@acme")).toMatch(/website folder, domain and share links are kept/);
  });

  test("a refusal is the owner rule; anything else is a retry", () => {
    expect(describeWebsiteFailure({ data: { code: "FORBIDDEN" } }, true)).toMatch(/Only an owner/);
    expect(describeWebsiteFailure(new Error("boom"), true)).toMatch(/didn't turn on/);
    expect(describeWebsiteFailure(new Error("boom"), false)).toMatch(/didn't turn off/);
  });
});

describe("the card", () => {
  test("off, an owner sees where it would open and one button", () => {
    const root = mount({ state: off(), failed: false, actions: actions() });
    expect(root.textContent).toContain("Your site will open at context.lc/@acme");
    expect(root.querySelector('[data-testid="website-pill"]')?.textContent).toBe("Off");
    expect(button(root)?.textContent).toBe("Turn on");
  });

  test("turning on arms first, says what happens, then calls the server once", async () => {
    const act1 = actions();
    const root = mount({ state: off(), failed: false, actions: act1 });
    await press(button(root)!);
    expect(act1.enable).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="website-warning"]')?.textContent).toMatch(/website\/index\.md/);
    expect(button(root)?.textContent).toBe("Confirm");
    await press(button(root)!);
    expect(act1.enable).toHaveBeenCalledTimes(1);
  });

  test("live, the address can be copied and opened, and turned off after a warning", async () => {
    const act1 = actions();
    const root = mount({ state: on(), failed: false, actions: act1 });
    expect(root.querySelector('[data-testid="website-pill"]')?.textContent).toBe("Live");
    expect(root.textContent).toContain("https://context.lc/@acme");
    expect(root.querySelector('[data-testid="website-open"]')).not.toBeNull();
    await press(button(root)!);
    expect(act1.disable).not.toHaveBeenCalled();
    expect(root.querySelector('[data-testid="website-warning"]')?.textContent).toMatch(/stops showing pages/);
    await press(button(root)!);
    expect(act1.disable).toHaveBeenCalledTimes(1);
  });

  test("a member sees the state and no switch at all", () => {
    for (const state of [off(false), on(false)]) {
      const root = mount({ state, failed: false });
      expect(button(root)).toBeNull();
      expect(root.textContent).toMatch(/Only an owner of this workspace can change its website/);
    }
  });

  test("a failed switch is said in words", async () => {
    const root = mount({ state: off(), failed: false, actions: actions(new Error("storage")) });
    await press(button(root)!);
    await press(button(root)!);
    expect(root.textContent).toMatch(/didn't turn on/);
  });

  test("a view that failed to load says so instead of guessing a state", () => {
    const root = mount({ state: undefined, failed: true });
    expect(root.textContent).toMatch(/Couldn't load this workspace's website/);
    expect(button(root)).toBeNull();
  });
});
