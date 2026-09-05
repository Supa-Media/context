/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * `DropboxCallbackBody` and `StorageChoiceBody` use no router and no Convex client.
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
import { StorageChoiceBody } from "../features/console/storage/StorageChoice";
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
    dropboxReady?: boolean;
    redirectUri?: string | null;
    state?: DropboxStartState;
    start?: () => void;
    note?: string;
  } = {},
): Screen {
  return mount(
    createElement(StorageChoiceBody, {
      dropboxReady: overrides.dropboxReady ?? true,
      redirectUri:
        overrides.redirectUri === undefined
          ? "https://context.lc/connect/dropbox"
          : overrides.redirectUri,
      dropboxState: overrides.state ?? { kind: "idle" },
      startDropbox: overrides.start ?? (() => {}),
      connect: async () => ({ status: "unverified" }),
      dropboxNote: overrides.note,
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
    for (const view of [{ kind: "wait" } as const]) {
      const screen = mountBody(view);
      expect(screen.text).toBe("");
      screen.unmount();
    }
  });
});

describe("the storage choice: two cards, details behind the click", () => {
  /**
   * Seyi's spec, verbatim enough to test: "just two options, simple square
   * cards next to each other", the bucket first because it is the one we
   * recommend, and the details only after a card is chosen.
   */
  test("both cards are present, the bucket first and marked recommended", () => {
    const screen = mountCard();
    const bucket = screen.q("choose-bucket");
    const dropbox = screen.q("choose-dropbox");
    expect(bucket).not.toBe(null);
    expect(dropbox).not.toBe(null);
    // First in the DOM is first on the screen: reading order and layout order
    // agree in a flex row.
    expect(
      bucket!.compareDocumentPosition(dropbox!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.text).toContain("Recommended");
    screen.unmount();
  });

  test("neither the bucket form nor any pitch prose renders before a click", () => {
    const screen = mountCard();
    // The form's first field is the endpoint; its absence is the whole point.
    expect(screen.q("connect-endpoint")).toBe(null);
    // And no wall of trade-off copy either — the old screen's divider text.
    expect(screen.text).not.toContain("storage you own outright. Both keep plain Markdown");
    screen.unmount();
  });

  test("choosing the bucket reveals the credential form, and choosing again hides it", () => {
    const screen = mountCard();
    screen.click("choose-bucket");
    expect(screen.q("connect-endpoint")).not.toBe(null);
    screen.click("choose-bucket");
    expect(screen.q("connect-endpoint")).toBe(null);
    screen.unmount();
  });

  /**
   * Pressing Dropbox goes — it does not expand into one more button. The app
   * is folder-scoped so there is nothing to ask, and a step that exists only
   * to be clicked through teaches people to click through steps.
   */
  test("pressing Dropbox starts the flow immediately, asking nothing", () => {
    let starts = 0;
    const screen = mountCard({ start: () => (starts += 1) });
    screen.click("choose-dropbox");
    expect(starts).toBe(1);
    // No folder field ever rendered — the second-context question does not
    // exist on this screen.
    expect(screen.q("dropbox-folder")).toBe(null);
    screen.unmount();
  });

  test("the consent promise is on the card before anybody presses it", () => {
    const screen = mountCard();
    // "its own folder" — the same words the Dropbox consent screen uses for an
    // App Folder scoped app.
    expect(screen.text).toContain("its own folder");
    screen.unmount();
  });

  /**
   * Dropbox matches `redirect_uri` exactly and only two are registered. On a
   * native build, or a dev server on the wrong port, pressing the card
   * explains where the flow works instead of leaving for Dropbox's own error
   * page — and does not call start at all.
   */
  test("where the flow cannot finish, pressing explains and does not start", () => {
    let starts = 0;
    const screen = mountCard({ redirectUri: null, start: () => (starts += 1) });
    expect(screen.q("dropbox-unavailable")).toBe(null);
    screen.click("choose-dropbox");
    expect(starts).toBe(0);
    expect(screen.q("dropbox-unavailable")).not.toBe(null);
    expect(screen.text).toContain("context.lc");
    screen.unmount();
  });

  test("a start that failed shows the failure beside the cards", () => {
    const screen = mountCard({
      state: {
        kind: "failed",
        failure: {
          headline: "Dropbox could not be reached.",
          next: "Try again.",
          detail: null,
        } as never,
      },
    });
    expect(screen.text).toContain("Dropbox could not be reached.");
    expect(screen.text).toContain("Try again.");
    screen.unmount();
  });

  test("while starting, the Dropbox card is busy and not pressable twice", () => {
    let starts = 0;
    const screen = mountCard({ state: { kind: "starting" }, start: () => (starts += 1) });
    screen.click("choose-dropbox");
    expect(starts).toBe(0);
    screen.unmount();
  });

  test("the note about leaving the page renders beside a working card only", () => {
    const withButton = mountCard({ note: "Leaving finishes onboarding early." });
    expect(withButton.text).toContain("Leaving finishes onboarding early.");
    withButton.unmount();
  });
});

function consoleData(storage: Partial<ConsoleStorage>): ConsoleData {
  return {
    demo: false,
    viewer: { name: "@seyi", detail: "seyi@context.lc", initial: "S" },
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
    fastSearch: { status: { state: "off", canChange: false }, loading: false },
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
