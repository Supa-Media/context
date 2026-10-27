/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";

/**
 * `StorageChoice` and the settings pane use no router. Their *modules* reach
 * `expo-router`, which ships untranspiled JSX that this project's jest
 * transform does not reach into `node_modules` for. Stubbing the names is the
 * whole of it; nothing below touches any of them.
 */
jest.mock("expo-router", () => ({
  Redirect: () => null,
  Stack: () => null,
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: () => {} }),
}));

import { StorageChoice } from "../features/console/storage/StorageChoice";
import { SettingsPane } from "../features/console/panes/SettingsPane";
import type { ConsoleData, ConsoleStorage } from "../features/console/types";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The storage surfaces, on the glass.
 *
 * What is asserted here is what no pure function can answer: that the choice
 * screen and the settings pane are wired to the rules, and that a binding on a
 * provider this build no longer runs gets an honest notice rather than a crash
 * or a set of controls that assume a provider it does not have.
 *
 * One trap worth naming, because it has bitten this suite before:
 * `useWindowDimensions` reports `0` under jsdom, so any component with a width
 * branch silently takes the phone path here.
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
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  act(() => {
    root.render(node);
  });
  const q = (testID: string) => container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
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
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
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

function mountCard(
  overrides: {
    managed?: { price: string; onChoose: () => void };
  } = {},
): Screen {
  return mount(
    createElement(StorageChoice, {
      connect: async () => ({ status: "unverified" }),
      managed: overrides.managed,
    }),
  );
}

describe("the storage choice: two paths, provider details behind the click", () => {
  test("starts with control versus convenience and gives managed storage its 50 GB", () => {
    const screen = mountCard({
      managed: { price: "$5/month", onChoose: () => {} },
    });
    const own = screen.q("choose-own-storage");
    const managed = screen.q("choose-managed");
    expect(own).not.toBe(null);
    expect(managed).not.toBe(null);
    expect(own!.compareDocumentPosition(managed!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.text).toContain("Bring your own storage");
    expect(screen.text).toContain("Context-managed Premium storage");
    expect(screen.text).toContain("50 GB");
    expect(screen.text).not.toContain("Recommended");
    expect(screen.q("choose-bucket")).toBe(null);
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
    screen.click("choose-own-storage");
    screen.click("choose-bucket");
    expect(screen.q("connect-endpoint")).not.toBe(null);
    screen.click("choose-bucket");
    expect(screen.q("connect-endpoint")).toBe(null);
    screen.unmount();
  });

  test("opening your own storage offers the S3-compatible card and nothing else", () => {
    const screen = mountCard();
    screen.click("choose-own-storage");
    expect(screen.q("choose-bucket")).not.toBe(null);
    expect(screen.q("own-storage-providers")?.querySelectorAll('[data-testid^="choose-"]').length).toBe(1);
    screen.unmount();
  });
});

describe("storage settings import", () => {
  test("offers the Obsidian or Markdown importer after storage is connected", () => {
    const watch = {
      localQueryResult: () => null,
      onUpdate: () => () => {},
      journal: () => undefined,
    };
    const client = {
      action: async () => ({}),
      mutation: async () => ({}),
      watchQuery: () => watch,
    } as never;
    const screen = mount(
      createElement(
        ConvexProvider,
        { client },
        createElement(SettingsPane, {
          data: consoleData({ connected: true }),
          onClose: () => {},
          section: "storage",
        }),
      ),
    );
    expect(screen.q("settings-vault-import")).not.toBe(null);
    expect(screen.text).toContain("Have an Obsidian vault or existing Markdown notes?");
    expect(screen.text).toContain("How should these notes be added?");
    expect(screen.text).toContain("Merge without replacing");
    expect(screen.text).toContain("Keep it in its own folder");
    screen.unmount();
  });
});

function consoleData(storage: Partial<ConsoleStorage>): ConsoleData {
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
      provider: "r2",
      conditionalWrite: true,
      updatedAt: 0,
      ...storage,
    },
    storageActions: {
      workspaceId: "w1",
      reverify: async () => ({ queued: true, status: "unverified" }),
      connect: async () => ({ status: "unverified" }),
      handoff: async () => ({ started: true }),
      move: async () => ({ started: true }),
      cancelHandoff: async () => ({ cancelled: true }),
      chooseExistingFiles: async () => ({ resumed: true as const }),
      disconnect: async () => ({ disconnected: true }),
    },
    endpoint: "https://example.invalid/mcp",
    ingestionAddress: "seyi@context.lc",
    ingestion: { settings: null, loading: false },
    files: { listings: {} },
    /*
      A whole members view, not the two fields this file's own subject needs:
      the settings pane renders People now, so a stub missing `invitations`
      crashes a section this test is not about. Complete rather than tolerated.
    */
    members: {
      members: [],
      invitations: [],
      loading: false,
      failure: null,
      canInvite: false,
    },
    /*
      Same reason as `members` above: the settings pane now renders Shared
      links and Advanced too, so a stub missing either crashes a section this
      file is not about.
    */
    shares: { shares: [], loading: false, failure: null },
    groups: { groups: [], loading: false },
    advanced: {
      audit: { events: [], loading: false, failure: null },
    },
    fastSearch: { status: { state: "off", canChange: false }, loading: false },
    /*
      The settings pane renders Plugins, and its view is a union with no
      tolerable absent member — `undefined` there is not "no plugins", it is a
      pane that throws. `idle` is what a live console rests at before anybody
      asks for a scan, so it is also the right stub.
    */
    plugins: { state: "idle" },
    // Same reason as `plugins` above: the settings pane renders this section
    // whatever else it is showing, and its view has no tolerable absent member.
    // `loading` is where a live console rests until the read lands.
    contextPlugins: { state: "loading" },
    // And again for the third plugin read. This fixture is `as never`, so a
    // field added to `ConsoleData` does not fail typecheck here — it fails at
    // render, which is how this one arrived. `loading` is where a live console
    // rests until the pointer read lands.
    pluginInstalls: { state: "loading", read: async () => {} },
    pluginGrants: { grants: [], loading: false },
    pluginBrowse: { query: "", limit: 20, searching: false, failure: null },
    pluginRuntime: { states: [], loading: false },
    loading: false,
    failure: null,
  } as never;
}

