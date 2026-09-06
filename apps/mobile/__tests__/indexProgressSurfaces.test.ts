/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * How much of a context is indexed, on the surfaces that are not the settings
 * card.
 *
 * ## Why there are surfaces beyond the card at all
 *
 * "0 notes indexed", in one Notice, on one card, behind a gear, was the whole
 * of what this console said about a backfill — and that is why a **stuck**
 * backfill and a **working** one were indistinguishable for hours. Somebody
 * browsing their own notes had no way to learn the index was not filling
 * without going and looking for a screen they had no reason to suspect existed.
 *
 * So the figure is drawn wherever this context's state is already represented,
 * and the two places outside settings are split by form factor rather than by
 * taste:
 *
 *  - **a pointer gets the status strip**, which already carries the bucket and
 *    the conflict-check guarantee, i.e. facts about the context rather than the
 *    open note;
 *  - **a phone gets the foot of the context root page**, because at `compact`
 *    the frame draws a bottom toolbar and **no status strip**
 *    (`features/app/frame.ts`). Without that line a phone would have exactly
 *    the problem this feature exists to remove.
 *
 * Neither invents anything: both read `describeIndexProgress`, the one function
 * that decides the words, so a context cannot be 62% in one place and 63% in
 * another.
 *
 * ## The phone's half moved, and it moved because its home was demolished
 *
 * This used to read "**a phone gets the file tree's footer line**", and the
 * assertions below opened a drawer and read `explorer-vault-detail`. That was
 * right for as long as a phone had a file tree. It has none — no drawer, no
 * rail sheet, no toggle for either (`features/app/frame.ts`) — so the footer
 * that carried `storage · index · counts` went with the panel it was the foot
 * of, and **the phone lost this feature outright**. Nothing about the reason it
 * exists changed; only the surface did.
 *
 * The line is the foot of the **context root page** now — the one folder page
 * that *is* the context, which is why `FolderView` has always taken a
 * `contextLabel` for it. `features/console/files/contextFoot.ts` composes it,
 * `FolderView` draws it under the root's listing, and a subfolder page does not
 * get one: `loadedCounts` counts every listing that has been read rather than
 * this folder's, so under `3-resources`' own eight rows the same numbers would
 * be read as a count of `3-resources` and would be wrong. A line that is
 * accurate and misread is worse than one that is absent.
 *
 * That is also why the phone cases below mount the console with the **root
 * selected** and read `context-foot`, and why one of them presses nothing: the
 * old ones had to open a drawer to reach the figure, and there is no longer
 * anything between somebody browsing their own notes and this line.
 *
 * ## The assertion that matters most
 *
 * **A non-owner must be shown nothing at all, on every one of these surfaces.**
 * `fastSearch.status` drops `notesIndexed` and `notesPending` for anyone but an
 * owner because the index counts every note the context has, private ones
 * included, while a member may read only the `team` tier: a total — or any
 * percentage of it — hands them the size of what they are not being shown, and
 * lets them watch it move as private notes are written and deleted.
 * `SECURITY.md` counts inferring that a private note exists as a bug in its own
 * right.
 *
 * So the rule is not "shows a dash" or "shows 0%" but *renders nothing*, and it
 * is asserted over the whole mounted console's text at both widths rather than
 * over one element — a placeholder introduced anywhere fails it.
 *
 * ## Sabotage record
 *
 * Measured against a green baseline of **167 suites / 3,162 tests**, one guard
 * broken at a time and the whole suite re-run (`npx jest --watchman=false`):
 *
 * | broken guard | result |
 * | --- | --- |
 * | `indexProgress` loses its `notesIndexed === undefined` line | **`tsc` fails** — `TS2345` at `fastSearch.ts:384`. The suite stays green, which is exactly why `wholeCount` takes `number` and not `number \| undefined`: the leak is refused by the compiler rather than by a test somebody might not have written. |
 * | that guard replaced by the "absent is zero" reflex, `wholeCount(status.notesIndexed ?? 0)` | 5 failures / 3 files — every member case here (pointer, phone, footer), plus `fastSearchCard` and `fastSearchSettings` |
 * | the status strip substitutes `"—"` for a withheld figure | 2 failures — 1 here, 1 in `status.test.ts` |
 * | the card substitutes `"—"` for a withheld figure | 1 failure in `fastSearchCard.test.ts` (caught by the container being asserted **absent**; a text sweep reads a dash as ordinary copy, which is why `Notice` gained a `testID`) |
 * | the phone footer drops the label, keeping the storage pill alone | 5 failures, **here only** — which is the whole reason the phone case is a case of its own |
 * | the 1–99 rounding clamp is dropped | 2 failures in `fastSearchSettings.test.ts` (1-in-10,000 → `0%`, 9,999-in-10,000 → `100%`) |
 * | the server's percentage is trusted without a range check | 1 failure in `fastSearchSettings.test.ts` |
 * | an empty queue is called finished whatever the state says | 2 failures in `fastSearchSettings.test.ts` |
 * | an empty context is drawn as `0%` rather than as empty | 5 failures / 3 files |
 * | `off` / `unavailable` are given a percentage | 3 failures / 3 files |
 * | the strip derives its own tone instead of carrying the one it was handed | 1 failure in `status.test.ts` |
 *
 * Every one of them fails its own case and, where it is genuinely one rule
 * spanning surfaces, all of them — and nothing else.
 *
 * ## Sabotage record, the move
 *
 * The table above was measured while the phone's half was the file tree's
 * footer; every row of it still holds, because none of those guards is in the
 * surface that moved. What follows was measured after it moved, against a green
 * baseline of **172 suites / 3,285 tests**, one guard broken at a time and the
 * whole suite re-run (`npx jest --watchman=false`):
 *
 * | broken guard | result |
 * | --- | --- |
 * | `contextFootLine` drops `describeIndexProgress(…)?.label` | 5 failures / 1 file — every owner case here, phone and both-surfaces alike. The pointer's strip is untouched, which is the point: it is a different caller of the same function. |
 * | `contextFootLine` drops the binding | 5 failures / 3 files — 2 here, 1 in `noteChrome`, 2 in `storageUnknown`. The line is three facts and the phone has no other route to the first of them. |
 * | `FolderView`'s foot is handed to every folder page, not only the root | 2 failures / 2 files — `a folder page inside the context carries no caption` here, and `folderRoute`'s `is the same screen as reaching it through the tree`, which catches it from the other direction: a deep-linked folder would gain a caption the tree route does not draw |
 * | `atContextRoot` drops its `compact &&`, so a pointer layout draws the foot too | 1 failure — `noteChrome`'s `a pointer layout draws no context foot`, and only it. (An earlier shape of this, which composed the line on every render at compact and gated the *prop*, reddened 24: the extra 23 were `browseShare` crashing on a fixture with no `fastSearch` at all. Gating the composition rather than the prop is what makes the mutant land on the assertion written for it instead of on a `TypeError` three files away — and it also stops the listing walk running behind every open note.) |
 * | `contextFootLine` drops its `storage === undefined` arm, so a binding that has not answered reads as "no bucket connected" | **0**, until the three cases in `storageUnknown.test.ts` were written for it. That guard was correct and unasked — see that file's own record. With them, 1 failure and only it. |
 * | the percentage is composed here from `notesIndexed ?? 0` instead of asked of `describeIndexProgress` | 5 failures / 1 file — both member cases, the `off` case, and the two owner wordings. This is the mutant that matters most: it is the shape a second implementation naturally takes, and it hands a member the size of what they are not being shown. |
 *
 * And two outside this file's subject that the same sweep measured, recorded
 * here because they were broken in the same change:
 *
 * | broken guard | result |
 * | --- | --- |
 * | a phone with nothing open draws nothing rather than the context root page | 4 failures / 2 files — `noteChrome`'s `a phone that has opened nothing lands on that page rather than on a dead end`, plus the three `storageUnknown` cases, which reach the foot through exactly that landing |
 * | the pinned account's pressable goes back to `padding: 4` (34pt) | 1 failure — `consoleChrome`'s `sign-out is reachable, and is a target a thumb can hit`, which is the product's only sign-out |
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

