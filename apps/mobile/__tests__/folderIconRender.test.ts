/**
 * @jest-environment jsdom
 */

/**
 * The folder icon, drawn: in the tree, on a folder's listing row, on Home, and
 * in the picker that sets it.
 *
 * What these prove is the one thing the model cannot: that a folder with an
 * icon shows the icon in place of the folder glyph, that one without keeps the
 * plain glyph, and that a file never draws one. The picker is checked for the
 * two things a person would notice if they were wrong: the grid offers the
 * workspace's own emoji, and "Remove icon" is there only when there is an icon
 * to remove.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { WORKSPACE_ICON_EMOJI } from "@context/shared";
import { ConvexError } from "convex/values";
import { FileTree } from "../features/console/files/FileTree";
import { FolderRow } from "../features/console/files/FolderRow";
import { FolderIconDialog } from "../features/console/files/FolderIconDialog";
import type { TreeRow } from "../features/console/files/tree";
import type { FileEntry } from "../features/console/files/types";
import { FolderLine } from "../features/console/home/homeRows";
import type { HomeFolder } from "../features/console/home/homeModel";
import { FolderHead } from "../features/console/files/folderPage/Head";
import { CustomEmojiContext, type CustomEmojiValue } from "../features/console/emoji/context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

const roots: (() => void)[] = [];

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element));
  return container;
}

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
});

const ICON = "🍳";

function folder(path: string, depth = 0): TreeRow {
  const name = path.split("/").pop()!;
  return {
    kind: "folder",
    key: path,
    path,
    name,
    label: name,
    depth,
    expanded: false,
    selected: false,
    markerIsDefault: false,
    readOnly: false,
  };
}

function file(path: string, depth = 0): TreeRow {
  return { ...folder(path, depth), kind: "file", markerIsDefault: false };
}

function tree(iconOf?: (path: string) => string | null) {
  return createElement(FileTree, {
    rows: [folder("2-areas"), folder("2-areas/cooking", 1), file("2-areas/plan.md", 1)],
    canSetVisibility: false,
    onSelect: () => {},
    onToggle: () => {},
    onCycleVisibility: () => {},
    workspaceId: "ws-1",
    ...(iconOf === undefined ? {} : { iconOf }),
  });
}

/** The emoji drawn on the tree row labelled `label` (its accessible name), or `null` for the plain icon. */
function emojiOn(container: HTMLElement, label: string): string | null {
  const row = container.querySelector(`[aria-label^="${label}"]`);
  if (row === null) throw new Error(`no row named ${label}`);
  const glyph = row.querySelector("[data-testid='tree-folder-emoji']");
  return glyph === null ? null : glyph.textContent;
}

describe("the tree draws a folder's own icon in its glyph slot", () => {
  test("a folder with an icon shows the emoji; one without shows the plain folder icon", () => {
    const container = mount(tree((path) => (path === "2-areas/cooking" ? ICON : null)));
    expect(emojiOn(container, "cooking, folder")).toBe(ICON);
    expect(emojiOn(container, "2-areas, folder")).toBeNull();
  });

  test("the name of a folder with an icon is still its name", () => {
    const container = mount(tree((path) => (path === "2-areas/cooking" ? ICON : null)));
    const row = container.querySelector("[aria-label^='cooking, folder']");
    expect(row?.querySelector("[data-testid='tree-folder-emoji']")).not.toBeNull();
    expect(row?.textContent).toContain("cooking");
  });

  test("a file never draws an emoji, even where its folder has one", () => {
    const container = mount(tree(() => ICON));
    expect(emojiOn(container, "plan.md")).toBeNull();
  });

  test("with no icon source at all, every folder draws the plain icon", () => {
    const container = mount(tree());
    expect(container.querySelectorAll("[data-testid='tree-folder-emoji']")).toHaveLength(0);
  });
});

describe("a folder listing's card draws the icon in place of the folder glyph", () => {
  const entry = (path: string, kind: "file" | "folder" = "folder"): FileEntry => ({
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  });

  test("a folder with an icon shows it, and the same row without one shows no emoji", () => {
    const withIcon = mount(
      createElement(FolderRow, { row: entry("2-areas/cooking"), onSelect: () => {}, card: true, folderIcon: ICON }),
    );
    expect(withIcon.querySelector("[data-testid='folder-row-emoji']")?.textContent).toBe(ICON);
    const plain = mount(createElement(FolderRow, { row: entry("2-areas/cooking"), onSelect: () => {}, card: true }));
    expect(plain.querySelector("[data-testid='folder-row-emoji']")).toBeNull();
  });

  test("a note never draws one", () => {
    const container = mount(
      createElement(FolderRow, { row: entry("2-areas/plan.md", "file"), onSelect: () => {}, card: true, folderIcon: ICON }),
    );
    expect(container.querySelector("[data-testid='folder-row-emoji']")).toBeNull();
  });
});

