/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * `DropboxCallbackBody` and `DropboxCard` use no router and no Convex client.
 * Their *modules* reach `expo-router`, which ships untranspiled JSX that this
 * project's jest transform does not reach into `node_modules` for. Stubbing
 * the three names is the whole of it; nothing below touches any of them.
 */
jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {} }),
}));

import { DropboxCallbackBody } from "../features/console/storage/DropboxCallbackScreen";
import { DropboxCard } from "../features/console/storage/DropboxCard";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";
import {
  DROPBOX_TIMEOUT_MESSAGE,
  type DropboxCallbackView,
  type DropboxStartState,
} from "../features/console/storage/dropbox";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The two Dropbox surfaces, on the glass.
 *
 * `dropboxConnect.test.ts` proves the rules. This proves the screens are wired
 * to them, which is a different failure and the one that ships: a resolver that
 * returns `cancelled` and a body that renders a red error panel for it would
 * pass every assertion in that file.
 *
 * Three things are asserted here that no pure function can answer:
 *
 *  1. **Cancelling does not read as a failure.** Somebody used the consent
 *     screen correctly; a page that shouts at them for it is a page that
 *     teaches people to click through consent screens.
 *  2. **Every dead end has a way out.** Including the ones a stranger can
 *     reach by opening the bare path.
 *  3. **The Dropbox button is absent, not broken, where the flow cannot
 *     finish** — and the card says where it does work.
 *
 * `react-native-web` renders these to real DOM (see `jest.config.js`), so the
 * text below is the real copy and the clicks are the clicks a person makes.
 *
 * One trap worth naming, because it has bitten this suite before:
 * `useWindowDimensions` reports `0` under jsdom, so any component with a width
 * branch silently takes the phone path here. Neither component below branches
 * on width — the title size is clamped, not switched — so nothing in this file
 * is quietly testing only half of a layout.
 */

interface Screen {
  text: string;
  q: (testID: string) => HTMLElement | null;
  click: (testID: string) => void;
  type: (testID: string, value: string) => void;
  unmount: () => void;
}

