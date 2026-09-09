/**
 * @jest-environment jsdom
 */

/**
 * The settings overlay, actually rendered.
 *
 * Everything else about this feature is covered by pure functions — the
 * section catalogue, the URL parsing — and two adversarial reviews made the
 * same point about that: with only those, whole limbs of the feature can be
 * deleted and the suite stays green. Mutations that were green before this
 * file existed:
 *
 *  - `const show = () => true` in `SettingsPane` — every section renders the
 *    whole scroll again, and sectioning is gone;
 *  - swapping which block `show("sources")` and `show("search")` guard —
 *    sections render each other's content;
 *  - making the section list's `onSelect` a no-op — the list stops navigating;
 *  - `Overlay`'s compact branch dropping `children` — no settings content is
 *    reachable on a phone at all, which is a bug that actually shipped in this
 *    PR's first commit and was found by reading rather than by testing.
 *
 * So this asserts the three things that are the feature: one section at a
 * time, the list moves between them, and the phone reaches content rather than
 * only a menu.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => {
    throw new Error("not used in this test");
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useDemoConsoleData } from "../features/console/useDemoConsoleData";
import { SettingsOverlay } from "../features/console/settings/SettingsOverlay";
import type { ConsoleData } from "../features/console/types";
import type { SettingsSectionKey } from "../features/console/settings/sections";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(render: () => ReturnType<typeof createElement>): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(render());
  });
  return container;
}

/** The demo console, resolved before mounting — an `act` inside an `act` never flushes. */
function demoData(): ConsoleData {
  let data: ConsoleData | null = null;
  function Probe() {
    data = useDemoConsoleData();
    return null;
  }
  mount(() => createElement(Probe));
  if (data === null) throw new Error("the demo console did not resolve");
  return data;
}

/**
 * Mounts and hands back `document.body`, not the container.
 *
 * `Modal` on react-native-web renders through a portal appended to the body,
 * so the mount container is empty — asserting against it would have been a
 * test that passes on an overlay that draws nothing.
 */
function overlay(
  section: SettingsSectionKey,
  onSelect: (next: SettingsSectionKey) => void = () => {},
  onDismiss: () => void = () => {},
): HTMLElement {
  const data = demoData();
  mount(() => createElement(SettingsOverlay, { data, section, onSelect, onDismiss }));
  return document.body;
}

/*
  jsdom reports a viewport width of 0, so every mount here takes `Overlay`'s
  **compact** branch. That is the right half to spend a render test on: the
  wide branch shows the list and the content together, where a mistake is
  visible, while compact shows one at a time — and the bug that actually
  shipped in this PR's first commit was compact rendering the list forever and
  the settings never.
*/

describe("a phone reaches the settings, not just a menu", () => {
  test("opens on the section, because that is what was asked for", () => {
    // The regression: `sidebar ?? children` with a sidebar always supplied
    // meant no section content was reachable below 880pt at all.
    const text = overlay("search").textContent ?? "";
    expect(text).toContain("Where this context");
  });

  test("one section at a time — search is not storage", () => {
    const text = overlay("search").textContent ?? "";
    expect(text).not.toContain("Your bucket, your credentials");
  });

  test("and storage is not search", () => {
    const text = overlay("storage").textContent ?? "";
    expect(text).toContain("Your bucket, your credentials");
    expect(text).not.toContain("Where this context");
  });

  test("overview answers which context this is before anything else", () => {
    const text = overlay("overview").textContent ?? "";
    expect(text).toContain("Overview");
    expect(text).toContain("Personal brain");
  });

  test("people is in the context's own settings, not an app-level pane", () => {
    expect(overlay("people").textContent ?? "").toContain("People");
  });

  test("the binding's health is stated, since no storage chip exists here", () => {
    // `PaneHead` is skipped when a section is given, and the top bar's chip is
    // pointer-only — so without the overlay carrying this, a phone states the
    // health of the bucket nowhere.
    expect(overlay("storage").textContent ?? "").toContain("Connected");
  });
});

describe("the account's own settings have a home", () => {
  test("AI apps is reachable and is about apps, not this context", () => {
    const text = overlay("apps").textContent ?? "";
    expect(text).toContain("AI apps");
    // No context badge and no binding health: an account section wearing a
    // context chip would be naming a scope it is not in.
    expect(text).not.toContain("Your bucket, your credentials");
  });

  test("deleting the account is not filed under a context any more", () => {
    expect(overlay("account").textContent ?? "").toContain("Delete account");
  });

  test("profile states the name and does not pretend it can be changed", () => {
    expect(overlay("profile").textContent ?? "").toContain("Profile");
  });
});

describe("the search box", () => {
  test("narrows the list to what somebody typed", () => {
    const host = overlay("overview");
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const field = host.querySelector('[data-testid="settings-search"]') as HTMLInputElement;
    expect(field).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(field, "gmail");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const text = host.textContent ?? "";
    // "Mail, calendar & chats" is where Gmail lives, and nobody types that.
    expect(text).toContain("Mail, calendar & chats");
    expect(text).not.toContain("Delete account");
  });
});

describe("the list is one press away, and it navigates", () => {
  test("back reveals every section", () => {
    const host = overlay("storage");
    const back = host.querySelector('[data-testid="settings-overlay-back"]');
    expect(back).not.toBeNull();
    act(() => {
      (back as HTMLElement).click();
    });
    const text = host.textContent ?? "";
    for (const label of ["Overview", "People", "Storage", "Search", "Mail, calendar & chats"]) {
      expect(text).toContain(label);
    }
  });

  test("pressing a section asks for that section", () => {
    const chosen: string[] = [];
    const host = overlay("storage", (next) => chosen.push(next));
    act(() => {
      (host.querySelector('[data-testid="settings-overlay-back"]') as HTMLElement).click();
    });
    const row = host.querySelector('[data-testid="settings-section-search"]');
    expect(row).not.toBeNull();
    act(() => {
      (row as HTMLElement).click();
    });
    expect(chosen).toEqual(["search"]);
  });

  test("closing asks to close, rather than navigating", () => {
    let closed = 0;
    const host = overlay("storage", () => {}, () => {
      closed += 1;
    });
    const close = host.querySelector('[data-testid="settings-overlay-close"]');
    expect(close).not.toBeNull();
    act(() => {
      (close as HTMLElement).click();
    });
    expect(closed).toBe(1);
  });
});
