/**
 * @jest-environment jsdom
 */

/**
 * The connect rows, mounted and pressed.
 *
 * `clientProviders.test.ts` proves the catalogue is right. This proves the
 * pane is wired to it — which is a separate failure, and the more likely one:
 * a row that renders a perfectly correct deep link and never hands it to
 * anything is indistinguishable from a working row until somebody clicks it.
 *
 * Two things it holds down that nothing else can:
 *
 *  1. **A `cursor://` link is assigned, not `window.open`ed.** The split lives
 *     in `open.web.ts`, which only runs in a browser — and only runs in this
 *     suite at all because jest resolves `.web.ts` first (see `jest.config.js`).
 *     A regression to a single `window.open` for both leaves a blank tab behind
 *     on every one-click install and passes every other test here.
 *  2. **Rows stay shut until asked.** Eight providers' worth of copy fields
 *     rendered at once is the thing the accordion exists to prevent, and
 *     "render them all, hide them with a style" would look identical in a
 *     screenshot.
 *
 * `react-native-web` renders these to real DOM, so the clicks below are the
 * clicks a person makes.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { ConnectClients } from "../features/console/clients/ConnectClients";
import { CLIENT_PROVIDERS } from "../features/console/clients/providers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDPOINT = "https://mcp.example.test/mcp";

interface Screen {
  q: (testID: string) => HTMLElement | null;
  text: () => string;
  click: (testID: string) => void;
  opened: string[];
  assigned: string[];
  unmount: () => void;
}

function mount(): Screen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  const opened: string[] = [];
  const assigned: string[] = [];

  // jsdom refuses to navigate and logs "not implemented"; both are replaced so
  // the test observes the call rather than the navigation.
  jest.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: (url: string) => assigned.push(url) },
  });

  act(() => {
    root.render(createElement(ConnectClients, { endpoint: ENDPOINT }));
  });

  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

  return {
    q,
    text: () => container.textContent ?? "",
    click: (testID: string) => {
      const element = q(testID);
      if (element === null) throw new Error(`no control called ${testID}`);
      act(() => {
        element.click();
      });
    },
    opened,
    assigned,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("the rows", () => {
  test("every provider in the catalogue gets a row and a link button", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      expect(screen.q(`provider-${provider.id}`)).not.toBeNull();
      expect(screen.q(`provider-${provider.id}-open`)).not.toBeNull();
    }
    screen.unmount();
  });

  test("nothing is on screen to copy until a row is opened", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      expect(screen.q(`provider-${provider.id}-details`)).toBeNull();
    }
    expect(screen.text()).not.toContain(ENDPOINT);
    screen.unmount();
  });

  test("opening a row shows that client's fields, and only that client's", () => {
    const screen = mount();
    screen.click("provider-chatgpt-toggle");

    expect(screen.q("provider-chatgpt-details")).not.toBeNull();
    expect(screen.q("provider-chatgpt-url")).not.toBeNull();
    expect(screen.q("provider-claude-details")).toBeNull();
    expect(screen.text()).toContain(ENDPOINT);

    // A second row replaces the first rather than stacking.
    screen.click("provider-claude-toggle");
    expect(screen.q("provider-claude-details")).not.toBeNull();
    expect(screen.q("provider-chatgpt-details")).toBeNull();

    // And the same row again closes it.
    screen.click("provider-claude-toggle");
    expect(screen.q("provider-claude-details")).toBeNull();
    screen.unmount();
  });

  test("ChatGPT offers a name, an optional description, and the URL", () => {
    const screen = mount();
    screen.click("provider-chatgpt-toggle");

    expect(screen.q("provider-chatgpt-name")).not.toBeNull();
    expect(screen.q("provider-chatgpt-description")).not.toBeNull();
    expect(screen.q("provider-chatgpt-url")).not.toBeNull();
    expect(screen.text()).toContain("optional");
    screen.unmount();
  });

  test("a CLI client offers commands carrying the endpoint, not a form", () => {
    const screen = mount();
    screen.click("provider-codex-toggle");

    const add = screen.q("provider-codex-add");
    expect(add).not.toBeNull();
    expect(add!.textContent).toContain(`--url ${ENDPOINT}`);
    expect(screen.q("provider-codex-name")).toBeNull();
    screen.unmount();
  });
});

describe("pressing the link button", () => {
  test("a hosted connector page opens in a new tab", () => {
    const screen = mount();
    screen.click("provider-claude-open");

    expect(screen.assigned).toEqual([]);
    expect(screen.opened).toHaveLength(1);
    expect(screen.opened[0]).toBe(
      "https://claude.ai/customize/connectors?modal=add-custom-connector",
    );
    screen.unmount();
  });

  test("an app-scheme install navigates in place, leaving no blank tab", () => {
    const screen = mount();
    screen.click("provider-cursor-open");

    expect(screen.opened).toEqual([]);
    expect(screen.assigned).toHaveLength(1);
    expect(screen.assigned[0].startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(
      true,
    );
    screen.unmount();
  });

  test("every button carries the endpoint the pane was given", () => {
    const screen = mount();
    for (const provider of CLIENT_PROVIDERS) {
      screen.click(`provider-${provider.id}-open`);
    }

    const hrefs = [...screen.opened, ...screen.assigned];
    expect(hrefs).toHaveLength(CLIENT_PROVIDERS.length);
    for (const href of hrefs) {
      expect(href).not.toContain("context.lc");
    }
    screen.unmount();
  });
});
