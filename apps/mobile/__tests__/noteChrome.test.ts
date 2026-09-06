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
    setScope: () => {},
    openLinkPaths: new Set<string>(),
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
    // Required on `ConsoleData`, and read by the status strip and the phone's
    // tree footer for how much of this context is indexed. `status: null` is
    // "not answered yet", so neither draws a figure — `indexProgressSurfaces`
    // is where that is the subject rather than a fixture detail.
    fastSearch: { status: null, loading: false },
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

  /** By accessible name — what a press target is addressed by here. */
  const find2 = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`);

  return {
    container,
    find,
    find2,
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
   * THE assertion for this branch, and it is **narrower than it was**.
   *
   * It used to end by asserting that no breadcrumb segment existed on a phone
   * at all, because the whole row had been deleted here. The path half is back
   * (see `the path bar` below) and the naming half is not, which is the line
   * this test now holds: the note is named *inside itself*, once.
   *
   * So "put the breadcrumb back and this fails" is no longer the rule. What
   * fails it is putting the breadcrumb's *leaf* back — a trailing segment
   * saying what the title one line down already says.
   */
  test("an inline title, and no second name above it", () => {
    const app = mountConsole(dataWith());

    const title = app.find("note-inline-title");
    expect(title).not.toBeNull();
    // What the note calls itself, not what it is filed as: a captured note's
    // filename is a content hash, which is why `noteHeading` exists at all.
    expect(title!.textContent).toBe("The storage binding");

    // The leaf a full breadcrumb would carry. Its absence is what makes the
    // line above a position rather than a title drawn twice.
    expect(app.container.querySelector(`[aria-label="Open ${NOTE}"]`)).toBeNull();
    // …and the visibility chip stayed gone too: a note carries it as a
    // Properties row, which is fuller than the crumb's brief version.
    expect(app.container.textContent).not.toContain("follows its folder");
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

/**
 * **The phone's path bar**, which is the reversal of a stated decision.
 *
 * The breadcrumb was dropped on a phone because the note names itself inside
 * the document — right about *naming*, wrong about *navigation*. A folder page
 * reached by a link had no route to its parent at all, and the only way to
 * another folder was the drawer, which is the surface a phone makes hardest to
 * get at. `pathOnly` is the half that navigates and none of the half that
 * labelled: no leaf, no visibility chip, and the context segment back as the
 * way up rather than as a caption.
 *
 * Every assertion here is about *pressing* rather than about text. A path you
 * can only read is a label, and a label would satisfy a test that looked for
 * the words.
 */
describe("the path bar", () => {
  const DEEP = "3-resources/books/the-lean-startup.md";

  test("every ancestor is a target, and the note itself is not repeated", () => {
    const app = mountConsole(dataWith({}, { path: DEEP, name: "the-lean-startup.md" }));

    expect(app.find2("Open 3-resources")).not.toBeNull();
    expect(app.find2("Open 3-resources/books")).not.toBeNull();
    // The leaf is the inline title one line below; a crumb ending in it would
    // say the same words twice.
    expect(app.find2(`Open ${DEEP}`)).toBeNull();
  });

  test("the context is the first segment and it is pressable", () => {
    // Without it the bar bottoms out one level short of home: a top-level
    // folder has no ancestors, so there would be nothing to press at all.
    const app = mountConsole(dataWith({}, { kind: "folder", path: "3-resources", name: "3-resources" }));
    expect(app.find2("Open @seyi")).not.toBeNull();
  });

  test("pressing a segment selects that folder", () => {
    const chosen: string[] = [];
    const app = mountConsole(
      dataWith({ select: (path: string) => chosen.push(path) } as never, {
        path: DEEP,
        name: "the-lean-startup.md",
      }),
    );

    app.press(app.find2("Open 3-resources/books"));
    app.press(app.find2("Open @seyi"));
    // The root is `""`, which is what `FolderView` needs a `contextLabel` for:
    // it is the one folder with no name of its own.
    expect(chosen).toEqual(["3-resources/books", ""]);
  });

  test("a pointer layout keeps the full line instead, chip and all", () => {
    // The positive control for the whole shape: `pathOnly` must not be what a
    // desktop gets, or the visibility chip and the leaf disappear from the one
    // density that has room for them.
    const app = mountConsole(dataWith({}, { path: DEEP, name: "the-lean-startup.md" }), 1200);
    expect(app.find2(`Open ${DEEP}`)).toBeNull();
    expect(app.find2("Open 3-resources")).not.toBeNull();
    expect(app.container.textContent).toContain("the-lean-startup");
  });
});

describe("the top row ends in one group, and it is the note's", () => {
  /**
   * **This was `the top bar is a toggle and one group › nothing sits between
   * them`**, and it asserted a `frame-drawer-toggle` at the leading edge with
   * an empty middle. Both halves are retired rather than deleted:
   *
   *  - the toggle is gone because there is no panel for it to pull in — a
   *    phone has no file-tree drawer and no rail sheet at any density
   *    (`features/app/frame.ts`), and a toggle for a panel that does not exist
   *    is not navigation;
   *  - the middle is no longer empty. The old comment here said "the chip that
   *    used to be in the middle … is the vault switcher at the foot of the file
   *    tree now", and that footer went with the tree. The contexts are a
   *    scrolling strip in the middle and the account is pinned before it.
   *
   * The claim that has *not* changed is the one this file exists for: **one row
   * above the note**, and the trailing group on it holds what acts on the note.
   * So the row is asserted by its three slots rather than by an emptiness.
   */
  test("an account, the contexts, and the note's own actions", () => {
    const app = mountConsole(dataWith());

    expect(app.find("account-sign-out")).not.toBeNull();
    expect(app.find("context-strip")).not.toBeNull();
    expect(app.find("note-share")).not.toBeNull();

    // Retired chrome, absent: the two toggles and the chip.
    expect(app.find("frame-drawer-toggle")).toBeNull();
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
    expect(lock.getAttribute("aria-label")).toBe("Make a link anyone can open");
    expect(lock.querySelector('[data-icon="lockOpen"]')).not.toBeNull();

    const priv = mountConsole(dataWith({}, { visibility: "private", inherited: "private" }));
    const shut = priv.find("note-visibility")!;
    expect(shut.getAttribute("aria-label")).toBe("Share this with your team");
    expect(shut.querySelector('[data-icon="lock"]')).not.toBeNull();
  });

  test("pressing it asks the server to move the scope, once", () => {
    // Asserted on the *call*, not on what the screen then shows: the console
    // does not move a visibility optimistically, so a test that read the icon
    // afterwards would pass on a button wired to nothing.
    //
    // A team note's next position is the link anybody can open — the middle of
    // the three — so this also pins that the widening step is the one taken
    // rather than the close.
    const moved: unknown[] = [];
    const app = mountConsole(
      dataWith({ setScope: (...args: unknown[]) => moved.push(args) } as never),
    );
    app.press(app.find("note-visibility"));
    expect(moved).toEqual([[NOTE, "file", "team", "anyone"]]);
  });

  /**
   * The third position, and the one property this screen must not get wrong:
   * a globe means a link that works, so it is drawn from the share row AND the
   * manifest together. `scopeOf` is where that rule lives; this is the wiring.
   */
  test("a note with a live open link draws the globe and closes on a press", () => {
    const moved: unknown[] = [];
    const app = mountConsole(
      dataWith({
        openLinkPaths: new Set([NOTE]),
        setScope: (...args: unknown[]) => moved.push(args),
      } as never),
    );
    const globe = app.find("note-visibility")!;
    expect(globe.getAttribute("aria-label")).toBe("Make this private");
    expect(globe.querySelector('[data-icon="globe"]')).not.toBeNull();

    app.press(globe);
    expect(moved).toEqual([[NOTE, "file", "anyone", "private"]]);
  });

  test("…and a private note with a stale link row still draws the padlock", () => {
    // The link grants nothing over a private note — the server re-derives
    // visibility from the live manifest on every read — so a globe here would
    // tell somebody they had published something they had not.
    const app = mountConsole(
      dataWith({ openLinkPaths: new Set([NOTE]) } as never, {
        visibility: "private",
        inherited: "private",
      }),
    );
    expect(app.find("note-visibility")!.querySelector('[data-icon="lock"]')).not.toBeNull();
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

/**
 * **THE FILE TREE'S FOOT, AND WHERE THE THREE THINGS IN IT WENT.**
 *
 * This block was `the file tree ends in a vault switcher`, and it asserted
 * Obsidian's block: the context's name with a chevron and a gear, a row of five
 * icon verbs, and one muted line reading `R2 · brain · 1 note, 0 folders`. Its
 * three tests opened `frame-drawer-toggle` first, because all of it lived
 * inside the file tree, and the file tree was a drawer.
 *
 * **A phone has no file tree.** Not a hidden one, not one behind a toggle —
 * none (`features/app/frame.ts`). So the block is not merely unreachable, it is
 * not rendered at any density: `Explorer` is a pointer-layout column and its
 * `vault` and `vaultDetail` slots have no supplier left and are deleted.
 *
 * Deleting the assertions with the design would have dropped a feature
 * silently, which is why each of the four things that block carried is followed
 * to where it went instead:
 *
 *  - **the context's name and the chevron** — the contexts are the strip along
 *    the top, and choosing one is a press rather than a panel
 *    (`consoleChrome.test.ts`, `contextStrip.test.ts`);
 *  - **the gear** — a context's settings are the strip's long-press menu
 *    (`contextMenu.ts`'s `settings` row, held by `contextStrip.test.ts`);
 *  - **the five verbs** — new note, search and the tab count are keys on the
 *    bottom row, which is where a thumb already is;
 *  - **the muted line** — `storage · index · counts`, which had **no other
 *    route on a phone to any of the three**, is the foot of the context root
 *    page. That is the one this block is the proof for, because it is the one
 *    that would have been lost without anybody noticing: nothing else on a
 *    phone says which bucket this context is bound to.
 *
 * `indexProgressSurfaces.test.ts` owns the index figure's own rules — the
 * owner-only gate, the stalled and finished and failed wordings. What is here
 * is that the *line* exists, in the right place, with all three facts on it.
 *
 * ## Sabotage record
 *
 * Against a green baseline of **172 suites / 3,285 tests**
 * (`npx jest --watchman=false`), one at a time:
 *
 * | broken guard | result |
 * | --- | --- |
 * | `atContextRoot` drops its `compact &&` | 1 failure, `a pointer layout draws no context foot`, and only it |
 * | a phone with nothing open falls back to `Empty` | 4 failures / 2 files, led here by `a phone that has opened nothing lands on that page rather than on a dead end` |
 * | `contextFootLine` drops the binding | 5 failures / 3 files, one of them `the binding and the counts are one line under the context's own page` |
 */
