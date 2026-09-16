/**
 * @jest-environment jsdom
 */

/**
 * WHO IS ALLOWED TO ANSWER THE DIALOG'S QUESTION.
 *
 * `pluginSuggestDialog.test.ts` covers the component; this covers the half
 * above it, where a guest message arrives and the host decides what to do with
 * it. `useRuntime`'s `onEvent` is that seam, reached the way
 * `pluginStatusBarHost.test.ts` reaches it.
 *
 * The completion menu and the dialog make deliberately different choices about
 * ownership, and the difference is the whole of this file:
 *
 *  - A **completion** is asked for by the editor, so every running frame is
 *    asked and the first to offer anything owns the menu. An answer from any
 *    frame is legitimate there, because every frame was asked.
 *  - A **dialog** is asked for by the plugin. `useRuntime` says so in its own
 *    words — *"whoever sent `suggest-modal` is the only frame that will ever be
 *    queried or picked from"* — and `PluginSandboxFarm` holds up its end,
 *    addressing the query to one frame by plugin id **and** nonce.
 *
 * So the dialog on screen names one plugin, and the rows in it must have come
 * from that plugin. A second frame answering a question it was never asked puts
 * its own rows under somebody else's name, and the reader's pick then travels
 * to the named plugin as an index into a list it never produced.
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

/** The plugin that opens the dialog, and the one that was never asked. */
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
      modalQuery?: { seq: number; pluginId: string; nonce: string; query: string };
    }>).props;
  return {
    view,
    hostProps,
    /** Deliver one guest message as a named frame, exactly as the farm would. */
    send: (sandbox: ActiveSandbox, event: SandboxEvent) => {
      act(() => hostProps().onEvent(sandbox, event));
    },
  };
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("only the frame that opened the dialog may answer for it", () => {
  test("a frame that was never asked cannot put its rows under another plugin's name", async () => {
    const host = mount();

    host.send(OWNER, {
      type: "suggest-modal",
      open: true,
      placeholder: "Search a verse",
      instructions: [],
    });
    // Non-vacuity: the dialog really is open and really does belong to the
    // plugin that opened it, before anything is asked.
    expect(host.view().modal?.pluginId).toBe("bible-reference");

    const answer = host.view().actions!.askModalSuggestions!("john 3");
    await settle();

    // The query went to exactly one frame, by id and nonce. That is the half
    // that was already right, and the seq below is taken from it rather than
    // guessed, so this test cannot pass by asking the wrong question.
    const query = host.hostProps().modalQuery;
    expect(query).toMatchObject({ pluginId: "bible-reference", nonce: "nonce-owner" });

    // The frame that was never asked answers first, with the seq it can see
    // from its own message traffic or simply spray.
    host.send(OTHER, {
      type: "suggest-modal-results",
      seq: query!.seq,
      items: [{ text: "row from a plugin that was not asked" }],
    });
    await settle();

    const items = await answer;
    expect(items.map((item) => item.text)).not.toContain("row from a plugin that was not asked");
  });

  /*
    The half that keeps a spoof from becoming a denial. An unasked frame's
    answer is ignored rather than consumed, so the question stays outstanding
    and the plugin that was actually asked can still answer it. Consuming it
    would leave the reader in front of a dialog that never fills.
  */
  test("an unasked frame's answer does not also silence the real one", async () => {
    const host = mount();

    host.send(OWNER, {
      type: "suggest-modal",
      open: true,
      placeholder: "Search a verse",
      instructions: [],
    });
    const answer = host.view().actions!.askModalSuggestions!("john 3");
    await settle();
    const query = host.hostProps().modalQuery;

    host.send(OTHER, {
      type: "suggest-modal-results",
      seq: query!.seq,
      items: [{ text: "row from a plugin that was not asked" }],
    });
    await settle();

    host.send(OWNER, {
      type: "suggest-modal-results",
      seq: query!.seq,
      items: [{ text: "John 3:16" }],
    });
    await settle();

    expect((await answer).map((item) => item.text)).toEqual(["John 3:16"]);
  });

  test("and the frame that was asked is still answered normally", async () => {
    const host = mount();

    host.send(OWNER, {
      type: "suggest-modal",
      open: true,
      placeholder: "Search a verse",
      instructions: [],
    });
    const answer = host.view().actions!.askModalSuggestions!("john 3");
    await settle();
    const query = host.hostProps().modalQuery;

    host.send(OWNER, {
      type: "suggest-modal-results",
      seq: query!.seq,
      items: [{ text: "John 3:16" }],
    });
    await settle();

    expect((await answer).map((item) => item.text)).toEqual(["John 3:16"]);
  });
});
