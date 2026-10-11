/**
 * @jest-environment jsdom
 */

/**
 * The two folder offers, drawn and answered: the root band "Add the five main
 * folders?" (`MainFoldersNotice`) and the business question inside "Add a
 * folder" (`AddFolderSheet`). Each answer is taken through the central
 * arbiter (`MessagesProvider`), and the test reads what reached the account.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const mockMarks: unknown[] = [];

jest.mock("convex/react", () => ({
  useMutation: () => async (args: unknown) => {
    mockMarks.push(args);
    return null;
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1024, height: 768 }),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexError } from "convex/values";
import { MessagesProvider } from "../features/messages/MessagesProvider";
import { useInAppMessage } from "../features/messages/useInAppMessage";
import { MainFoldersNotice } from "../features/console/panes/browsePane/MainFoldersNotice";
import { AddFolderSheet } from "../features/console/files/AddFolderSheet";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];

afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  mockMarks.length = 0;
});

function mount(element: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => root.render(element as never));
  return container;
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

const at = (testId: string): HTMLElement | null => document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function press(testId: string) {
  const node = at(testId);
  if (node === null) throw new Error(`nothing called ${testId}`);
  await act(async () => {
    node.click();
  });
  await settle();
}

function rootListing(names: string[]): FolderListing {
  return {
    path: "",
    folderDefault: "private",
    entries: names.map((name) => ({
      kind: "folder" as const,
      path: name,
      name,
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    })),
    truncated: false,
    manifestUsable: true,
  };
}

function fakeFiles(over: Partial<{ names: string[]; contextId: string | null; add: (role: string) => Promise<string> }> = {}) {
  const added: string[] = [];
  const files = {
    canEdit: true,
    contextId: over.contextId === undefined ? "ws-1" : over.contextId,
    listings: { "": rootListing(over.names ?? ["0-inbox", "2-areas"]) },
    addBuiltInFolder:
      over.add ??
      (async (role: string) => {
        added.push(role);
        return `4-${role}`;
      }),
    createFolder: () => {},
    select: () => {},
  } as unknown as FileBrowser;
  return { files, added };
}

/** The band, with its own answer wired through the arbiter the way `useBrowseNotices` wires it. */
function BandHarness({ files, onDone }: { files: FileBrowser; onDone?: () => void }) {
  const missing = useInAppMessage({ id: "missing-folders", workspaceId: "ws-1", eligible: true, deviceKey: null });
  return missing.visible
    ? createElement(MainFoldersNotice, { files, dismiss: () => { missing.dismiss(); onDone?.(); } })
    : null;
}

describe("the main-folders band", () => {
  test("names the folders found and the ones it will add, in the order drawn", () => {
    const { files } = fakeFiles({ names: ["0-inbox", "1-projects", "2-areas"] });
    mount(createElement(MainFoldersNotice, { files, dismiss: () => {} }));
    expect(at("browse-main-folders")?.textContent).toContain("Add the five main folders?");
    expect(at("main-folder-line-projects")?.textContent).toBe("✓ Projects (1-projects)");
    expect(at("main-folder-line-resources")?.textContent).toBe("+ Add Resources");
    expect(at("main-folder-line-archive")?.textContent).toBe("+ Add Archive");
  });

  test("the button counts the missing folders, singular for one", () => {
    const { files } = fakeFiles({ names: ["0-inbox", "1-projects", "2-areas", "3-resources"] });
    mount(createElement(MainFoldersNotice, { files, dismiss: () => {} }));
    expect(at("main-folders-add")?.textContent).toBe("Add 1 folder");
  });

  test("the button counts the missing folders, plural for more", () => {
    const { files } = fakeFiles({ names: ["0-inbox"] });
    mount(createElement(MainFoldersNotice, { files, dismiss: () => {} }));
    expect(at("main-folders-add")?.textContent).toBe("Add 4 folders");
  });

  test("adds each missing folder in order, then is dismissed", async () => {
    const { files, added } = fakeFiles({ names: ["0-inbox", "2-areas"] });
    const dismissed = jest.fn();
    mount(createElement(MainFoldersNotice, { files, dismiss: dismissed }));
    await press("main-folders-add");
    expect(added).toEqual(["projects", "resources", "archive"]);
    expect(dismissed).toHaveBeenCalledTimes(1);
  });

  test("a failed add shows the server's sentence and is not dismissed", async () => {
    const dismissed = jest.fn();
    const { files } = fakeFiles({
      names: ["0-inbox"],
      add: async () => {
        throw new ConvexError({ code: "DESTINATION_EXISTS", message: "A folder called Projects is already here." });
      },
    });
    mount(createElement(MainFoldersNotice, { files, dismiss: dismissed }));
    await press("main-folders-add");
    expect(at("main-folders-error")?.textContent).toBe("A folder called Projects is already here.");
    expect(dismissed).not.toHaveBeenCalled();
  });

  test("Not now is final: the answer reaches the account for this workspace", async () => {
    const { files } = fakeFiles({ names: ["0-inbox"] });
    mount(
      createElement(MessagesProvider, {
        reads: [],
        children: createElement(BandHarness, { files }),
      }),
    );
    await settle();
    expect(at("browse-main-folders")).not.toBeNull();
    await press("main-folders-dismiss");
    expect(at("browse-main-folders")).toBeNull();
    expect(mockMarks).toEqual([{ message: "missing-folders", workspaceId: "ws-1" }]);
  });

  test("an answer the account already holds keeps the band away", async () => {
    const { files } = fakeFiles({ names: ["0-inbox"] });
    mount(
      createElement(MessagesProvider, {
        reads: [{ message: "missing-folders", workspaceId: "ws-1", variant: null, seenAt: Date.now() }],
        children: createElement(BandHarness, { files }),
      }),
    );
    await settle();
    expect(at("browse-main-folders")).toBeNull();
  });
});