/*
  `Slot` is the real Browse pane, because the phone's half of this figure is
  drawn by a *page* now rather than by a panel of the frame. It used to be
  `() => null` and could be: the file tree was mounted by the layout, so the
  footer existed without any route rendering. The pane is what draws the
  context root, so a mock that renders nothing would assert this feature absent
  and pass.
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

// The layout is what is under test; its data source is not.
jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type FastSearchStatus =
  import("../features/console/search/fastSearch").FastSearchStatus;

/** Swapped per test, read on every render by the mocked hook. */
let mockStatus: FastSearchStatus | null = null;

/**
 * What is open, and therefore which page is on screen.
 *
 * `""` is the context root — the page that carries the foot. A subfolder is
 * what the negative case selects; see `a folder page inside the context carries
 * no caption`.
 */
let mockSelected: string | null = "";

function mockConsoleData(): never {
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "folder" as const,
            path: "1-projects",
            name: "1-projects",
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ],
      },
      "1-projects": {
        path: "1-projects",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [
          {
            kind: "note" as const,
            path: "1-projects/plan.md",
            name: "plan.md",
            visibility: "team" as const,
            inherited: "private" as const,
            exception: true,
            readOnly: false,
          },
        ],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: mockSelected,
    opening: null,
    conflict: null,
    canSetVisibility: true,
    canShare: true,
    canResetPrivacy: false,
    resetPrivacy: () => {},
    shares: [],
    share: () => {},
    teamShareLink: () => {},
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    copyShareLink: () => {},
    openLinkPaths: new Set<string>(),
    setScope: () => {},
    collapseAll: () => {},
    copyTo: () => {},
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
    toasts: [],
    dismissToast: () => {},
    clipboard: null,
    copy: () => {},
    cut: () => {},
    paste: () => {},
    createNote: () => {},
    createFolder: () => {},
    rename: () => {},
    move: () => {},
    duplicate: () => {},
    archive: () => {},
    destroy: () => {},
    setVisibility: () => {},
  };

  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
    contexts: [
      {
        id: "w1",
        slug: "seyi",
        displayName: "Seyi",
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
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAMPLEKEY",
      conditionalWrite: true,
      updatedAt: 0,
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    fastSearch: { status: mockStatus, loading: false },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

let unmountAll: Array<() => void> = [];

afterEach(() => {
  for (const done of unmountAll) done();
  unmountAll = [];
});

function mountConsole(width: number) {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  // Inside `act`: react-native-web's `useWindowDimensions` sets state on this
  // event, and an update outside act is a warning rather than a failure — i.e.
  // exactly the kind of noise that trains people to ignore the output.
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  /*
    `openDrawer` used to be here, and every phone assertion below called it
    first. It pressed `frame-drawer-toggle` to pull the file tree in, because
    the figure was that tree's footer. There is no drawer and no toggle at any
    density now (`features/app/frame.ts`), and the figure is on the page
    already — so the helper is gone rather than pointed at something else, and
    the phone cases press nothing.
  */
  const app = {
    text: () => container.textContent ?? "",
    find,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  unmountAll.push(app.unmount);
  return app;
}

/**
 * Everything the pointer console has on screen.
 *
 * Unmounted before returning, deliberately: `useWindowDimensions` subscribes to
 * `resize`, so a console left mounted at 1440 takes the next mount's resize and
 * updates outside anybody's `act` scope.
 */
function pointerText(): string {
  const app = mountConsole(1440);
  const rendered = app.text();
  app.unmount();
  unmountAll = unmountAll.filter((done) => done !== app.unmount);
  return rendered;
}

/**
 * Everything the phone console has on screen. Same rule.
 *
 * Nothing is opened first. That is the change and it is worth stating: this
 * used to open the file-tree drawer, because the figure lived inside a panel
 * somebody had to summon. It is the foot of the page they are already on.
 */
function phoneText(): string {
  const app = mountConsole(390);
  const rendered = app.text();
  app.unmount();
  unmountAll = unmountAll.filter((done) => done !== app.unmount);
  return rendered;
}

const OWNER_MID_BACKFILL: FastSearchStatus = {
  state: "preparing",
  canChange: true,
  notesIndexed: 620,
  notesPending: 380,
};

/* -------------------------------------------------------------------------- */
/*                             the owner is told                              */
/* -------------------------------------------------------------------------- */

describe("an owner sees the figure without opening settings", () => {
  test("the status strip carries it on a pointer", () => {
    mockStatus = OWNER_MID_BACKFILL;
    const app = mountConsole(1440);
    expect(app.find("console-status")).not.toBeNull();
    expect(app.text()).toContain("62% indexed");
  });

  test("the context root page's foot carries it on a phone, which has no status strip", () => {
    // The frame draws a bottom toolbar and no status bar at `compact`, so
    // without this line the figure would exist on a phone only inside
    // settings — which is the state that made a stuck backfill invisible.
    //
    // This used to open the file tree's drawer and read its footer. A phone has
    // neither, and the assertion is written positively so that "the panel is
    // gone" cannot pass as "the feature is here": the foot is *found*, and the
    // three facts are in it, in order.
    mockStatus = OWNER_MID_BACKFILL;
    const app = mountConsole(390);
    expect(app.find("console-status")).toBeNull();
    expect(app.find("context-foot")?.textContent ?? "").toBe(
      "R2 · example-bucket · 62% indexed · 1 note, 1 folder",
    );
  });

  test("a folder page inside the context carries no caption", () => {
    /*
      The decision `FolderView`'s header records, asserted rather than claimed.
      `loadedCounts` counts every listing that has been read, not this folder's,
      so under `1-projects`' own rows those numbers would be read as a count of
      `1-projects` — accurate and misread, which is worse than absent. The
      context root is the one folder page that *is* the context.
    */
    mockStatus = OWNER_MID_BACKFILL;
    mockSelected = "1-projects";
    const app = mountConsole(390);
    // The positive control: this really is a folder page, so the absence below
    // is not a page that failed to render.
    expect(app.find("folder-row")).not.toBeNull();
    expect(app.find("context-foot")).toBeNull();
    mockSelected = "";
  });

  test("the same words in both places, from the one function that decides them", () => {
    // Not "both mention a percentage": the identical string. Two surfaces
    // rounding the same ratio their own way is how one context comes to be
    // 62% here and 63% there, and the first thing anybody does with a progress
    // figure is compare it with the last one they saw.
    mockStatus = OWNER_MID_BACKFILL;
    expect(pointerText()).toContain("62% indexed");
    expect(phoneText()).toContain("62% indexed");
  });

  test("a stalled backfill reads as stalled rather than as 0%", () => {
    mockStatus = { state: "preparing", canChange: true, notesIndexed: 0, notesPending: 1284 };
    for (const rendered of [pointerText(), phoneText()]) {
      expect(rendered).toContain("Nothing indexed yet");
      expect(rendered).not.toMatch(/0\s*%/);
    }
  });

  test("a finished index says 100% rather than falling silent", () => {
    mockStatus = { state: "on", canChange: true, notesIndexed: 1284, notesPending: 0 };
    for (const rendered of [pointerText(), phoneText()]) {
      expect(rendered).toContain("100% indexed");
    }
  });

  test("a failed backfill keeps the number it stopped at", () => {
    mockStatus = { state: "failed", canChange: true, notesIndexed: 620, notesPending: 380 };
    for (const rendered of [pointerText(), phoneText()]) {
      expect(rendered).toContain("Stopped at 62% indexed");
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                          the member is told nothing                         */
/* -------------------------------------------------------------------------- */

describe("A MEMBER SEES NO PERCENTAGE ON ANY SURFACE", () => {
  /**
   * What the server actually sends a non-owner: the state, whether they may
   * change it, and no counters at all. Every state, because "off" and
   * "unavailable" are the ones somebody would reach for a placeholder in.
   */
  const memberStates = ["off", "preparing", "on", "failed", "unavailable"] as const;

  test("nothing on the pointer console, in any state", () => {
    for (const state of memberStates) {
      mockStatus = { state, canChange: false };
      const rendered = pointerText();
      expect(rendered).not.toMatch(/\d+\s*%/);
      expect(rendered).not.toMatch(/indexed/i);
      expect(rendered).not.toMatch(/Nothing indexed/i);
      for (const done of unmountAll) done();
      unmountAll = [];
    }
  });

  test("nothing on the phone console, in any state", () => {
    for (const state of memberStates) {
      mockStatus = { state, canChange: false };
      const rendered = phoneText();
      expect(rendered).not.toMatch(/\d+\s*%/);
      expect(rendered).not.toMatch(/indexed/i);
      for (const done of unmountAll) done();
      unmountAll = [];
    }
  });

  test("the phone's foot keeps the bucket and the counts, and gains nothing else", () => {
    // The line is shared with the storage label and the tree counts, so "the
    // member is told nothing" must not be satisfied by the whole line
    // disappearing — that would be a different regression wearing this test's
    // pass. The storage label and the counts are the phone's only route to
    // either fact, and they travel with the figure rather than behind its gate.
    mockStatus = { state: "preparing", canChange: false };
    const app = mountConsole(390);
    const detail = app.find("context-foot")?.textContent ?? "";
    expect(detail).toBe("R2 · example-bucket · 1 note, 1 folder");
    expect(detail).not.toMatch(/\d+\s*%/);
    expect(detail).not.toMatch(/indexed/i);
  });

  test("no placeholder stands in for the withheld figure", () => {
    // Not an em dash, not "0%", not a spinner. A placeholder says a figure
    // exists and is being kept from them, which is most of what the figure
    // itself would have said.
    mockStatus = { state: "preparing", canChange: false };
    const app = mountConsole(1440);
    const strip = app.find("console-status")?.textContent ?? "";
    expect(strip).not.toContain("—");
    expect(strip).not.toMatch(/\d+\s*%/);
    // The strip is genuinely rendering — this is not a pass bought by an
    // empty bar.
    expect(strip).toContain("R2 · example-bucket");
  });
});

/* -------------------------------------------------------------------------- */
/*                         nothing is claimed too early                        */
/* -------------------------------------------------------------------------- */

describe("an absence is never drawn as a zero", () => {
  test("a status that has not answered draws nothing anywhere", () => {
    // `null` is "not asked, or not answered yet" and is deliberately not an
    // `off` with a 0% beside it — the same three-valued treatment
    // `ConsoleData.storage` needs for its binding.
    mockStatus = null;
    for (const rendered of [pointerText(), phoneText()]) {
      expect(rendered).not.toMatch(/\d+\s*%/);
      expect(rendered).not.toMatch(/indexed/i);
    }
  });

  test("a context with fast search off carries no figure", () => {
    // Off is a working state — search is served from the customer's own
    // bucket. A "0% indexed" on it is a badge somebody clears by turning on a
    // copy of their private notes.
    mockStatus = { state: "off", canChange: true, notesIndexed: 0, notesPending: 0 };
    for (const rendered of [pointerText(), phoneText()]) {
      expect(rendered).not.toMatch(/\d+\s*%/);
      expect(rendered).not.toMatch(/indexed/i);
    }
  });
});
