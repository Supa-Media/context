/**
 * @jest-environment jsdom
 */
import { describe, expect, test } from "@jest/globals";

/**
 * The two controls the button audit put everywhere a ghost label used to be
 * (`docs/decisions/app-and-console/design-tokens-and-interaction.md`, "An
 * action row is primary first"): the secondary action as a link, and a bin
 * for deleting something just typed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { TextLink } from "../features/design/components/TextLink";
import { DeleteButton } from "../features/design/components/DeleteButton";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: ReturnType<typeof createElement>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    el: (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("a secondary action is a link", () => {
  test("it is announced as a link and presses", () => {
    let pressed = 0;
    const view = mount(createElement(TextLink, { label: "Skip for now", onPress: () => pressed++, testID: "l" }));
    expect(view.el("l").getAttribute("role")).toBe("link");
    act(() => view.el("l").click());
    expect(pressed).toBe(1);
    view.unmount();
  });

  test("disabled, it says so and does nothing", () => {
    let pressed = 0;
    const view = mount(
      createElement(TextLink, { label: "Cancel", onPress: () => pressed++, disabled: true, testID: "l" }),
    );
    expect(view.el("l").getAttribute("aria-disabled")).toBe("true");
    act(() => view.el("l").click());
    expect(pressed).toBe(0);
    view.unmount();
  });
});

describe("deleting something just typed is a bin", () => {
  test("named for the row it removes, never just “Remove”", () => {
    let pressed = 0;
    const view = mount(
      createElement(DeleteButton, {
        accessibilityLabel: "Remove folder 2",
        onPress: () => pressed++,
        testID: "d",
      }),
    );
    expect(view.el("d").getAttribute("aria-label")).toBe("Remove folder 2");
    expect(view.el("d").textContent).not.toMatch(/Remove/);
    act(() => view.el("d").click());
    expect(pressed).toBe(1);
    view.unmount();
  });
});

/** Every hand-written `.tsx` under `features/` and `app/`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("the rule, held across the app", () => {
  const root = join(__dirname, "..");
  const files = [...sources(join(root, "features")), ...sources(join(root, "app"))]
    // The landing page keeps its own hero button and its arrow link.
    .filter((path) => !relative(root, path).startsWith("features/landing/"));

  test("no action is a bare ghost label", () => {
    // A `Button` with the ghost variant — not the `Text` style of that name.
    const ghost = /<Button\b[^>]*?variant="ghost"/s;
    const offenders = files.filter((path) => ghost.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => relative(root, path))).toEqual([]);
  });

  test("no primary outside the landing page is the white hero button", () => {
    const white = /<Button\b[^>]*?variant="white"/s;
    const offenders = files.filter((path) => white.test(readFileSync(path, "utf8")));
    expect(offenders.map((path) => relative(root, path))).toEqual([]);
  });
});
