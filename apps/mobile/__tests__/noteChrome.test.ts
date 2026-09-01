/**
 * @jest-environment jsdom
 */

/**
 * ONE ROW OF CHROME ABOVE A NOTE, ON A PHONE.
 *
 * The acceptance question for this branch, asked three times by the owner and
 * answered here rather than by eye: **above the note, can you count more than
 * one row?** Obsidian on iOS spends one transparent row — a sidebar toggle at
 * the leading edge, one grouped container at the trailing edge, nothing in the
 * middle — and names the note with an inline title *inside the document*, which
 * is why its first screen of text scrolls up behind the chrome.
 *
 * Ours spent two: a bar carrying a `@seyi personal` chip, and a breadcrumb row
 * under it carrying a path and a `team · inherited` chip. Each of the three
 * things that row carried had to go somewhere rather than be deleted, and this
 * file is the proof that each of them arrived:
 *
 *  - the note's **name** is an inline title at the top of the document;
 *  - its **visibility** is a Properties row, because `visibility:` is filing
 *    metadata about a note and Properties is the panel that lists that;
 *  - **Share** is in the top bar's trailing group, where the reference puts ⋯.
 *
 * `browseShare.test.ts` is the same Share claim on the pointer layout, where the
 * breadcrumb and the button both stay. Neither file can fail for the other's
 * reason, which is the point of having two.
 *
 * The whole console is mounted — the real `AppFrame`, the real `BrowsePane`,
 * the real `Explorer` — because every one of these moves is a control crossing
 * from one component to another, and a test that mounted only the pane would go
 * green on a control that had gone missing from the frame.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

/*
  `Slot` is the real Browse pane, because the note's name and its visibility are
  rendered by the pane and the Share control by the layout around it — and what
  is under test is exactly that they add up to one row.
*/
jest.mock("expo-router", () => ({
  Slot: () => {
    const { createElement: h } = require("react") as typeof import("react");
    const { BrowsePane } =
      require("../features/console/panes/BrowsePane") as typeof import("../features/console/panes/BrowsePane");
    const { useConsoleData } =
      require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");
    return h(BrowsePane, { data: useConsoleData() });
  },
  Redirect: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/console/@seyi",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

// `mock`-prefixed so `jest.mock`'s hoisted factory may close over it.
let mockData: () => ConsoleData = () => {
  throw new Error("no console data set");
};

jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

const NOTE = "1-projects/plan.md";

/**
 * A real captured note's shape, trimmed.
 *
 * It carries a `subject` — so the inline title has something to prefer over the
 * filename — and its own `visibility:` line, which is the case the Properties
 * panel has to resolve rather than duplicate: a `visibility:` written inside a
 * note decides nothing, because `privacy.md` decides access.
 */
const FILE = [
  "---",
  'subject: "The storage binding"',
  "visibility: private",
  "status: unprocessed",
  "---",
  "",
  "The first paragraph of the note itself.",
  "",
].join("\n");

const ENTRY: FolderListing["entries"][number] = {
  kind: "file",
  path: NOTE,
  name: "plan.md",
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
};

function dataWith(
  over: Partial<FileBrowser> = {},
  entry: Partial<FolderListing["entries"][number]> = {},
): ConsoleData {
  const path = entry.path ?? NOTE;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      [folder]: {
        path: folder,
        folderDefault: "team" as const,
        truncated: false,
        manifestUsable: true,
        entries: [{ ...ENTRY, ...entry, path }],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: path,
    select: () => {},
    editor: { ...emptyEditor, status: "clean", path, baseline: FILE, draft: FILE },
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    toasts: [],
    dismissToast: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    copyTo: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
    resetPrivacy: () => {},
    canResetPrivacy: false,
    canSetVisibility: true,
    canShare: true,
    shares: [],
    share: () => {},
    teamShareLink: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    search: undefined,
    ...over,
  } as unknown as FileBrowser;

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "seyi",
        role: "owner",
        kind: "personal",
        status: "ok",
      },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "Cloudflare R2",
      bucket: "brain",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as unknown as ConsoleData;
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/** A phone. jsdom reports a zero width, which every density test has to stub. */
function mountConsole(data: ConsoleData, width = 390) {
  mockData = () => data;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    container,
    find,
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        for (const type of ["mousedown", "mouseup", "click"]) {
          node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        }
      });
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("the note names itself, inside itself", () => {
  /**
   * THE assertion for this branch. Put the breadcrumb back and this fails.
   */
  test("an inline title replaces the breadcrumb row", () => {
    const app = mountConsole(dataWith());

    const title = app.find("note-inline-title");
    expect(title).not.toBeNull();
    // What the note calls itself, not what it is filed as: a captured note's
    // filename is a content hash, which is why `noteHeading` exists at all.
    expect(title!.textContent).toBe("The storage binding");

    // And the row it replaced is gone — the whole complaint. `Open 1-projects`
    // is the accessible name a breadcrumb segment carries; the tree still has
    // its own row for that folder, so this looks for the crumb's own label.
    expect(app.container.querySelector('[aria-label="Open 1-projects"]')).toBeNull();
  });

  test("the title scrolls with the note rather than sitting above it", () => {
    /*
      An inline title that is not inside the scroller is a breadcrumb wearing a
      larger font. The reference's own giveaway is mid-scroll: the title and the
      Properties panel pass *under* the floating chrome.
    */
    const app = mountConsole(dataWith());
    const scroll = app.find("note-scroll");
    expect(scroll).not.toBeNull();
    expect(scroll!.contains(app.find("note-inline-title"))).toBe(true);
    expect(scroll!.contains(app.find("note-properties"))).toBe(true);
  });

  test("a pointer layout keeps the breadcrumb and does not draw a title", () => {
    // The desktop is not Obsidian's desktop and is not in scope: there the
    // breadcrumb is a region header that also carries folder navigation, and
    // two names above one note is worse than either.
    const app = mountConsole(dataWith(), 1440);
    expect(app.find("note-inline-title")).toBeNull();
    expect(app.container.querySelector('[aria-label="Open 1-projects"]')).not.toBeNull();
  });
});

describe("visibility survives into Properties", () => {
  /**
   * The chip the breadcrumb carried was a **claim about who can read this
   * note**. Moving the row it lived in must not lose it.
   */
  test("the access map's answer is a property of the note", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));

    const open = app.find("note-properties-open");
    expect(open).not.toBeNull();
    expect(open!.textContent).toContain("visibility");
    // The same three-case wording the breadcrumb printed, from the same
    // function: a note that merely follows a `team` folder and one deliberately
    // shared as an exception have to stay distinguishable.
    expect(open!.textContent).toContain("team · inherited");
  });

  test("a note that sets its own says so, rather than saying it inherits", () => {
    const app = mountConsole(
      dataWith({}, { visibility: "team", inherited: "private", exception: true }),
    );
    app.press(app.find("note-properties"));
    expect(app.find("note-properties-open")!.textContent).toContain("team · set here");
  });

  /**
   * A `visibility:` line inside a note decides nothing — `privacy.md` decides
   * access, which is what `ManifestNotice` says in so many words. The fixture
   * carries `visibility: private` in its frontmatter while the access map says
   * `team`, and the panel must state one answer, not two.
   */
  test("the file's own visibility line is replaced, not shown beside it", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));

    const text = app.find("note-properties-open")!.textContent ?? "";
    expect(text).toContain("team · inherited");
    expect(text).not.toContain("private");
    // Every other frontmatter field is still there, untouched.
    expect(text).toContain("subject");
    expect(text).toContain("The storage binding");
  });

  test("`+ Add property` is still drawn, and still inert", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-properties"));
    const add = app.find("note-properties-add");
    expect(add).not.toBeNull();
    expect(add!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("the top bar is a toggle and one group", () => {
  test("nothing sits between them", () => {
    const app = mountConsole(dataWith());

    expect(app.find("frame-drawer-toggle")).not.toBeNull();
    expect(app.find("note-share")).not.toBeNull();
    // The chip that used to be in the middle. It is the vault switcher at the
    // foot of the file tree now — see `explorer` below.
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("storage-pill")).toBeNull();
    // And search is on the toolbar, where the thumb is, not doubled up here.
    expect(app.find("frame-search")).toBeNull();
  });

  /**
   * Share had to land somewhere when the breadcrumb went, and "somewhere" is
   * the thing that is easy to skip. `browseShare.test.ts` states the rule this
   * is the phone's half of: a control that is correct in `menu.ts` and
   * unreachable on a screen is a feature nobody has.
   */
  test("Share opens the dialog for the note in front of you", () => {
    const app = mountConsole(dataWith());
    expect(document.body.querySelector('[aria-label="Share plan.md"]')).toBeNull();

    app.press(app.find("note-share"));
    expect(document.body.querySelector('[aria-label="Share plan.md"]')).not.toBeNull();
  });

  test("and it is absent — not dimmed — for anybody the server would refuse", () => {
    const editor = mountConsole(dataWith({ canShare: false }));
    expect(editor.find("note-share")).toBeNull();
    // The positive control: the same fixture with ownership shows it, so this
    // cannot pass because the note failed to open.
    expect(editor.find("note-inline-title")).not.toBeNull();
  });

  /**
   * **A folder and a note are acted on identically now.**
   *
   * `FolderView` used to draw its own pair — a "Share…" pill in the heading and
   * a full-width "Make this folder private" under it — which put the same two
   * capabilities behind two different sets of controls in two different places,
   * and on a phone the folder's pair was the first two things on the screen.
   * The group in the top bar is the one answer for both.
   */
  test("a folder gets the same two actions, in the same group", () => {
    const app = mountConsole(
      dataWith({}, { kind: "folder", path: "3-resources", name: "3-resources" }),
    );
    expect(app.find("note-share")).not.toBeNull();
    expect(app.find("note-visibility")).not.toBeNull();
  });

  test("the lock draws the state it is in, and names the state it moves to", () => {
    // Two different things on purpose, and the disagreement is the point: the
    // icon is looked at and says what is true, the label is read aloud before
    // the press and says what will happen. See `ICON_NAMES`.
    const shared = mountConsole(dataWith());
    const lock = shared.find("note-visibility")!;
    expect(lock.getAttribute("aria-label")).toBe("Make this private");
    expect(lock.querySelector('[data-icon="lockOpen"]')).not.toBeNull();

    const priv = mountConsole(dataWith({}, { visibility: "private", inherited: "private" }));
    const shut = priv.find("note-visibility")!;
    expect(shut.getAttribute("aria-label")).toBe("Share this with your team");
    expect(shut.querySelector('[data-icon="lock"]')).not.toBeNull();
  });

  test("pressing it asks the server to move the visibility, once", () => {
    // Asserted on the *call*, not on what the screen then shows: the console
    // does not move a visibility optimistically, so a test that read the icon
    // afterwards would pass on a button wired to nothing.
    const moved: unknown[] = [];
    const app = mountConsole(
      dataWith({ setVisibility: (...args: unknown[]) => moved.push(args) } as never),
    );
    app.press(app.find("note-visibility"));
    expect(moved).toEqual([[NOTE, "file", "private"]]);
  });

  test("and the lock is absent for anybody the server would refuse", () => {
    const member = mountConsole(dataWith({ canSetVisibility: false }));
    expect(member.find("note-visibility")).toBeNull();
    // The positive control, the same one Share's test uses: the note opened.
    expect(member.find("note-inline-title")).not.toBeNull();
  });

  test("nor for `privacy.md`, which is the access map itself", () => {
    const app = mountConsole(
      dataWith({}, { path: "privacy.md", name: "privacy.md", readOnly: true }),
    );
    expect(app.find("note-inline-title")).not.toBeNull();
    expect(app.find("note-share")).toBeNull();
    // The lock too: `privacy.md` *is* the access map, so a control offering to
    // change its visibility would be offering to edit the file that decides
    // everybody else's.
    expect(app.find("note-visibility")).toBeNull();
  });
});

describe("the file tree ends in a vault switcher", () => {
  test("the context, the binding and the counts are one block at the foot", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("frame-drawer-toggle"));

    const switcher = app.find("vault-switcher");
    expect(switcher).not.toBeNull();
    expect(switcher!.textContent).toContain("@seyi");
    expect(switcher!.textContent).toContain("personal");
    expect(app.find("vault-settings")).not.toBeNull();

    // One muted line: the binding, then what has been read of the tree.
    expect(app.find("explorer-vault-detail")!.textContent).toBe(
      "R2 · brain · 1 note, 0 folders",
    );
  });

  test("its verbs are at the foot too, not in a second row across the top", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("frame-drawer-toggle"));

    /*
      The reference's five: new note, new folder, sort, collapse all, close.
      **No magnifier** — on a phone, finding a note is the bottom toolbar's
      search, which opens the palette over the whole context rather than
      filtering the folders that happen to be loaded. See `Explorer`.
    */
    const foot = app.find("vault-switcher")!.parentElement!.parentElement!;
    for (const testId of [
      "explorer-new-note",
      "explorer-new-folder",
      "explorer-sort",
      "explorer-collapse",
      "explorer-close",
    ]) {
      const control = app.find(testId);
      expect(control).not.toBeNull();
      expect(foot.contains(control)).toBe(true);
    }
    // Neither the field nor a button that reveals it: a tree that starts below
    // a permanent search box has spent its first rows on chrome, and one that
    // starts below a button to summon one has spent a target on it.
    expect(app.find("explorer-filter")).toBeNull();
    expect(app.find("explorer-filter-open")).toBeNull();

    // And nothing between the verbs and the brain. The reference has a `Files`
    // pill in that slot because Obsidian's sidebar holds several panes and the
    // pill is how you change which one; ours holds one — Connections and Map
    // are settings, not panes — so the control switched nothing and spent a
    // band of the footer saying so.
    expect(app.find("explorer-pane")).toBeNull();
  });

  test("the switcher is the way to the rail, since the top bar no longer is", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("frame-drawer-toggle"));
    expect(app.find("frame-nav-sheet")).toBeNull();

    app.press(app.find("vault-switcher"));
    expect(app.find("frame-nav-sheet")).not.toBeNull();
  });
});
