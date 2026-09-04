/**
 * @jest-environment jsdom
 */

/**
 * SHARE IS REACHABLE FROM THE NOTE.
 *
 * The class of bug this file exists to prevent, and it shipped once: **the
 * control being correct in `menu.ts` and unreachable on a screen.**
 *
 * `fileMenu.test.ts` proves the row's menu offers Share to an owner and hides
 * it from everybody else. All of that was true while the feature was, in
 * practice, missing — on a phone the menu opens on a long press *on a file
 * row*, so somebody reading a note had no row to press and no button to find,
 * and the moment they decide to send a note to a colleague is exactly the
 * moment they are reading it. `BrowsePane`'s own `Empty` copy already states
 * the rule that was broken: "a right-click menu nobody discovers is a feature
 * nobody has."
 *
 * So this mounts the real pane and asserts on what is on the screen. A menu
 * test cannot fail for the reason this one exists.
 *
 * ## This file is the pointer layout's half
 *
 * On a phone the control is no longer in the pane at all. The row it sat in was
 * a breadcrumb, and a breadcrumb is the second band of chrome Obsidian spends
 * nothing on — so the name became an inline title inside the document and Share
 * moved into the top bar's trailing group, where the reference puts its ⋯.
 * `noteChrome.test.ts` is the same claim on that surface, and the two together
 * are what stop the capability going missing on one of them.
 *
 * Everything here therefore mounts at a **pointer width**. Left at jsdom's
 * default the window measures 0, which reads as `compact`, and every assertion
 * below would be about a layout that no longer draws this button.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

// React refuses to run `act` without this, and warns on every call otherwise.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrowsePane } from "../features/console/panes/BrowsePane";
import type { ConsoleData } from "../features/console/types";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";
import { emptyEditor } from "../features/console/files/editor";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

/**
 * A pointer window.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — see `appFrameRender.test.ts` for the full trap. Zero reads as
 * `compact`, which is the one density this file is *not* about.
 */
function pointerWidth(): void {
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function mount(element: ReturnType<typeof createElement>): HTMLElement {
  pointerWidth();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(element);
  });
  return container;
}

const NOTE = "1-projects/plan.md";
/** A note no listing in the fixture holds — a link followed on a cold load. */
const UNLOADED = "3-resources/mcp/granola.md";