describe("Home's folder line", () => {
  const home: HomeFolder = { kind: "folder", path: "2-areas/cooking", title: "cooking", notes: 3, folders: 0, shared: false };

  test("draws the icon when the folder has one", () => {
    const container = mount(createElement(FolderLine, { folder: home, icon: ICON, onPress: () => {} }));
    expect(container.querySelector("[data-testid='phone-home-folder-emoji']")?.textContent).toBe(ICON);
  });

  test("keeps the plain folder icon when it does not", () => {
    const container = mount(createElement(FolderLine, { folder: home, onPress: () => {} }));
    expect(container.querySelector("[data-testid='phone-home-folder-emoji']")).toBeNull();
  });
});

describe("the icon picker", () => {
  const PICK = WORKSPACE_ICON_EMOJI[0]!;
  function picker(current: string | null, onSet: (icon: string | null) => Promise<void>, onClose = () => {}) {
    return mount(createElement(FolderIconDialog, { path: "2-areas/cooking", current, onSet, onClose }));
  }
  const cell = (container: HTMLElement, emoji: string) =>
    container.ownerDocument.querySelector<HTMLElement>(`[data-testid='folder-icon-emoji-${emoji}']`);

  test("offers the workspace's own emoji, and the folder's name", () => {
    picker(null, async () => {});
    for (const emoji of WORKSPACE_ICON_EMOJI) expect(cell(document.body, emoji)).not.toBeNull();
    expect(document.body.querySelector("[data-testid='folder-icon-name']")?.textContent).toBe("cooking");
  });

  test("'Remove icon' is absent when the folder has no icon, and present when it has one", () => {
    picker(null, async () => {});
    expect(document.body.querySelector("[data-testid='folder-icon-remove']")).toBeNull();
  });

  test("'Remove icon' sets the icon to null and closes", async () => {
    const calls: (string | null)[] = [];
    let closed = 0;
    picker(ICON, async (icon) => void calls.push(icon), () => (closed += 1));
    const remove = document.body.querySelector<HTMLElement>("[data-testid='folder-icon-remove']");
    expect(remove).not.toBeNull();
    await act(async () => {
      remove!.click();
    });
    expect(calls).toEqual([null]);
    expect(closed).toBe(1);
  });

  test("a tap on an emoji sets it and closes", async () => {
    const calls: (string | null)[] = [];
    let closed = 0;
    picker(null, async (icon) => void calls.push(icon), () => (closed += 1));
    await act(async () => {
      cell(document.body, PICK)!.click();
    });
    expect(calls).toEqual([PICK]);
    expect(closed).toBe(1);
  });

  test("a refusal from the server is shown, and the picker stays open", async () => {
    let closed = 0;
    picker(
      null,
      async () => {
        // The server's refusal arrives as a ConvexError, which is what `toFileError` reads.
        throw new ConvexError({ code: "FORBIDDEN", message: "Only an editor can change a folder icon." });
      },
      () => (closed += 1),
    );
    await act(async () => {
      cell(document.body, PICK)!.click();
    });
    expect(document.body.querySelector("[data-testid='folder-icon-error']")?.textContent).toBe(
      "Only an editor can change a folder icon.",
    );
    expect(closed).toBe(0);
  });
});

