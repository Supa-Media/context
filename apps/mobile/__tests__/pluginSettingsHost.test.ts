/**
 * @jest-environment jsdom
 */

/**
 * PRESSING "SETTINGS…" ACTUALLY OPENS THE PANE.
 *
 * `pluginSettingsPane.test.ts` proves the component draws a pane it is handed,
 * and `pluginSandboxGuest.test.ts` proves the guest describes one when asked.
 * Both were green while the feature was dead end to end, because the seam
 * between them was not tested at all: `useRuntime.onEvent`, where the guest's
 * `settings-pane` arrives and the host decides whether to draw it.
 *
 * The defect was the one `useRuntime` had already written down beside
 * `textModalOwner` — *"`onEvent` is a `useCallback` whose dependency list does
 * not name this, so a state read inside it is fresh only while some other
 * dependency keeps the callback unstable"* — and then accepted for the settings
 * pane on the grounds that it "fails closed: the pane stops opening, somebody
 * notices within a day". Somebody did: every press of Settings… did nothing at
 * all, for every plugin, because the callback's dependencies are all stable and
 * the `settingsRequest` it closed over stayed `undefined` for the life of the
 * console.
 *
 * So the ownership check reads a ref now, like every other check in that
 * callback, and this file is the guard that it keeps working. It drives the
 * real hook: press, answer as the frame that was asked, and expect a pane.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

const BUNDLE = {
  pluginId: "obsidian-bible-reference",
  version: "26.08.07",
  bundleFingerprint: "fp-1",
  manifestJson: '{"id":"obsidian-bible-reference"}',
  mainJs: "module.exports = class {};",
  stylesCss: null,
  runtimeToken: "runtime-token-for-test",
  expiresAt: 4_102_444_800_000,
};

jest.mock("convex/react", () => ({
  // Both `loadPluginBundle` and `executePluginRequest` come through
  // `useAction`; a start is the only one this file makes.
  useAction: () => async () => BUNDLE,
  useMutation: () => async () => undefined,
  useQueries: () => ({}),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { useRuntime } from "../features/console/plugins/useRuntime";
import type {
  ActiveSandbox,
  PluginSettingRow,
  RuntimeView,
} from "../features/console/plugins/runtime";
import type { SandboxEvent } from "../features/console/plugins/sandboxTypes";
import type { Id } from "@context/convex/_generated/dataModel";

const WORKSPACE = "ws_one" as Id<"workspaces">;

const ROWS: PluginSettingRow[] = [
  { kind: "heading", level: 2, text: "Verses Rendering" },
  {
    kind: "toggle" as const,
    index: 0,
    name: "Show Verse Translation",
    desc: "",
    label: "",
    placeholder: "",
    disabled: false,
    value: true,
  },
];

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!();
  document.body.innerHTML = "";
});

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

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
      sandboxes: ActiveSandbox[];
      onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
      settingsRequest?: { seq: number; pluginId: string; nonce: string; open: boolean };
    }>).props;
  return {
    view,
    hostProps,
    frame: () => hostProps().sandboxes[0]!,
    send: (sandbox: ActiveSandbox, event: SandboxEvent) => {
      act(() => hostProps().onEvent(sandbox, event));
    },
  };
}

/** A started plugin, exactly as the console starts one. */
async function running() {
  const host = mount();
  await act(async () => {
    await host.view().actions!.start(BUNDLE.pluginId, BUNDLE.bundleFingerprint);
  });
  host.send(host.frame(), { type: "settings-tab" });
  return host;
}

describe("a plugin's settings pane opens when the owner asks for it", () => {
  test("the press reaches the frame, and the frame's answer is drawn", async () => {
    const host = await running();
    expect(host.view().settingsTabs).toEqual([BUNDLE.pluginId]);

    act(() => host.view().actions!.openSettingsPane!(BUNDLE.pluginId));
    await settle();

    // The request is addressed to the frame running this plugin now.
    const asked = host.hostProps().settingsRequest;
    expect(asked).toMatchObject({ pluginId: BUNDLE.pluginId, nonce: host.frame().nonce, open: true });

    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();

    /*
      The assertion the report is about. Before the fix this was `null` for
      ever: the answer arrived, the check read a `settingsRequest` captured on
      the first render, and every pane was dropped as unasked-for.
    */
    expect(host.view().settingsPane).toMatchObject({
      pluginId: BUNDLE.pluginId,
      nonce: host.frame().nonce,
      error: null,
    });
    expect(host.view().settingsPane?.rows).toHaveLength(2);
  });

  test("a pane redrawn after a toggle replaces the one on screen", async () => {
    const host = await running();
    act(() => host.view().actions!.openSettingsPane!(BUNDLE.pluginId));
    await settle();
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();

    host.send(host.frame(), {
      type: "settings-pane",
      open: true,
      rows: [{ kind: "note", text: "Expert settings" }],
      error: null,
    });
    await settle();
    expect(host.view().settingsPane?.rows).toEqual([{ kind: "note", text: "Expert settings" }]);
  });

  test("Done closes it, and a late answer does not bring it back", async () => {
    const host = await running();
    act(() => host.view().actions!.openSettingsPane!(BUNDLE.pluginId));
    await settle();
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();

    act(() => host.view().actions!.closeSettingsPane!());
    await settle();
    expect(host.view().settingsPane).toBeNull();

    /*
      The pane a reader has left is not re-opened by the guest's own redraw —
      that pane's observer fires on its way down, and a console that drew it
      would put a panel back over somebody who had just dismissed it.
    */
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();
    expect(host.view().settingsPane).toBeNull();
  });
});

describe("and only the frame that was asked may answer", () => {
  const IMPOSTOR: ActiveSandbox = {
    bundle: { ...BUNDLE, pluginId: "some-other-plugin", bundleFingerprint: "fp-2" },
    nonce: "nonce-other",
    attempts: 1,
  };

  test("another plugin cannot put its controls under this plugin's name", async () => {
    const host = await running();
    act(() => host.view().actions!.openSettingsPane!(BUNDLE.pluginId));
    await settle();

    host.send(IMPOSTOR, {
      type: "settings-pane",
      open: true,
      rows: [{ kind: "note", text: "rows from a plugin nobody asked" }],
      error: null,
    });
    await settle();
    expect(host.view().settingsPane).toBeNull();

    // And the frame that was asked is still answered normally afterwards.
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();
    expect(host.view().settingsPane?.pluginId).toBe(BUNDLE.pluginId);
  });

  test("a pane nobody asked for is never drawn", async () => {
    const host = await running();
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();
    /*
      Unprompted. `display()` runs only when the console asks, so this is a
      guest volunteering a panel over whatever the reader was doing.
    */
    expect(host.view().settingsPane).toBeNull();
  });

  test("a plugin that stops takes its open pane with it", async () => {
    const host = await running();
    act(() => host.view().actions!.openSettingsPane!(BUNDLE.pluginId));
    await settle();
    host.send(host.frame(), { type: "settings-pane", open: true, rows: ROWS, error: null });
    await settle();
    expect(host.view().settingsPane).not.toBeNull();

    await act(async () => {
      await host.view().actions!.stop(BUNDLE.pluginId, BUNDLE.bundleFingerprint);
    });
    await settle();
    /*
      A pane belongs to a running frame: its controls do nothing once that frame
      is gone, and leaving it up offers settings whose changes reach nobody.
    */
    expect(host.view().settingsPane).toBeNull();
  });
});
