/**
 * @jest-environment jsdom
 */

/**
 * WHOSE DIALOG IS ON SCREEN, AND WHO MAY TAKE IT AWAY.
 *
 * `pluginTextDialog.test.ts` covers the component; this covers the seam above
 * it, where a guest message arrives and `useRuntime` decides what to do with
 * it — the same seam `pluginSuggestDialogHost.test.ts` tests for the
 * suggestion dialog, and the same rule.
 *
 * `text-modal` is a plugin's own dialog: it is not asked for by the console,
 * every running frame can send one unprompted, and the one on screen names the
 * plugin showing it. `useRuntime`'s own comment states the ownership rule —
 * *"a dismissal has to reach the plugin that opened it, and a plugin restarted
 * under a new nonce is not that plugin"* — and the handler recorded the sending
 * frame without ever checking it against the dialog already open.
 *
 * So a second plugin could replace or close somebody else's dialog:
 *
 *  - **Closed by a stranger**, the reader's dialog vanishes and the plugin that
 *    opened it is never told, because the dismissal is addressed to whoever
 *    owns the dialog *now*.
 *  - **Replaced by a stranger**, the reader's Close reaches the replacement,
 *    and the original — which in this API is usually awaiting its own
 *    `onClose` — waits for a close that has already happened to somebody else.
 *
 * Neither is impersonation: `pluginId` comes from the sending frame, so the
 * panel always names the plugin whose words are in it. It is the surface's
 * ownership that was unheld, which is exactly what `#573` fixed one handler
 * below this one and what the settings pane checks three handlers above it.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => ({ ok: true, result: {} }),
  useMutation: () => async () => undefined,
  useQueries: () => ({}),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { useRuntime } from "../features/console/plugins/useRuntime";
import type { ActiveSandbox, RuntimeView } from "../features/console/plugins/runtime";
import type { SandboxEvent } from "../features/console/plugins/sandboxTypes";
import type { Id } from "@context/convex/_generated/dataModel";

const WORKSPACE = "ws_one" as Id<"workspaces">;

function bundleFor(pluginId: string) {
  return {
    pluginId,
    version: "1.0.0",
    bundleFingerprint: `fp-${pluginId}`,
    manifestJson: `{"id":"${pluginId}"}`,
    mainJs: "module.exports = class {};",
    stylesCss: null,
    runtimeToken: `runtime-token-${pluginId}`,
    expiresAt: 4_102_444_800_000,
  };
}

/** The plugin that opens the dialog, and the one that never did. */
const OWNER: ActiveSandbox = { bundle: bundleFor("bible-reference"), nonce: "nonce-owner", attempts: 1 };
const OTHER: ActiveSandbox = { bundle: bundleFor("some-other-plugin"), nonce: "nonce-other", attempts: 1 };

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!();
  document.body.innerHTML = "";
});

function mount() {
  let latest: RuntimeView | null = null;
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    latest = useRuntime({ workspaceId: WORKSPACE, role: "owner" });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  mounted.push(() => act(() => root.unmount()));
  const view = () => latest as RuntimeView;
  const hostProps = () =>
    (view().host as ReactElement<{
      onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
      textModalDismiss?: { seq: number; pluginId: string; nonce: string };
    }>).props;
  return {
    view,
    hostProps,
    send: (sandbox: ActiveSandbox, event: SandboxEvent) => {
      act(() => hostProps().onEvent(sandbox, event));
    },
  };
}

function openOwnersDialog(host: ReturnType<typeof mount>) {
  host.send(OWNER, { type: "text-modal", open: true, title: "Verse of the day", text: "In the beginning" });
  // Non-vacuity: the dialog really is open and really does belong to the
  // plugin that opened it, before anything is done to it.
  expect(host.view().textModal).toMatchObject({ pluginId: "bible-reference", nonce: "nonce-owner" });
}

describe("only the frame that opened the dialog may change or close it", () => {
  test("a stranger cannot close somebody else's dialog", () => {
    const host = mount();
    openOwnersDialog(host);

    host.send(OTHER, { type: "text-modal", open: false, title: "", text: "" });

    expect(host.view().textModal).toMatchObject({ pluginId: "bible-reference" });
  });

  test("...nor replace what the reader is looking at", () => {
    const host = mount();
    openOwnersDialog(host);

    host.send(OTHER, {
      type: "text-modal",
      open: true,
      title: "Your session has expired",
      text: "Paste your recovery phrase to continue.",
    });

    expect(host.view().textModal).toMatchObject({
      pluginId: "bible-reference",
      title: "Verse of the day",
    });
  });

  test("...and the reader's Close still reaches the plugin that opened it", () => {
    const host = mount();
    openOwnersDialog(host);
    host.send(OTHER, { type: "text-modal", open: true, title: "Elsewhere", text: "Not yours" });

    act(() => host.view().actions!.dismissTextModal!());

    expect(host.hostProps().textModalDismiss).toMatchObject({
      pluginId: "bible-reference",
      nonce: "nonce-owner",
    });
  });

  test("the owner may still update and close its own dialog", () => {
    // The other half: this must not become a dialog nobody can change. The
    // guest re-sends on every DOM change, so an update from the owner is the
    // ordinary case, not the exception.
    const host = mount();
    openOwnersDialog(host);

    host.send(OWNER, { type: "text-modal", open: true, title: "Verse of the day", text: "…was the Word" });
    expect(host.view().textModal).toMatchObject({ text: "…was the Word" });

    host.send(OWNER, { type: "text-modal", open: false, title: "", text: "" });
    expect(host.view().textModal).toBeNull();
  });

  test("a reader closing the dialog releases it, so the next plugin can open one", () => {
    /*
      The other direction, and it has to be asserted or the ownership check
      becomes a dialog nobody else may ever raise: `dismissTextModal` is the
      reader's own act, and it ends the owner's claim. Measured — without the
      release in `dismissTextModal`, nothing in the suite goes red.
    */
    const host = mount();
    openOwnersDialog(host);

    act(() => host.view().actions!.dismissTextModal!());
    expect(host.view().textModal).toBeNull();

    host.send(OTHER, { type: "text-modal", open: true, title: "Mine now", text: "Fair enough" });
    expect(host.view().textModal).toMatchObject({ pluginId: "some-other-plugin" });
  });

  test("a restarted owner, under a new nonce, is not the plugin that opened it", () => {
    // `useRuntime`'s own stated rule, and the one the suggestion dialog keeps:
    // the same plugin id under a different nonce is a different frame.
    const host = mount();
    openOwnersDialog(host);

    host.send(
      { ...OWNER, nonce: "nonce-restarted" },
      { type: "text-modal", open: false, title: "", text: "" },
    );

    expect(host.view().textModal).toMatchObject({ nonce: "nonce-owner" });
  });
});
