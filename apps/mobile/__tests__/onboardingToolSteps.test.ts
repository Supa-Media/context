/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { ConnectionsContainer, ToolsLiveContainer } from "../features/onboarding/steps/ToolsSteps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Connections and Tools-live steps, mounted against a fake control plane.
 *
 * `onboardingTools.test.ts` proves the rules; this proves the containers feed
 * them the real subscription — `grants.listGrants`, for the context the first
 * run made — and that a guide is a place you go and come back from.
 */

function clientAnswering(grants: unknown) {
  const watch = (ref: never) => ({
    localQueryResult: () => (getFunctionName(ref) === "functions/grants:listGrants" ? grants : undefined),
    onUpdate: () => () => {},
    journal: () => undefined,
  });
  return {
    watchQuery: watch,
    mutation: async () => ({}),
    action: async () => ({}),
  } as never;
}

function mount(node: ReturnType<typeof createElement>, grants: unknown) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(ConvexProvider, { client: clientAnswering(grants) }, node));
  });
  return {
    text: () => container.textContent ?? "",
    press: (label: string) => {
      const button = [...container.querySelectorAll('[role="button"]')].find(
        (element) => element.textContent === label,
      );
      if (!button) throw new Error(`no button labelled ${label}`);
      act(() => {
        (button as HTMLElement).click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const CLAUDE_USED = [{ clientId: "c1", clientName: "Claude", status: "active", lastUsedAt: 10 }];

describe("the Connections step, live", () => {
  test("a tool that has used its grant shows as connected", () => {
    const view = mount(createElement(ConnectionsContainer, { workspaceId: "w1" as never, onContinue: () => {} }), CLAUDE_USED);
    expect(view.text()).toContain("Connected");
    expect(view.text()).toContain("Continue");
    view.unmount();
  });

  test("a guide opens, and Back returns to the list", () => {
    const view = mount(createElement(ConnectionsContainer, { workspaceId: "w1" as never, onContinue: () => {} }), []);
    view.press("Set up");
    expect(view.text()).toContain("Done — Claude is set");
    view.press("Back");
    expect(view.text()).toContain("Clients we have a guide for");
    view.unmount();
  });
});

describe("the live check, live", () => {
  test("waits until a tool has made a call", () => {
    const view = mount(createElement(ToolsLiveContainer, { workspaceId: "w1" as never, onContinue: () => {} }), []);
    expect(view.text()).toContain("Waiting for a first call");
    view.unmount();
  });

  test("is live once one has", () => {
    const view = mount(createElement(ToolsLiveContainer, { workspaceId: "w1" as never, onContinue: () => {} }), CLAUDE_USED);
    expect(view.text()).toContain("Live");
    expect(view.text()).toContain("Your tools are talking to your context.");
    view.unmount();
  });
});