describe("the business question in the Add a folder sheet", () => {
  function sheet(
    files: FileBrowser,
    extra: {
      personal?: boolean;
      reads?: unknown[];
      onAdded?: (path: string) => void;
      onClose?: () => void;
      onStartBusiness?: () => void;
    } = {},
  ) {
    return createElement(MessagesProvider, {
      reads: extra.reads ?? [],
      children: createElement(AddFolderSheet, {
        files,
        names: ["0-inbox", "1-projects", "2-areas", "3-resources", "9-archive"],
        folders: [],
        rootLabel: "Seyi",
        compact: false,
        personal: extra.personal ?? true,
        onStartBusiness: extra.onStartBusiness,
        onAdded: extra.onAdded,
        onClose: extra.onClose ?? (() => {}),
      }),
    });
  }

  test("in a personal workspace, Clients asks the question instead of adding at once", async () => {
    const { files, added } = fakeFiles();
    mount(sheet(files));
    await settle();
    await press("add-folder-choice-clients");
    expect(at("business-body")?.textContent).toContain("A business usually gets its own workspace");
    expect(added).toEqual([]);
  });

  test("Add Clients here adds it, and answers the question for good", async () => {
    const { files, added } = fakeFiles();
    const closed = jest.fn();
    mount(sheet(files, { onClose: closed }));
    await settle();
    await press("add-folder-choice-clients");
    await press("business-add-here");
    expect(added).toEqual(["clients"]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(mockMarks).toEqual([{ message: "business-workspace", workspaceId: "ws-1" }]);
  });

  test("Start a business workspace answers it, closes, and opens the new workspace flow", async () => {
    const { files, added } = fakeFiles();
    const closed = jest.fn();
    const start = jest.fn();
    mount(sheet(files, { onClose: closed, onStartBusiness: start }));
    await settle();
    await press("add-folder-choice-teams");
    await press("business-start");
    expect(added).toEqual([]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(mockMarks).toEqual([{ message: "business-workspace", workspaceId: "ws-1" }]);
  });

  test("with no way to open the new workspace flow, the question offers only Add here", async () => {
    const { files } = fakeFiles();
    mount(sheet(files));
    await settle();
    await press("add-folder-choice-clients");
    expect(at("business-start")).toBeNull();
    expect(at("business-add-here")).not.toBeNull();
  });

  test("the question names Teams when Teams was the choice", async () => {
    const { files } = fakeFiles();
    mount(sheet(files));
    await settle();
    await press("add-folder-choice-teams");
    expect(at("business-add-here")?.textContent).toBe("Add Teams here");
  });

  test("an answered question means the folder is simply added", async () => {
    const { files, added } = fakeFiles();
    mount(sheet(files, { reads: [{ message: "business-workspace", workspaceId: "ws-1", variant: null, seenAt: Date.now() }] }));
    await settle();
    await press("add-folder-choice-clients");
    expect(at("business-body")).toBeNull();
    expect(added).toEqual(["clients"]);
  });

  test("Products is never asked about", async () => {
    const { files, added } = fakeFiles();
    mount(sheet(files));
    await settle();
    await press("add-folder-choice-products");
    expect(at("business-body")).toBeNull();
    expect(added).toEqual(["products"]);
  });

  test("a shared workspace is never asked about", async () => {
    const { files, added } = fakeFiles();
    mount(sheet(files, { personal: false }));
    await settle();
    await press("add-folder-choice-clients");
    expect(at("business-body")).toBeNull();
    expect(added).toEqual(["clients"]);
  });
});