const LISTING: FolderListing = {
  path: "1-projects",
  folderDefault: "team",
  entries: [
    {
      kind: "file",
      path: NOTE,
      name: "plan.md",
      visibility: "team",
      inherited: "team",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

/**
 * A console with one note open.
 *
 * A literal rather than the demo hook, because the two things under test —
 * `canShare` and `readOnly` — are exactly the fields the demo pins to `false`.
 */
function dataWith(over: Partial<FileBrowser> = {}, entry: Partial<FolderListing["entries"][number]> = {}): ConsoleData {
  const path = entry.path ?? NOTE;
  /**
   * The listing is keyed by the entry's **parent folder**, because that is how
   * `findEntry` looks it up — the root is `""`, not the folder name.
   *
   * The first version of this fixture always keyed `"1-projects"`, so the
   * `privacy.md` case found no entry at all and the pane rendered no button for
   * the wrong reason. Sabotaging the read-only check turned nothing red, which
   * is how that surfaced: the test was asserting the absence of a control on a
   * screen that had no note open.
   */
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const files = {
    canEdit: true,
    loading: false,
    busy: false,
    listings: {
      [folder]: {
        ...LISTING,
        path: folder,
        entries: [{ ...LISTING.entries[0], ...entry, path }],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: path,
    opening: null,
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
    conflict: null,
    resolveWith: () => {},
    discard: () => {},
    notice: null,
    dismissNotice: () => {},
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
    revokeShare: () => {},
    setSharePreviewTitle: () => {},
    ...over,
  } as unknown as FileBrowser;

  const data = {
    loading: false,
    contexts: [{ id: "w1", slug: "seyi", displayName: "seyi", role: "owner" }],
    selectedContextId: "w1",
    selectContext: () => {},
    storage: { status: "connected" },
    files,
    members: { rows: [], invitations: [] },
  } as unknown as ConsoleData;

  return data;
}

function paneWith(
  over: Partial<FileBrowser> = {},
  entry: Partial<FolderListing["entries"][number]> = {},
): HTMLElement {
  return mount(createElement(BrowsePane, { data: dataWith(over, entry) }));
}

/**
 * A pane that can be re-rendered, which is the only way to reach the case
 * below: `<Slot/>` in `app/(app)/console/_layout.tsx` reconciles by component
 * type with **no `key`**, so this component and its `sharing` state survive
 * `/console/@a` → `/console/@b`. A fresh mount per assertion cannot see that.
 */
function paneRoot(): {
  container: HTMLElement;
  render: (data: ConsoleData) => void;
} {
  pointerWidth();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return {
    container,
    render: (data: ConsoleData) =>
      act(() => {
        root.render(createElement(BrowsePane, { data }));
      }),
  };
}

function press(testID: string): void {
  pressIn(document.body, testID);
}

/**
 * The same press, scoped to one pane.
 *
 * `paneRoot` appends to `document.body`, so a test that mounts two panes has
 * two of every control in the document and a body-wide query answers about the
 * first one. Scoping is the difference between comparing two states and
 * pressing the same one twice.
 */
function pressIn(scope: ParentNode, testID: string): void {
  const node = scope.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no element with testID ${testID}`);
  act(() => {
    for (const type of ["mousedown", "mouseup", "click"]) {
      node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
}

/**
 * By its label, for the controls that carry no `testID`.
 *
 * The dialog's buttons are addressed the way a person addresses them, which is
 * also what a screen reader announces — and it is the assertion that survives
 * the label changing, because it fails loudly rather than silently matching
 * nothing.
 */
function pressLabel(label: string): void {
  const node = document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (node === null) throw new Error(`no control labelled ${label}`);
  for (const type of ["mousedown", "mouseup", "click"]) {
    node.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }
}

/** The dialog names the note it is about; that is what makes a stale one visible. */
const shareDialogFor = (name: string) =>
  document.body.querySelector(`[aria-label="Share ${name}"]`);

describe("an owner reading a note can share it", () => {
  /**
   * THE test. Remove the button from `BrowsePane` and this fails while every
   * assertion in `fileMenu.test.ts` stays green — which is exactly what
   * happened.
   */
  test("the open note carries a Share control", () => {
    const pane = paneWith();
    expect(pane.querySelector('[data-testid="browse-share"]')).not.toBeNull();
  });

  test("and it says what it is, with the ellipsis that promises a dialog", () => {
    expect(paneWith().textContent).toContain("Share");
  });
});

/**
 * **The button was the whole test, and everything past it was unpinned.**
 *
 * Nothing pressed it. Measured: pointing `onPress` at `"privacy.md"` — so that
 * the button on any note opens a dialog for the access map — left all 1,668
 * checks green, as did making the button inert, as did rendering the dialog
 * unconditionally for every open note. The file's own read-only test is *about*
 * `privacy.md`, which is what makes the first of those worth naming.
 */
/**
 * **Copy link did nothing, said nothing, and left you in a modal.**
 *
 * Three complaints, one press. The copy itself is `copyShareLink.test.ts` —
 * this is what the dialog does with the answer.
 *
 * The old shape relabelled its own button "Copied" and stayed open, which puts
 * the confirmation inside a modal the person has just finished with and then
 * throws it away when they close it. A copy is *invisible* — nothing on screen
 * changes, and the clipboard cannot be inspected — so it has to be confirmed
 * somewhere that outlives the moment.
 */
describe("copying a link finishes the job", () => {
  test("a copy that landed closes the dialog", async () => {
    const pane = paneRoot();
    pane.render(dataWith({ copyShareLink: async () => ({ ok: true, message: "Link copied." }) }));
    press("browse-share");
    expect(shareDialogFor("plan.md")).not.toBeNull();

    await act(async () => {
      pressLabel("Copy link");
    });

    expect(shareDialogFor("plan.md")).toBeNull();
  });

  test("…and a copy that did not stays open", async () => {
    /*
      The positive control, and a real state rather than a defensive one: a
      browser can refuse the clipboard, and a private window or blocked site
      data can take it away entirely. The notice raised in that case carries
      the URL, and closing the one surface that could show it again would be
      the unhelpful half of honesty.
    */
    const pane = paneRoot();
    pane.render(
      dataWith({
        copyShareLink: async () => ({
          ok: false,
          message: "Couldn't reach the clipboard. The link is https://context.lc/x",
        }),
      } as never),
    );
    press("browse-share");

    await act(async () => {
      pressLabel("Copy link");
    });

    expect(shareDialogFor("plan.md")).not.toBeNull();
    /*
      **And it says so inside the dialog.** The pane's notice line is *behind*
      this modal, so raising the failure there is a message nobody can read —
      which, on a platform where every copy failed, made Copy link a button
      that did nothing at all. The URL rides along because the clipboard is the
      only part that failed and the person still wants the link.
    */
    const problem = document.body.querySelector('[data-testid="share-copy-problem"]');
    expect(problem).not.toBeNull();
    expect(problem!.textContent).toContain("https://context.lc/x");
  });

  test("a link that could not be made says nothing here, because the server did", async () => {
    // `message: null` means `createTeamShare` refused and its own sentence is
    // already in the pane. Repeating a symptom over a real refusal is worse
    // than saying nothing.
    const pane = paneRoot();
    pane.render(
      dataWith({ copyShareLink: async () => ({ ok: false, message: null }) } as never),
    );
    press("browse-share");
    await act(async () => {
      pressLabel("Copy link");
    });

    expect(shareDialogFor("plan.md")).not.toBeNull();
    expect(document.body.querySelector('[data-testid="share-copy-problem"]')).toBeNull();
  });

  test("the press mints and copies in one call, naming this note", async () => {
    // One call, not "get a URL then write it" — see `copyShareLink.test.ts`
    // for why that order is the whole bug. Asserted on the argument because
    // the dialog is what decides *which* note is being copied.
    const asked: unknown[] = [];
    const pane = paneRoot();
    pane.render(
      dataWith({
        copyShareLink: async (target: unknown) => {
          asked.push(target);
          return { ok: true, message: "Link copied." };
        },
      } as never),
    );
    press("browse-share");
    await act(async () => {
      pressLabel("Copy link");
    });

    expect(asked).toEqual([{ kind: "team", path: NOTE }]);
  });
});

/**
 * **THE regression.** The lock's third position publishes a note by unlisted
 * link, and the only Copy button within reach of somebody who had just pressed
 * it minted a *team* link — a `/console/@…` URL, which shows nothing at all to
 * the person it was sent to. Reported from a real paste.
 *
 * The dialog holds three audiences now and each has its own control, so the
 * failure this pins is not "the wrong words" but "the wrong link": every check
 * below asserts which target a press asks for, because that is the thing that
 * was wrong and the thing a tidy-up could get wrong again.
 */
describe("the unlisted link has a control of its own", () => {
  const openShare = {
    shareId: "s-open",
    token: "b".repeat(64),
    recipient: "Anyone with the link",
    audience: "anyone" as const,
    entryPath: NOTE,
    titleInPreview: true,
    previewTitle: "Plan",
    createdAt: 1,
  };

  test("its press asks for the unlisted link, never the team one", async () => {
    const asked: unknown[] = [];
    const pane = paneRoot();
    pane.render(
      dataWith({
        copyShareLink: async (target: unknown) => {
          asked.push(target);
          return { ok: true, message: "Link copied." };
        },
      } as never),
    );
    press("browse-share");
    await act(async () => {
      press("share-open-link");
    });

    expect(asked).toEqual([{ kind: "link", path: NOTE }]);
  });

  /**
   * One pane per case. `ShareDialog` is a `Modal`, which react-native-web
   * renders outside the pane's own container, so a test that mounted two panes
   * to compare states would be reading one dialog twice.
   */
  test("with no link yet, it offers to create one and has nothing to revoke", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    press("browse-share");
    expect(
      document.body.querySelector('[data-testid="share-open-link"]')?.textContent,
    ).toContain("Create link");
    expect(
      document.body.querySelector('[data-testid="share-open-link-revoke"]'),
    ).toBeNull();
  });

  test("with one live, it offers to copy that link and to take it back", () => {
    const pane = paneRoot();
    pane.render(dataWith({ shares: [openShare] } as never));
    press("browse-share");
    expect(
      document.body.querySelector('[data-testid="share-open-link"]')?.textContent,
    ).toContain("Copy link");
    expect(
      document.body.querySelector('[data-testid="share-open-link-revoke"]'),
    ).not.toBeNull();
  });

  test("revoking asks for that row, and not for some other share on the note", () => {
    const revoked: string[] = [];
    const pane = paneRoot();
    pane.render(
      dataWith({
        shares: [
          { ...openShare, shareId: "s-person", audience: "name", recipient: "@lk" },
          openShare,
        ],
        revokeShare: (id: string) => revoked.push(id),
      } as never),
    );
    press("browse-share");
    press("share-open-link-revoke");
    expect(revoked).toEqual(["s-open"]);
  });

  /**
   * The sentence next to it says what revoking cannot do. An owner who thinks
   * taking the link back un-publishes the note will hand it out more freely
   * than one who knows it only closes the door.
   */
  test("the copy says a revoke cannot take back a copy already made", () => {
    const pane = paneRoot();
    pane.render(dataWith({ shares: [openShare] } as never));
    press("browse-share");
    const text = document.body.textContent ?? "";
    expect(text).toContain("ANYONE WITH THE LINK");
    expect(text).toMatch(/no account, no sign-in/i);
    expect(text).toMatch(/cannot take back a copy somebody already has/i);
  });
});

describe("the dialog is about the note the reader is looking at", () => {
  test("pressing Share opens a dialog named after this note", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    expect(shareDialogFor("plan.md")).toBeNull();
    press("browse-share");
    expect(shareDialogFor("plan.md")).not.toBeNull();
  });

  /**
   * **The one that matters.** `{sharing !== null ? <ShareDialog … />}` re-checks
   * nothing — not `canShare`, not the selection, not `readOnly` — and `<Slot/>`
   * reconciles this pane by component type with no `key`, so `sharing` survives
   * a context switch.
   *
   * Left open, submitting called the *new* context's `share` with the *old*
   * context's path. `createShare` checks `requireWorkspaceRole(owner)` and the
   * path's syntax, and never that the path exists in that workspace — so under
   * PARA conventions, where `1-projects/plan.md` plausibly exists in both, the
   * owner grants a recipient read access to a note they did not aim at.
   *
   * The guard closes the keyboard route too. `BrowsePane` reports no
   * `onOverlayChange`, so every GLOBAL binding fires behind this dialog and the
   * palette can change the selection under it; a dialog pinned to the current
   * selection cannot then act on a stale path.
   */
  test("it does not follow the reader into another context", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    press("browse-share");
    // The positive control: without it, a dialog that never opened would
    // satisfy the assertion below.
    expect(shareDialogFor("plan.md")).not.toBeNull();

    const shareB = jest.fn();
    pane.render(
      dataWith(
        { selectedPath: "1-projects/other.md", share: shareB },
        { path: "1-projects/other.md", name: "other.md" },
      ),
    );

    expect(shareDialogFor("plan.md")).toBeNull();
    expect(shareB).not.toHaveBeenCalled();
  });

  test("nor does it outlive the capability that opened it", () => {
    const pane = paneRoot();
    pane.render(dataWith());
    press("browse-share");
    expect(shareDialogFor("plan.md")).not.toBeNull();

    // Ownership can go away under a mounted console — that is the whole subject
    // of `explorerMenuStaleGate.test.ts`. A dialog is a control like any other:
    // absent, not present-and-refused.
    pane.render(dataWith({ canShare: false }));
    expect(shareDialogFor("plan.md")).toBeNull();
  });
});

describe("who does not get it", () => {
  /**
   * Owner-only, and absent rather than disabled — the same rule the menu
   * applies. Sharing decides who reads a note, which is not an editor's to
   * decide, and the server refuses them with `minimum: "owner"` regardless.
   */
  test("an editor does not", () => {
    const pane = paneWith({ canShare: false });
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });

  /**
   * `privacy.md` is the access map. Handing it to somebody enumerates every
   * private folder by name, and `createShare` refuses it — but the control must
   * not be offered in the first place.
   */
  test("a read-only file like privacy.md does not", () => {
    const pane = paneWith({}, {
      path: "privacy.md",
      name: "privacy.md",
      readOnly: true,
    });
    // The note IS open — otherwise this would pass for the wrong reason, which
    // is what the first version of this test did.
    expect(pane.textContent).toContain("privacy.md");
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });

  /**
   * The control against the one above: the same fixture, read-only off, shows
   * the button. Without this pair, a fixture that renders no note at all would
   * satisfy the negative test forever.
   */
  test("…and the same file would get one if it were an ordinary note", () => {
    const pane = paneWith({}, { path: "readme.md", name: "readme.md", readOnly: false });
    expect(pane.querySelector('[data-testid="browse-share"]')).not.toBeNull();
  });

  test("a console with nothing open does not", () => {
    const pane = paneWith({ selectedPath: null });
    expect(pane.querySelector('[data-testid="browse-share"]')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("a URL that names a note does not say 'choose a note' first", () => {
  /**
   * **Reported from a hard refresh of `/console/@seyi?note=…`: an ugly
   * flicker.**
   *
   * The note opens only once the workspace list has landed and the file browser
   * has caught up with it — a whole round trip — and until then this region drew
   * the context's name in a heading over a line telling somebody to choose a
   * note. On a URL that had already chosen one. The copy is right for an empty
   * console and is the opposite of what is happening here, and then it jumps.
   *
   * A render test rather than a pure one, because what was wrong was what was on
   * the screen during a gap that no pure function has a name for.
   */
  test("the empty state is suppressed while the named note is on its way", () => {
    const container = mount(
      createElement(BrowsePane, {
        data: dataWith({ selectedPath: null }),
        pendingNote: "1-projects/plan.md",
      }),
    );
    expect(container.textContent ?? "").not.toContain("Choose a note");
  });

  test("and is still there for a console that really has nothing open", () => {
    // The negative control. Without it, deleting `Empty` outright would pass
    // the test above — and an empty console would have nothing to say at all.
    const container = mount(
      createElement(BrowsePane, { data: dataWith({ selectedPath: null }) }),
    );
    expect(container.textContent ?? "").toContain("Choose a note");
  });

  test("nor once the browser has taken it and is reading the body", () => {
    /**
     * **The half the first fix missed, filmed on a phone.**
     *
     * `pendingNote` is `null` again the instant `select` lands — and at that
     * moment the note's body is still a Convex action away, so `selectedPath`
     * names something `entryAt` cannot answer for and the empty state came
     * straight back. In the recording it is the *longer* of the two gaps: a
     * quarter of a second of "Choose a note to read or edit it" over a URL
     * that had chosen one, on every refresh.
     *
     * The URL's own note is deliberately **not** passed here: this is the
     * state after the browser has taken it, which is exactly where the first
     * fix stopped looking.
     */
    const container = mount(
      createElement(BrowsePane, {
        /*
          A path the listings cannot answer for — which is the state, not a
          contrivance: on a cold load the only folder fetched is the root, and
          the note being opened is two levels down. `entryAt` has nothing, so
          `selected` is null and this is the branch that used to say "Choose a
          note".
        */
        data: dataWith({ selectedPath: UNLOADED, opening: UNLOADED }),
        pendingNote: null,
      }),
    );
    expect(container.textContent ?? "").not.toContain("Choose a note");
  });

  test("but a read that failed lands back on the empty state, not on a blank page", () => {
    /*
      The control on the control. `opening` is not "a path is selected" — it is
      "the contents are on their way" — and a read that comes back refused
      clears it. Were it left set, a note that genuinely will not open would be
      a blank region under a notice, with nothing telling anybody what to do
      next, and no test above would have noticed.
    */
    const container = mount(
      createElement(BrowsePane, {
        data: dataWith({ selectedPath: null, opening: null, notice: "That file does not exist." }),
        pendingNote: null,
      }),
    );
    expect(container.textContent ?? "").toContain("Choose a note");
  });

  test("a note that has opened is the note, not a blank region", () => {
    // The gap closes when the body arrives: `opening` goes back to `null` and
    // the entry is answerable, so this cannot become a pane that is
    // permanently blank.
    const container = mount(
      createElement(BrowsePane, {
        data: dataWith(),
        pendingNote: null,
      }),
    );
    expect(container.textContent ?? "").not.toContain("Choose a note");
    expect(container.textContent ?? "").not.toBe("");
  });
});
