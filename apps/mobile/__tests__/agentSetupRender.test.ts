/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

/**
 * The guide's screens, drawn: one action per screen, a count in the bar, no
 * button to press while the page is waiting on the other app, and the
 * stalled screens saying what to try.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AGENT_SETUP_PREVIEWS, type AgentSetupPreviewKey } from "../features/agentSetup/previews";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(key: AgentSetupPreviewKey, over: Record<string, unknown> = {}) {
  const { Component, props } = AGENT_SETUP_PREVIEWS[key];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(Component, { ...props, ...over }));
  });
  // A Modal draws into a portal on the body, not into the container.
  const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    byId,
    text: () => document.body.textContent ?? "",
    press: (id: string) =>
      act(() => {
        const target = byId(id);
        if (target === null) throw new Error(`nothing to press: ${id}`);
        target.click();
      }),
    done: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the connect steps", () => {
  test("step one names where to go, counts 1 of 6, and has no Back", () => {
    const guide = draw("guide-claude-open");
    expect(guide.text()).toContain("Connect Claude to @seyi");
    expect(guide.byId("agent-setup-count")?.textContent).toBe("1 of 6");
    expect(guide.text()).toContain("Settings › Connectors");
    expect(guide.byId("agent-setup-back")).toBeNull();
    expect(guide.byId("agent-setup-next")?.textContent).toBe("I'm there");
    guide.done();
  });

  test("Next and Back call through", () => {
    const calls: string[] = [];
    const guide = draw("guide-claude-add", { onNext: () => calls.push("next"), onBack: () => calls.push("back") });
    expect(guide.text()).toContain("Remote MCP server URL");
    guide.press("agent-setup-next");
    guide.press("agent-setup-back");
    expect(calls).toEqual(["next", "back"]);
    guide.done();
  });

  test("sign-in has nothing to press: it moves on when the grant lands", () => {
    const guide = draw("guide-claude-signin");
    expect(guide.byId("agent-setup-next")).toBeNull();
    expect(guide.text()).toContain("Waiting for you to approve");
    expect(guide.text()).toContain("@seyi");
    guide.done();
  });

  test("always allow names both tool groups and opens Claude's connectors", () => {
    const guide = draw("guide-claude-allow");
    expect(guide.byId("agent-setup-count")?.textContent).toBe("4 of 6");
    expect(guide.text()).toContain("Read-only tools");
    expect(guide.text()).toContain("Write/delete tools");
    expect(guide.text()).toContain("Always allow");
    expect(guide.byId("agent-setup-open-allow")).not.toBeNull();
    guide.done();
  });

  test("make it stick names the agent's own field and hands over the instruction", () => {
    const claude = draw("guide-claude-stick");
    expect(claude.text()).toContain("Settings › Account");
    expect(claude.text()).toContain("Instructions for Claude");
    expect(claude.text()).toContain("call orient");
    expect(claude.byId("agent-setup-open-stick")?.textContent).toContain("Open Account settings");
    claude.done();
    const gpt = draw("guide-chatgpt-stick");
    expect(gpt.text()).toContain("Anything else ChatGPT should know about you?");
    expect(gpt.byId("agent-setup-open-stick")).not.toBeNull();
    gpt.done();
  });

  test("ChatGPT's free plan is pointed at Claude rather than a dead end", () => {
    const calls: string[] = [];
    const guide = draw("guide-chatgpt-devmode", { onSwitchAgent: () => calls.push("switch") });
    expect(guide.text()).toContain("Set up Claude instead");
    guide.done();
  });
});

describe("bringing it over", () => {
  test("pick: four topics, personal life off, one primary", () => {
    const guide = draw("guide-claude-bring");
    expect(guide.byId("agent-setup-topic-personal")?.getAttribute("aria-checked")).toBe("false");
    expect(guide.byId("agent-setup-topic-work")?.getAttribute("aria-checked")).toBe("true");
    expect(guide.byId("agent-setup-copy-open")?.textContent).toBe("Copy and open Claude");
    guide.done();
  });

  test("live: notes as they land, and only the quiet copy-again", () => {
    const guide = draw("guide-claude-bring-live");
    expect(guide.text()).toContain("Writing notes");
    expect(guide.byId("agent-setup-written")?.textContent).toContain("context-lc");
    expect(guide.byId("agent-setup-copy-open")).toBeNull();
    expect(guide.byId("agent-setup-copy-again")).not.toBeNull();
    expect(guide.byId("agent-setup-later")).toBeNull();
    guide.done();
  });

  test("stalled: what to try, and the prompt one press away", () => {
    // jsdom has no window width, so this is the phone's foot: Back, one
    // button, and ✕ for "later".
    const guide = draw("guide-claude-nothing");
    expect(guide.text()).toContain("Still stuck?");
    expect(guide.text()).toContain("Start a new chat");
    expect(guide.byId("agent-setup-copy-again")).not.toBeNull();
    expect(guide.byId("agent-setup-later")).toBeNull();
    guide.done();
  });

  test("done lists every note and finishes; little memory says why", () => {
    const done = draw("guide-claude-done");
    expect(done.text()).toContain("Claude is set up");
    expect(done.text()).toContain("6 notes");
    expect(done.byId("agent-setup-count")).toBeNull();
    expect(done.byId("agent-setup-finish")).not.toBeNull();
    done.done();
    const little = draw("guide-claude-little");
    expect(little.text()).toContain("Capabilities");
    expect(little.byId("agent-setup-run-again")).not.toBeNull();
    little.done();
  });
});
