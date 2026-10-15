/**
 * @jest-environment jsdom
 */

/**
 * A folder row's arrow opens the folder in place.
 *
 * The owner, 2026-10-14: "I'm realizing that the arrow isn't even clickable,
 * which is stupid." The listing draws a chevron before every folder because
 * the tree does, and the tree's opens the folder where it is. These prove the
 * listing's does the same: the folder's rows follow it, the page is not left,
 * a second press closes it (and what was open inside it), and a folder whose
 * listing is not here yet is asked for. The rest of the row still opens the
 * folder's page.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { FolderView } from "../features/console/files/FolderView";
import type { RowNesting } from "../features/console/files/NestedRows";
import type { FileEntry, FolderListing } from "../features/console/files/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const ROOT = "1-projects";

const at = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

const listing = (path: string, entries: FileEntry[]): FolderListing => ({
  path,
  folderDefault: "team",
  entries,
  truncated: false,
  manifestUsable: true,
});

const LISTINGS: Record<string, FolderListing> = {
  [ROOT]: listing(ROOT, [at("folder", `${ROOT}/cafe`), at("file", `${ROOT}/plan.md`)]),
  [`${ROOT}/cafe`]: listing(`${ROOT}/cafe`, [at("folder", `${ROOT}/cafe/menu`), at("file", `${ROOT}/cafe/budget.md`)]),
  [`${ROOT}/cafe/menu`]: listing(`${ROOT}/cafe/menu`, [at("file", `${ROOT}/cafe/menu/drinks.md`)]),
};

/** RN-web reads the window from the root element; jsdom's is 0 wide, which is a phone. */
function width(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 800, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

function mount(options: { known?: Record<string, FolderListing>; nesting?: boolean; phone?: boolean } = {}) {
  width(options.phone === true ? 390 : 1280);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const known: Record<string, FolderListing> = { ...(options.known ?? LISTINGS) };
  const selected: string[] = [];
  const asked: string[] = [];
  const render = () => {
    const nesting: RowNesting = {
      listingOf: (path) => known[path],
      loadListing: (path) => void asked.push(path),
    };
    root.render(
      createElement(FolderView, {
        entry: at("folder", ROOT),
        listing: known[ROOT],
        canSetVisibility: false,
        contextLabel: "@seyi",
        onSelect: (path: string) => void selected.push(path),
        ...(options.nesting === false ? {} : { nesting }),
      }),
    );
  };
  act(render);
  return {
    container,
    selected,
    asked,
    arrive(path: string) {
      known[path] = LISTINGS[path]!;
      act(render);
    },
  };
}

const arrow = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="folder-row-chevron"]')].find(
    (each) => each.getAttribute("aria-label")?.endsWith(` ${name} here`) || each.getAttribute("aria-label") === `Close ${name}`,
  );

const press = (element: HTMLElement | undefined) => {
  expect(element).toBeDefined();
  act(() => element!.click());
};

describe("a folder row's arrow", () => {
  test("opens the folder in place, without leaving the page", () => {
    const view = mount();
    expect(view.container.textContent).not.toContain("budget");
    press(arrow(view.container, "cafe"));
    expect(view.container.querySelector('[data-testid="folder-row-children"]')).not.toBeNull();
    expect(view.container.textContent).toContain("budget");
    expect(view.selected).toEqual([]);
    expect(arrow(view.container, "cafe")?.getAttribute("aria-expanded")).toBe("true");
    expect(view.asked).toContain(`${ROOT}/cafe`);
  });

  test("a second press closes it, and closes what was open inside it", () => {
    const view = mount();
    press(arrow(view.container, "cafe"));
    press(arrow(view.container, "menu"));
    expect(view.container.textContent).toContain("drinks");
    press(arrow(view.container, "cafe"));
    expect(view.container.textContent).not.toContain("budget");
    // Opened again, the folder inside it comes back closed.
    press(arrow(view.container, "cafe"));
    expect(view.container.textContent).toContain("budget");
    expect(view.container.textContent).not.toContain("drinks");
  });

  test("a folder not listed yet says so, then draws its rows when they arrive", () => {
    const view = mount({ known: { [ROOT]: LISTINGS[ROOT]! } });
    press(arrow(view.container, "cafe"));
    expect(view.container.querySelector('[data-testid="folder-row-children-loading"]')).not.toBeNull();
    expect(view.asked).toContain(`${ROOT}/cafe`);
    view.arrive(`${ROOT}/cafe`);
    expect(view.container.textContent).toContain("budget");
  });

  test("the rest of the row still opens the folder's page", () => {
    const view = mount();
    press(view.container.querySelector<HTMLElement>('[aria-label="cafe, folder"]') ?? undefined);
    expect(view.selected).toEqual([`${ROOT}/cafe`]);
    expect(view.container.textContent).not.toContain("budget");
  });

  test("with nowhere to read a folder from, the arrow is only a mark", () => {
    const view = mount({ nesting: false });
    const mark = view.container.querySelector('[data-testid="folder-row-chevron"]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-expanded")).toBeNull();
  });

  test("a phone's row is a card that goes somewhere, with no arrow to open in place", () => {
    const view = mount({ phone: true });
    expect(arrow(view.container, "cafe")).toBeUndefined();
    expect(view.container.querySelector('[data-testid="folder-row-children"]')).toBeNull();
  });
});