describe("the tree's foot became the context root page's foot", () => {
  /** The root's listing, for a console that has landed on the context itself. */
  const AT_ROOT = {
    selectedPath: "",
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [{ ...ENTRY, path: "1-projects/plan.md" }],
      },
    },
  };

  test("the binding and the counts are one line under the context's own page", () => {
    const app = mountConsole(dataWith(AT_ROOT as never, { kind: "folder", path: "", name: "" }));

    // The page is really the context's — the heading is the context's name,
    // which is what `FolderView` takes a `contextLabel` for.
    expect(app.container.textContent).toContain("@seyi");
    // One muted line: the binding, then what has been read of the tree. No
    // index figure, because this fixture's `fastSearch.status` is `null` —
    // "not answered yet" — and an absence is never drawn as a zero.
    expect(app.find("context-foot")!.textContent).toBe("R2 · brain · 1 note, 0 folders");
  });

  test("a pointer layout draws no context foot", () => {
    // It says all three of these already — the bucket and the tier are the top
    // bar's chips, the index figure is the status strip's segment, and the
    // counts are the tree's own foot. A second copy under the listing would be
    // the same facts twice on the one density that never lost them.
    const app = mountConsole(
      dataWith(AT_ROOT as never, { kind: "folder", path: "", name: "" }),
      1440,
    );
    expect(app.find("context-foot")).toBeNull();
    // The positive control: the tree is there and still counts what it has read.
    expect(app.find("explorer-counts")!.textContent).toBe("1 note, 0 folders");
  });

  test("a phone that has opened nothing lands on that page rather than on a dead end", () => {
    /*
      `Empty` says "choose a note … right-click any row — or press and hold on a
      phone", which was true while the tree was one press away. There are no
      rows on a phone until you are standing in a folder, so on
      `/console/@seyi` with no `?note=` that sentence named a gesture with
      nothing to perform it on — and the context's own page, with the line
      above on it, was unreachable.
    */
    const app = mountConsole(
      dataWith({ ...AT_ROOT, selectedPath: null, opening: null } as never),
    );

    expect(app.container.textContent).not.toContain("Choose a note");
    expect(app.find("folder-row")).not.toBeNull();
    expect(app.find("context-foot")).not.toBeNull();
  });

  test("and a pointer layout keeps its empty state", () => {
    // The other density has a tree beside the pane, so "choose a note" names
    // something on the screen. Replacing it there would be answering a
    // question nobody asked.
    const app = mountConsole(
      dataWith({ ...AT_ROOT, selectedPath: null, opening: null } as never),
      1440,
    );
    expect(app.container.textContent).toContain("Choose a note");
  });
});