function mount(node: ReturnType<typeof createElement>): Screen {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(node);
  });
  const q = (testID: string) =>
    container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
  return {
    get text() {
      return container.textContent ?? "";
    },
    q,
    click: (testID: string) => {
      const element = q(testID);
      if (element === null) throw new Error(`no control called ${testID}`);
      act(() => {
        element.click();
      });
    },
    type: (testID: string, value: string) => {
      const element = q(testID) as HTMLInputElement | null;
      if (element === null) throw new Error(`no field called ${testID}`);
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function mountBody(view: DropboxCallbackView, onLeave: (href: string) => void = () => {}): Screen {
  return mount(createElement(DropboxCallbackBody, { view, onLeave }));
}

function mountCard(
  overrides: {
    redirectUri?: string | null;
    state?: DropboxStartState;
    start?: (folder?: string) => void;
    note?: string;
  } = {},
): Screen {
  return mount(
    createElement(DropboxCard, {
      redirectUri:
        overrides.redirectUri === undefined
          ? "https://context.lc/connect/dropbox"
          : overrides.redirectUri,
      state: overrides.state ?? { kind: "idle" },
      start: overrides.start ?? (() => {}),
      note: overrides.note,
    }),
  );
}

describe("the callback screen's body", () => {
  test("while the exchange runs it says what it is doing", () => {
    const screen = mountBody({ kind: "working", message: "Finishing the connection…" });
    expect(screen.q("dropbox-working")).not.toBe(null);
    expect(screen.text).toContain("Finishing the connection…");
    screen.unmount();
  });

  /**
   * They were shown what Context asked for and said no. That is a consent
   * screen working. A page that renders it in the critical tone, beside the
   * word "error", teaches people that refusing is a mistake.
   */
  test("cancelling reads as an answer, not a failure", () => {
    const screen = mountBody({ kind: "cancelled" });
    expect(screen.q("dropbox-cancelled")).not.toBe(null);
    expect(screen.text).toContain("nothing was shared");
    expect(screen.text.toLowerCase()).not.toContain("failed");
    // It names the other path, because somebody who refused Dropbox has not
    // refused having a context.
    expect(screen.text).toContain("bucket");
    screen.unmount();
  });

  test("a visit with nothing to finish says so without diagnosing a code", () => {
    const screen = mountBody({ kind: "incomplete" });
    expect(screen.q("dropbox-incomplete")).not.toBe(null);
    expect(screen.text).toContain("nothing to finish");
    expect(screen.text).not.toMatch(/expired|invalid|spent/i);
    screen.unmount();
  });

  test("success points at the context that was connected, and says the files are plain", () => {
    const seen: string[] = [];
    const screen = mountBody(
      { kind: "connected", href: "/console/seyi/settings" },
      (href) => seen.push(href),
    );
    expect(screen.text).toContain("Dropbox is connected");
    expect(screen.text).toContain("plain Markdown");
    screen.click("dropbox-primary");
    expect(seen).toEqual(["/console/seyi/settings"]);
    screen.unmount();
  });

  test("a timeout is a wait, not a verdict, and still has a way on", () => {
    const seen: string[] = [];
    const screen = mountBody({ kind: "timeout", message: DROPBOX_TIMEOUT_MESSAGE }, (href) =>
      seen.push(href),
    );
    expect(screen.text).toContain("Nothing is lost");
    screen.click("dropbox-primary");
    expect(seen).toEqual(["/console"]);
    screen.unmount();
  });

  test("a failure shows the fix and the provider's own words together", () => {
    const screen = mountBody({
      kind: "failed",
      failure: {
        headline: "That Dropbox connection has expired",
        next: "Start it again.",
        detail: "invalid_grant",
      },
    });
    expect(screen.text).toContain("That Dropbox connection has expired");
    expect(screen.text).toContain("Start it again.");
    expect(screen.text).toContain("invalid_grant");
    screen.unmount();
  });

  /**
   * Every branch a person can land on has to have somewhere to go — including
   * the ones a stranger reaches by opening the bare path. `/console` answers
   * for itself: an account with no contexts is sent to `/welcome`, so no
   * button here can strand anybody.
   */
  test.each<[string, DropboxCallbackView]>([
    ["cancelled", { kind: "cancelled" }],
    ["incomplete", { kind: "incomplete" }],
    ["timeout", { kind: "timeout", message: "…" }],
    ["failed", { kind: "failed", failure: { headline: "no" } }],
  ])("the %s screen is never a dead end", (_name, view) => {
    const seen: string[] = [];
    const screen = mountBody(view, (href) => seen.push(href));
    screen.click("dropbox-primary");
    expect(seen).toEqual(["/console"]);
    screen.unmount();
  });

  test("the states that render nothing render nothing", () => {
    for (const view of [{ kind: "wait" } as const, { kind: "signIn", href: "/login" } as const]) {
      const screen = mountBody(view);
      expect(screen.text).toBe("");
      screen.unmount();
    }
  });
});

describe("the Connect Dropbox card", () => {
  test("the consent screen's promise is on the card before anybody presses it", () => {
    const screen = mountCard();
    // "its own folder", not "all your Dropbox" — the same words the Dropbox
    // consent screen uses for an App Folder scoped app.
    expect(screen.text).toContain("its own folder");
    expect(screen.text).toContain("byte-identical");
    screen.unmount();
  });

  /**
   * The common case asks nothing. A folder picker in front of every person
   * connecting an app folder we already have is a question with a known
   * answer — the same restraint the bucket form's addressing question follows.
   */
  test("no folder is asked for by default, and none is sent", () => {
    const calls: Array<string | undefined> = [];
    const screen = mountCard({ start: (folder) => calls.push(folder) });
    expect(screen.q("dropbox-folder")).toBe(null);
    screen.click("dropbox-connect");
    expect(calls).toEqual([undefined]);
    screen.unmount();
  });

  /**
   * `CLAUDE.md` forbids us namespacing inside somebody's storage and permits
   * only a root prefix the customer chose. So the field, when it appears,
   * appears **empty** — a value we derived from a workspace id and dropped in
   * the box is not a value they chose, it just looks like one.
   */
  test("the second-context field opens empty, never prefilled from anything", () => {
    const screen = mountCard();
    screen.click("dropbox-folder-disclose");
    const field = screen.q("dropbox-folder") as HTMLInputElement | null;
    expect(field).not.toBe(null);
    expect(field?.value).toBe("");
    screen.unmount();
  });

  test("a folder somebody typed is what gets sent", () => {
    const calls: Array<string | undefined> = [];
    const screen = mountCard({ start: (folder) => calls.push(folder) });
    screen.click("dropbox-folder-disclose");
    screen.type("dropbox-folder", "  second/  ");
    screen.click("dropbox-connect");
    expect(calls).toEqual(["second/"]);
    screen.unmount();
  });

  test("opening the field and leaving it empty still sends nothing", () => {
    const calls: Array<string | undefined> = [];
    const screen = mountCard({ start: (folder) => calls.push(folder) });
    screen.click("dropbox-folder-disclose");
    screen.click("dropbox-connect");
    expect(calls).toEqual([undefined]);
    screen.unmount();
  });

  test("a traversal is refused before anything leaves the page", () => {
    const calls: Array<string | undefined> = [];
    const screen = mountCard({ start: (folder) => calls.push(folder) });
    screen.click("dropbox-folder-disclose");
    screen.type("dropbox-folder", "a/../../b");
    screen.click("dropbox-connect");
    expect(calls).toEqual([]);
    expect(screen.text).toContain("`..`");
    screen.unmount();
  });

  /**
   * Dropbox matches `redirect_uri` exactly and only two are registered. On a
   * native build, or a dev server on the wrong port, the honest move is to say
   * where this works — not to offer a button that ends on Dropbox's own error
   * page, off our domain, with nothing a person can act on.
   */
  test("where the flow cannot finish there is no button, and an address instead", () => {
    const screen = mountCard({ redirectUri: null });
    expect(screen.q("dropbox-connect")).toBe(null);
    expect(screen.q("dropbox-folder-disclose")).toBe(null);
    expect(screen.q("dropbox-unavailable")).not.toBe(null);
    expect(screen.text).toContain("https://context.lc");
    // And it says the other path is unaffected, so nobody reads this as
    // "storage cannot be connected here".
    expect(screen.text).toContain("Connecting a bucket works from anywhere");
    screen.unmount();
  });

  test("the note about leaving the page is only where the button is", () => {
    const withButton = mountCard({ note: "This leaves the page." });
    expect(withButton.text).toContain("This leaves the page.");
    withButton.unmount();

    const without = mountCard({ redirectUri: null, note: "This leaves the page." });
    expect(without.text).not.toContain("This leaves the page.");
    without.unmount();
  });

  test("a start that failed shows the failure, and the button comes back", () => {
    const screen = mountCard({
      state: { kind: "failed", failure: { headline: "Dropbox isn't set up", next: "Use a bucket." } },
    });
    expect(screen.text).toContain("Dropbox isn't set up");
    expect(screen.text).toContain("Use a bucket.");
    expect(screen.q("dropbox-connect")).not.toBe(null);
    screen.unmount();
  });

  test("while starting, the button says so and is not pressable twice", () => {
    const calls: Array<string | undefined> = [];
    const screen = mountCard({ state: { kind: "starting" }, start: (f) => calls.push(f) });
    expect(screen.text).toContain("Opening Dropbox…");
    screen.click("dropbox-connect");
    expect(calls).toEqual([]);
    screen.unmount();
  });
});

/**
 * A Dropbox binding, on the settings pane.
 *
 * The pane was written when every binding had a bucket, an endpoint, a region
 * and an access key, and it drew all four unconditionally. A Dropbox row has
 * none of them, so the untouched pane drew four labelled wells with nothing in
 * them — which reads as a screen that failed to load somebody's credentials
 * rather than one describing a backend that has none. Same family as #25: a
 * confident-looking claim with nothing behind it.
 *
 * `storageActions` is present in the fixture because every control on this pane
 * is owner-only and absent otherwise; this is an owner looking at their own
 * context, which is the only person who sees any of it.
 */
function consoleData(storage: Partial<ConsoleStorage>): ConsoleData {
  return {
    demo: false,
    avatarInitial: "S",
    contexts: [
      { id: "w1", slug: "seyi", displayName: "Seyi", role: "owner", kind: "personal", status: "ok" },
    ],
    selectedContextId: "w1",
    selectContext: () => {},
    graph: { nodes: [], edges: [] },
    stats: [],
    clients: [],
    storage: {
      connected: true,
      status: "connected",
      provider: "dropbox",
      conditionalWrite: true,
      updatedAt: 0,
      ...storage,
    },
    storageActions: {
      workspaceId: "w1",
      reverify: async () => ({ queued: true, status: "unverified" }),
      connect: async () => ({ status: "unverified" }),
      disconnect: async () => ({ disconnected: true }),
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files: { listings: {} },
    members: { members: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

function mountSettings(storage: Partial<ConsoleStorage>): Screen {
  return mount(
    createElement(SettingsPane, { data: consoleData(storage), onClose: () => {} }),
  );
}

describe("a Dropbox binding on the settings pane", () => {
  test("draws no empty bucket, endpoint or access-key wells", () => {
    const screen = mountSettings({});
    expect(screen.text).toContain("Dropbox");
    expect(screen.text).not.toContain("Bucket");
    expect(screen.text).not.toContain("Endpoint");
    expect(screen.text).not.toContain("Access key");
    screen.unmount();
  });

  /**
   * "Which folder is this?" is the first question somebody has about a Dropbox
   * connection, and the answer the consent screen promised is "its own folder,
   * not your account". An absent row would leave that unanswered.
   */
  test("says which folder, both when there is a prefix and when there is not", () => {
    const plain = mountSettings({});
    expect(plain.text).toContain("Context's own app folder");
    plain.unmount();

    const nested = mountSettings({ rootPrefix: "second/" });
    expect(nested.text).toContain("second/");
    nested.unmount();
  });

  // A Dropbox binding has no key to rotate. Offering "Rotate key" against one
  // names a credential that has never existed for it.
  test("offers Reconnect rather than Rotate key", () => {
    const screen = mountSettings({});
    expect(screen.q("storage-rebind")?.textContent).toContain("Reconnect");
    expect(screen.text).not.toContain("Rotate key");
    screen.unmount();
  });

  test("the revocation sentence names Dropbox's own setting, not a provider key", () => {
    const screen = mountSettings({});
    expect(screen.text).toContain("Unlink Context in your Dropbox account settings");
    screen.unmount();
  });

  /**
   * The failure panel has to be described with the provider in hand. Without
   * it the pane tells a Dropbox owner to paste an access key and secret — a
   * field that is not on their screen and a credential they have never had.
   */
  test("a failed Dropbox binding is not described as a bucket", () => {
    const screen = mountSettings({
      connected: false,
      status: "error",
      errorCode: "CREDENTIAL_UNAVAILABLE",
    });
    expect(screen.text).toContain("Reconnect Dropbox to replace it");
    expect(screen.text).not.toMatch(/Paste the access key/);
    screen.unmount();
  });

  /**
   * A regression the type checker cannot see.
   *
   * `endpoint`, `region` and `bucket` became optional on `ConsoleStorage` when
   * Dropbox arrived. `ConnectForm` spreads `initial` **over**
   * `emptyConnectForm()`, and an explicit `undefined` wins a spread — so
   * passing them straight through leaves `values.endpoint` undefined and
   * `values.endpoint.trim()` throws the moment the form validates.
   * `Partial<ConnectFormValues>` accepts `undefined` happily, so `tsc` is
   * silent about it and the crash only shows up under a finger.
   */
  test("rotating a key on a row with a missing field does not crash the form", () => {
    const screen = mountSettings({ provider: "s3-compatible", bucket: "example-bucket" });
    screen.click("storage-rebind");
    expect(screen.q("connect-endpoint")).not.toBe(null);
    expect((screen.q("connect-endpoint") as HTMLInputElement).value).toBe("");
    expect((screen.q("connect-bucket") as HTMLInputElement).value).toBe("example-bucket");
    screen.unmount();
  });

  // The bucket pane is untouched: same fields, same "Rotate key", same sentence.
  test("an S3 binding still shows its bucket and offers Rotate key", () => {
    const screen = mountSettings({
      provider: "r2",
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAM…PLE",
    });
    expect(screen.text).toContain("example-bucket");
    expect(screen.q("storage-rebind")?.textContent).toContain("Rotate key");
    expect(screen.text).toContain("Revoke the key at your provider");
    screen.unmount();
  });
});
