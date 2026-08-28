/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * TWO DEAD ENDS IN THE SIGNED-IN CONSOLE.
 *
 * Both were reported from the same screenshot, and they are the same shape of
 * bug: a state the product handles correctly everywhere except at the one place
 * a person standing in it can act.
 *
 * **1. Somebody invited into another person's context could not get one of
 * their own.** `needsOnboarding` renders rather than redirects for them, on
 * purpose — sending an invitee to "claim your name" throws away the invitation
 * that brought them here — and it says the prompt "belongs on a banner rather
 * than in a redirect". There was no banner. `/welcome` was ready for them
 * (`resolveWelcomeRoute` asks about contexts *owned*, so it renders at zero)
 * and nothing anywhere in the app linked to it. Being given a context was a
 * one-way door out of ever having one.
 *
 * **2. A bucket whose `privacy.md` cannot be read had no repair.** The banner
 * said "Write a valid privacy.md at the root of the bucket, or ask a connected
 * AI client to". Both are refused: the console's `writeFile` answers
 * `PRIVACY_MANIFEST_READ_ONLY` for that key, the gateway's `write_note` answers
 * "that path is reserved", and `set_folder_visibility` answers "privacy.md is
 * required before folder visibility can be changed". The instruction described
 * two things that cannot happen, in the one state where nothing else works
 * either.
 *
 * The assertions below are literal about *absence* as well as presence, because
 * both controls are dangerous in the wrong hands: a claim entry in front of
 * somebody who already owns a context leads to a screen that bounces them, and
 * a reset offered to an editor is a button whose only outcome is a permission
 * error over the file that decides what that editor may see.
 */

const { offerOwnContext } =
  require("../features/onboarding/route") as typeof import("../features/onboarding/route");