function mountSettings(storage: Partial<ConsoleStorage>): Screen {
  return mount(
    createElement(SettingsPane, {
      data: consoleData(storage),
      onClose: () => {},
    }),
  );
}

describe("a binding on a provider this build no longer supports", () => {
  /**
   * The binding still names a provider this build cannot run (until its
   * cleanup lands). Every switch on provider has to answer "not supported"
   * for it: no key rotation, no disconnect, no failure copy that names a
   * credential the binding never had, and no crash.
   */
  test("the settings pane says so and offers no controls for it", () => {
    const screen = mountSettings({
      provider: "retired-provider",
      bucket: undefined,
      endpoint: undefined,
    });
    expect(screen.q("storage-unsupported")).not.toBe(null);
    expect(screen.text).toContain("no longer supported");
    expect(screen.q("storage-rebind")).toBe(null);
    expect(screen.q("storage-disconnect")).toBe(null);
    expect(screen.text).not.toContain("Rotate key");
    // The way forward is the same choice a new connection gets.
    expect(screen.q("choose-own-storage")).not.toBe(null);
    screen.unmount();
  });

  test("a failed binding on that provider is not described as a bucket", () => {
    const screen = mountSettings({
      provider: "retired-provider",
      connected: false,
      status: "error",
      errorCode: "CREDENTIAL_UNAVAILABLE",
    });
    expect(screen.text).not.toMatch(/Paste the access key/);
    expect(screen.text).not.toContain("Rotate key");
    screen.unmount();
  });
});

describe("an S3 binding on the settings pane", () => {
  test("rotating a key on a row with a missing field does not crash the form", () => {
    const screen = mountSettings({
      provider: "s3-compatible",
      bucket: "example-bucket",
    });
    screen.click("storage-details-toggle");
    screen.click("storage-rebind");
    expect(screen.q("connect-endpoint")).not.toBe(null);
    expect((screen.q("connect-endpoint") as HTMLInputElement).value).toBe("");
    expect((screen.q("connect-bucket") as HTMLInputElement).value).toBe("example-bucket");
    screen.unmount();
  });

  test("still shows its bucket and offers Rotate key", () => {
    const screen = mountSettings({
      provider: "r2",
      bucket: "example-bucket",
      endpoint: "https://example.invalid",
      region: "auto",
      accessKey: "EXAM…PLE",
    });
    screen.click("storage-details-toggle");
    expect(screen.text).toContain("example-bucket");
    expect(screen.q("storage-rebind")?.textContent).toContain("Rotate key");
    // R2 is Cloudflare's, so the sentence names where the key is removed.
    expect(screen.text).toContain("Remove our key at Cloudflare");
    screen.unmount();
  });

  test("managed storage offers a verified move, not credential rotation or disconnect", () => {
    const screen = mountSettings({
      provider: "r2",
      managed: true,
      bucket: "ctx-example",
      endpoint: "https://example.invalid",
      region: "auto",
    });
    screen.click("storage-details-toggle");
    expect(screen.text).toContain("Context-managed storage");
    expect(screen.q("storage-rebind")).toBeNull();
    expect(screen.q("storage-disconnect")).toBeNull();
    expect(screen.q("storage-handoff")?.textContent).toContain("Move to my own bucket");
    expect(screen.q("storage-download-all")?.textContent).toContain("Download everything");
    screen.unmount();
  });

  test("a move in progress shows its steps and says the workspace still runs from Context", () => {
    const screen = mountSettings({
      provider: "r2",
      managed: true,
      bucket: "ctx-example",
      endpoint: "https://example.invalid",
      region: "auto",
      handoffStatus: "copying",
      handoffPhase: "copy",
      handoffClaimed: true,
      handoffBucket: "my-notes",
      handoffObjectsProcessed: 40,
      handoffObjectsTotal: 100,
    });
    expect(screen.text).toContain("Moving to my-notes");
    expect(screen.q("storage-handoff-progress")?.textContent).toContain("40 of 100");
    expect(screen.text).toContain("keeps running from Context's storage");
    // No second move while one is running; stopping is the only control.
    expect(screen.q("storage-handoff")).toBeNull();
    expect(screen.q("storage-handoff-stop")).not.toBeNull();
    screen.unmount();
  });
});
