/**
 * @jest-environment jsdom
 */

/**
 * The Plugins panel, actually rendered.
 *
 * `plugins.test.ts` covers the wording and the two guards as pure functions,
 * and on its own that leaves the limb this file exists for: a panel that never
 * calls them. Mutations that were green with only the pure tests:
 *
 *  - the unavailable branch falling through to the ready branch — fixture
 *    plugin names rendered into a live console, which is the one thing the
 *    frontend brief rules out flatly;
 *  - the failed branch dropping `view.reason` — a storage error reported as a
 *    sentence with no cause in it;
 *  - `found: 0` rendering the summary card instead of its own words — "0 in
 *    this bucket", where the reader needed to be told about their sync;
 *  - the row dropping `routeOut` — every won't-run plugin ending on its
 *    refusal, silently, across the whole list.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PluginsPanel } from "../features/console/settings/panels/PluginsPanel";
import {
  SCOPE_NOTE,
  type ConsolePlugin,
  type PluginVerdict,
  type PluginsView,
} from "../features/console/plugins/plugins";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function panel(view: PluginsView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PluginsPanel, { view }));
  });
  return container;
}

function plugin(over: Partial<ConsolePlugin> & { verdict: PluginVerdict }): ConsolePlugin {
  return {
    id: over.id ?? `plugin-${over.verdict}`,
    name: over.name ?? "A plugin",
    evidence: [],
    limitations: [],
    notes: [],
    ...over,
  };
}

const READY: PluginsView = {
  state: "ready",
  inventory: {
    found: 3,
    scanned: 3,
    truncated: false,
    checkedAt: "2026-09-12T09:41:00.000Z",
    plugins: [
      plugin({ id: "highlightr-plugin", name: "Highlightr", version: "1.2.2", verdict: "runs" }),
      plugin({
        id: "obsidian-git",
        name: "Obsidian Git",
        verdict: "wont-run",
        evidence: [
          {
            id: "child_process",
            reason: "runs another program; there is no process to start in a browser tab",
          },
        ],
      }),
      plugin({
        id: "dataview",
        name: "Dataview",
        verdict: "unknown",
        bytesRead: 512_000,
        bytesTotal: 1_800_000,
        evidence: [{ id: "read-cap", reason: "the bundle is larger than the check reads" }],
      }),
    ],
  },
};

describe("the four states are four screens", () => {
  test("each state renders its own branch and no other", () => {
    expect(panel({ state: "unavailable" }).querySelector("[data-testid='plugins-unavailable']")).not.toBeNull();
    expect(panel({ state: "loading" }).querySelector("[data-testid='plugins-loading']")).not.toBeNull();
    expect(
      panel({ state: "failed", reason: "storage: 403" }).querySelector("[data-testid='plugins-failed']"),
    ).not.toBeNull();
    expect(panel(READY).querySelector("[data-testid='plugins-ready']")).not.toBeNull();
  });

  /*
    The guard against the mutation that matters most here. A live console with
    no way to ask must render no plugin facts at all — not a name, not a
    verdict, not a count.
  */
  test("a console that cannot ask renders no plugin facts", () => {
    const text = panel({ state: "unavailable" }).textContent ?? "";
    for (const invented of ["Highlightr", "Obsidian Git", "Dataview", "Runs here", "Won't run here"]) {
      expect(text).not.toContain(invented);
    }
    expect(text).toContain(".obsidian/");
  });

  test("a failed read quotes the provider's own reason", () => {
    expect(panel({ state: "failed", reason: "storage: 403 from provider" }).textContent).toContain(
      "storage: 403 from provider",
    );
  });

  test("a failed read bounds itself to the Obsidian setup", () => {
    expect(panel({ state: "failed", reason: "storage: 403" }).textContent).toContain(
      "not about your notes",
    );
  });
});

describe("a successful read that found nothing", () => {
  const empty: PluginsView = {
    state: "ready",
    inventory: { found: 0, scanned: 0, truncated: false, checkedAt: "2026-09-12", plugins: [] },
  };

  test("gets its own words rather than an empty summary", () => {
    const container = panel(empty);
    expect(container.querySelector("[data-testid='plugins-empty']")).not.toBeNull();
    expect(container.querySelector("[data-testid='plugins-ready']")).toBeNull();
  });

  test("points at the sync setting that usually explains it", () => {
    expect(panel(empty).textContent).toContain(".obsidian");
  });
});

describe("the ready list", () => {
  test("the summary counts read as sentences, not as noun phrases", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("Runs here · 1");
    expect(text).toContain("Needs approval · 0");
    expect(text).toContain("Couldn't be checked · 1");
  });

  test("draws a group heading for every verdict present", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("Runs here");
    expect(text).toContain("Won't run here");
    expect(text).toContain("Couldn't be checked");
  });

  test("names the call rather than the category", () => {
    expect(panel(READY).textContent).toContain("child_process");
  });

  test("every plugin that cannot run here is told where it still runs", () => {
    expect(panel(READY).textContent).toContain(
      "Keep it in Obsidian — same bucket, same files, and Context reads whatever it writes.",
    );
  });

  test("an unchecked plugin is told it was not read, and how much was", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("Not a refusal");
    expect(text).toContain("512 KB of 1.8 MB read");
  });

  test("the floor and the shared-notes scope both survive to the screen", () => {
    const text = panel(READY).textContent ?? "";
    expect(text).toContain("floor, not a guarantee");
    expect(text).toContain(SCOPE_NOTE);
  });

  test("a truncated listing renders its count as a floor", () => {
    const text =
      panel({
        state: "ready",
        inventory: { ...READY.inventory, found: 47, scanned: 23, truncated: true },
      } as PluginsView).textContent ?? "";
    expect(text).toContain("47+");
    expect(text).toContain("23 of 47+ read");
  });
});