describe("any emoji, and the workspace's own", () => {
  const PARROT = "party-parrot";
  const host = {
    generation: 1,
    names: [PARROT],
    canEdit: true,
    custom: () => [PARROT],
    load: async (name: string) => (name === PARROT ? "data:image/png;base64,AAAA" : null),
    rename: async () => null,
    remove: async () => null,
  } as unknown as CustomEmojiValue;

  function withHost(element: ReactElement, value: CustomEmojiValue | null = host): ReactElement {
    return createElement(CustomEmojiContext.Provider, { value }, element);
  }
  async function picker(onSet: (icon: string | null) => Promise<void> = async () => {}) {
    mount(withHost(createElement(FolderIconDialog, { path: "2-areas/cooking", current: null, onSet, onClose: () => {} })));
    // The workspace emoji's picture arrives a tick later.
    await act(async () => {});
  }
  const cell = (emoji: string) => document.body.querySelector<HTMLElement>(`[data-testid='folder-icon-emoji-${emoji}']`);
  const type = async (text: string) => {
    const input = document.body.querySelector<HTMLInputElement>("[data-testid='folder-icon-search']")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  test("with nothing typed, the workspace's emoji come first and every emoji is a scroll away", async () => {
    await picker();
    expect(cell(`:${PARROT}:`)).not.toBeNull();
    // Far outside the thirty-six suggested.
    expect(cell("🦩")).toBeNull();
    expect(document.body.querySelectorAll("[data-testid^='folder-icon-emoji-']").length).toBeGreaterThan(200);
  });

  test("a search finds any emoji by name, not only the suggested ones", async () => {
    await picker();
    await type("flamingo");
    expect(cell("🦩")).not.toBeNull();
    await type("parrot");
    expect(cell(`:${PARROT}:`)).not.toBeNull();
    await type("nothing-is-called-this");
    expect(document.body.querySelector("[data-testid='folder-icon-none']")).not.toBeNull();
  });

  test("an emoji pasted into the search is offered as it is", async () => {
    await picker();
    await type("🫶🏽");
    expect(cell("🫶🏽")).not.toBeNull();
  });

  test("choosing a workspace emoji sets it as :name:", async () => {
    const calls: (string | null)[] = [];
    await picker(async (icon) => void calls.push(icon));
    await act(async () => {
      cell(`:${PARROT}:`)!.click();
    });
    expect(calls).toEqual([`:${PARROT}:`]);
  });

  test("Add emoji… opens the workspace's Add dialog and uses what was added", async () => {
    const calls: (string | null)[] = [];
    const adding = { ...host, openAdd: async () => "new-one" } as CustomEmojiValue;
    mount(
      withHost(
        createElement(FolderIconDialog, {
          path: "2-areas/cooking",
          current: null,
          onSet: async (icon: string | null) => void calls.push(icon),
          onClose: () => {},
        }),
        adding,
      ),
    );
    await act(async () => {
      document.body.querySelector<HTMLElement>("[data-testid='folder-icon-add']")!.click();
    });
    expect(calls).toEqual([":new-one:"]);
  });

  test("a workspace emoji draws as its picture in the tree", async () => {
    const container = mount(withHost(tree((path) => (path === "2-areas/cooking" ? `:${PARROT}:` : null))));
    await act(async () => {});
    const glyph = container.querySelector("[aria-label^='cooking, folder'] [data-testid='tree-folder-emoji']");
    expect(glyph?.outerHTML).toContain("data:image/png");
    expect(glyph?.textContent).toBe("");
  });

  test("one the workspace no longer has falls back to the plain folder", async () => {
    const container = mount(withHost(tree((path) => (path === "2-areas/cooking" ? ":gone:" : null))));
    await act(async () => {});
    expect(container.querySelector("[aria-label^='cooking, folder'] [data-testid='tree-folder-emoji']")).toBeNull();
  });
});

describe("the main folder view shows the icon too", () => {
  const entry: FileEntry = {
    kind: "folder",
    path: "2-areas/cooking",
    name: "cooking",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };

  test("a desktop listing row draws the icon in its chevron's place", () => {
    const container = mount(createElement(FolderRow, { row: entry, onSelect: () => {}, folderIcon: ICON }));
    expect(container.querySelector("[data-testid='folder-row-emoji']")?.textContent).toBe(ICON);
  });

  test("and without one keeps the chevron", () => {
    const container = mount(createElement(FolderRow, { row: entry, onSelect: () => {} }));
    expect(container.querySelector("[data-testid='folder-row-emoji']")).toBeNull();
  });

  test("the folder's own page draws it before its title", () => {
    const withIcon = mount(createElement(FolderHead, { title: "cooking", icon: ICON, switcher: null }));
    expect(withIcon.querySelector("[data-testid='folder-head-icon']")?.textContent).toBe(ICON);
    const plain = mount(createElement(FolderHead, { title: "cooking", switcher: null }));
    expect(plain.querySelector("[data-testid='folder-head-icon']")).toBeNull();
  });
});