describe("offerOwnContext — whether the console should offer to make you one", () => {
  const invitee = [{ kind: "personal", role: "editor" }];
  const owner = [{ kind: "personal", role: "owner" }];

  test("offered to somebody who can reach a context and owns none", () => {
    expect(offerOwnContext({ contexts: invitee, loading: false })).toBe(true);
  });

  test("offered to an account that can reach nothing at all", () => {
    // The `(app)` gate normally redirects these people to `/welcome` before the
    // console renders. If one ever gets here anyway, the answer is still yes.
    expect(offerOwnContext({ contexts: [], loading: false })).toBe(true);
  });

  test("not offered to somebody who already owns one", () => {
    expect(offerOwnContext({ contexts: owner, loading: false })).toBe(false);
    expect(offerOwnContext({ contexts: [...owner, ...invitee], loading: false })).toBe(false);
  });

  test("never offered on a list that has not landed", () => {
    // `undefined` is not "owns nothing". A prompt that flashes on every cold
    // load in front of somebody who has had a context for a year is the same
    // mistake as redirecting them into onboarding.
    expect(offerOwnContext({ contexts: undefined, loading: true })).toBe(false);
    expect(offerOwnContext({ contexts: undefined, loading: false })).toBe(false);
    expect(offerOwnContext({ contexts: [], loading: true })).toBe(false);
  });

  test("a shared context you own a role in is not a personal context you own", () => {
    // `createWorkspace` writes exactly one personal context per person, and it
    // is the thing onboarding produces. Counting a shared workspace here would
    // hide the prompt from somebody who genuinely has no context of their own.
    expect(offerOwnContext({ contexts: [{ kind: "shared", role: "owner" }], loading: false })).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                        the console, actually mounted                        */
/* -------------------------------------------------------------------------- */

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
const mockPushed: string[] = [];

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => ({
  Slot: () => null,
  useRouter: () => ({
    replace: () => {},
    push: (href: string) => {
      mockPushed.push(href);
    },
  }),
  usePathname: () => "/console/@someone-else",
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

jest.mock("../features/console/useLiveConsoleData", () => ({
  useLiveConsoleData: () => mockConsoleData(),
}));

const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

/**
 * What the console is showing, as the two features see it.
 *
 * Defaults describe the reported case exactly: signed in, one context that
 * belongs to somebody else, editor role, and a manifest nothing can read.
 */
interface Shape {
  role?: string;
  kind?: string;
  manifestUsable?: boolean;
  canResetPrivacy?: boolean;
  loading?: boolean;
  onReset?: () => void;
}

let shape: Shape = {};

function mockConsoleData(): never {
  const role = shape.role ?? "editor";
  const files = {
    canEdit: role !== "member",
    loading: false,
    busy: false,
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: shape.manifestUsable ?? false,
        entries: [],
      },
    },
    expanded: new Set<string>(),
    toggleFolder: () => {},
    selectedPath: null,
    select: () => {},
    editor: emptyEditor,
    setDraft: () => {},
    save: () => {},
    useTheirs: () => {},
    keepMine: () => {},
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
    resetPrivacy: shape.onReset ?? (() => {}),
    canResetPrivacy: shape.canResetPrivacy ?? role === "owner",
  };

  return {
    demo: false,
    avatarInitial: "S",
    contexts: [
      {
        id: "w1",
        slug: "someone-else",
        displayName: "Someone Else",
        role,
        kind: shape.kind ?? "personal",
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
    ingestionAddress: "someone-else@context.lc",
    ingestion: { settings: null, loading: false },
    files,
    members: { members: [], loading: false },
    loading: shape.loading ?? false,
    failure: null,
  } as never;
}

const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

function mountConsole(next: Shape = {}) {
  shape = next;
  mockPushed.length = 0;

  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the full trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: 1440,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 900,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });

  return {
    text: () => container.textContent ?? "",
    find: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    byLabel: (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`),
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the rail offers a context of your own when you have none", () => {
  test("an invitee reading somebody else's context is shown the way in", () => {
    const app = mountConsole({ role: "editor" });

    const entry = app.find("rail-claim-context");
    expect(entry).not.toBeNull();
    // The label survives for a screen reader, which is the rule every other
    // rail entry follows and the one a collapsed rail would otherwise break.
    expect(app.byLabel("Claim your name and create your own context")).not.toBeNull();

    app.unmount();
  });

  test("pressing it goes to onboarding, which is the screen that can do it", () => {
    const app = mountConsole({ role: "editor" });

    app.press(app.find("rail-claim-context"));

    // `push`, not `replace`: onboarding has no Back of its own, so the browser's
    // is the only way back to the context they were reading.
    expect(mockPushed).toEqual(["/welcome"]);

    app.unmount();
  });

  test("an owner is never shown it — onboarding is not re-runnable", () => {
    const app = mountConsole({ role: "owner" });
    expect(app.find("rail-claim-context")).toBeNull();
    app.unmount();
  });

  test("it does not flash while the context list is still loading", () => {
    const app = mountConsole({ role: "editor", loading: true });
    expect(app.find("rail-claim-context")).toBeNull();
    app.unmount();
  });
});

/**
 * The pane itself, not the layout.
 *
 * `Slot` is the route and it is mocked to `null` above, so the console layout
 * renders the rail and the frame and no pane at all. Browse is mounted directly
 * over the same shape — which is also how `consoleVisibilityRender.test.ts`
 * asserts the tier notice one line above this one.
 */
const { BrowsePane } =
  require("../features/console/panes/BrowsePane") as typeof import("../features/console/panes/BrowsePane");

function mountBrowse(next: Shape) {
  shape = next;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(BrowsePane, { data: mockConsoleData() }));
  });

  return {
    text: () => container.textContent ?? "",
    find: (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`),
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("a privacy.md that cannot be read has a way out of the console", () => {
  test("the owner is offered the reset", () => {
    const pane = mountBrowse({ role: "owner", manifestUsable: false });
    expect(pane.find("browse-reset-privacy")).not.toBeNull();
    pane.unmount();
  });

  test("pressing it calls the repair", () => {
    let called = 0;
    const pane = mountBrowse({
      role: "owner",
      manifestUsable: false,
      onReset: () => {
        called += 1;
      },
    });

    pane.press(pane.find("browse-reset-privacy"));

    expect(called).toBe(1);
    pane.unmount();
  });

  test("a working manifest gets neither the warning nor the button", () => {
    const pane = mountBrowse({ role: "owner", manifestUsable: true });
    expect(pane.find("browse-reset-privacy")).toBeNull();
    expect(pane.text()).not.toContain("privacy.md is missing or could not be read");
    pane.unmount();
  });

  test("an editor gets the explanation and no button, because it is not theirs to fix", () => {
    const pane = mountBrowse({ role: "editor", manifestUsable: false });

    expect(pane.text()).toContain("privacy.md is missing or could not be read");
    expect(pane.find("browse-reset-privacy")).toBeNull();
    expect(pane.text()).toContain("Only the owner of this context can rewrite it");

    pane.unmount();
  });

  test("the banner no longer tells anybody to do the two things that cannot work", () => {
    // Both were refused by every write path in the product. The sentence sent
    // people to rclone or to a client that answers "that path is reserved".
    for (const role of ["owner", "editor"]) {
      const pane = mountBrowse({ role, manifestUsable: false });
      const text = pane.text();
      expect(text).toContain("privacy.md is missing or could not be read");
      expect(text).not.toContain("ask a connected AI client to");
      expect(text).not.toContain("Write a valid privacy.md at the root of the bucket");
      pane.unmount();
    }
  });

  test("the reset is described as changing nothing about who can see what", () => {
    // The one thing an owner must be able to predict before pressing it. A
    // repair that might publish a folder is a repair nobody should press on a
    // context they share with four people.
    const pane = mountBrowse({ role: "owner", manifestUsable: false });
    expect(pane.text()).toContain("every one of them private");
    expect(pane.text()).toContain("Nothing becomes visible to anybody");
    pane.unmount();
  });

  test("the button is absent, never disabled, on the console that cannot act", () => {
    // The demo on the landing page runs these same components. `canResetPrivacy`
    // is false there, and a control that appears to work and does nothing is the
    // failure mode `browser.ts` documents at length.
    const pane = mountBrowse({ role: "owner", manifestUsable: false, canResetPrivacy: false });
    expect(pane.find("browse-reset-privacy")).toBeNull();
    pane.unmount();
  });
});
