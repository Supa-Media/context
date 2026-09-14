/**
 * @jest-environment jsdom
 */

/**
 * What the console does with a status bar the guest sends it.
 *
 * The guest reports its whole status bar every time it changes, and the host's
 * side of that bargain is to **replace** rather than merge. It is one line of
 * code and it is the line the whole no-removal-message design rests on: merge
 * instead, and a plugin that clears its status bar leaves its last reading on
 * the card for ever, with nothing producing it and no message that could ever
 * take it down.
 *
 * `useRuntime` had no test of any kind before this one. It is reached the way
 * the console reaches it — through the element it builds for the sandbox farm,
 * whose `onEvent` is the seam every guest message arrives on.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
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

const SANDBOX: ActiveSandbox = {
  bundle: {
    pluginId: "obsidian-tasks-plugin",
    version: "1.0.0",
    bundleFingerprint: "fp-1",
    manifestJson: '{"id":"obsidian-tasks-plugin"}',
    mainJs: "module.exports = class {};",
    stylesCss: null,
    runtimeToken: "runtime-token-for-test",
    expiresAt: 4_102_444_800_000,
  },
  nonce: "nonce-for-test",
  attempts: 1,
};

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
  return {
    view,
    /** Deliver one guest message exactly as the farm would. */
    send: (event: SandboxEvent) => {
      const onEvent = (view().host as ReactElement<{
        onEvent: (sandbox: ActiveSandbox, event: SandboxEvent) => void;
      }>).props.onEvent;
      act(() => onEvent(SANDBOX, event));
    },
  };
}

describe("the console holds what the guest last said, not a running total", () => {
  test("a status bar arrives under its plugin", () => {
    const host = mount();
    host.send({ type: "status-bar", items: [{ id: "status-1", text: "412 words" }] });
    expect(host.view().statusItems).toEqual({
      "obsidian-tasks-plugin": [{ id: "status-1", text: "412 words" }],
    });
  });

  test("the next one replaces it rather than adding to it", () => {
    const host = mount();
    host.send({ type: "status-bar", items: [
      { id: "status-1", text: "412 words" },
      { id: "status-2", text: "3 tasks due" },
    ] });
    host.send({ type: "status-bar", items: [{ id: "status-1", text: "413 words" }] });
    expect(host.view().statusItems).toEqual({
      "obsidian-tasks-plugin": [{ id: "status-1", text: "413 words" }],
    });
  });

  /*
    The case the whole design exists for. A plugin that empties its status bar
    sends an empty list, and there is no removal message anywhere in the
    protocol — so a host that merged would have no way at all to take the last
    reading off the card.
  */
  test("a plugin that clears its status bar clears the card", () => {
    const host = mount();
    host.send({ type: "status-bar", items: [{ id: "status-1", text: "412 words" }] });
    host.send({ type: "status-bar", items: [] });
    expect(host.view().statusItems).toEqual({ "obsidian-tasks-plugin": [] });
  });

  test("a plugin that tears itself down takes its status bar with it", () => {
    const host = mount();
    host.send({ type: "status-bar", items: [{ id: "status-1", text: "412 words" }] });
    host.send({ type: "unloaded" });
    expect(host.view().statusItems).toEqual({});
  });
});
