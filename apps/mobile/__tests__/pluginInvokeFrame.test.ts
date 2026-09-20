/**
 * @jest-environment jsdom
 */

/**
 * What the trusted host actually posts into a frame, and when.
 *
 * Found by reading the diff rather than by a red test, and it is the same class
 * of bug a self-review caught in #527 one commit earlier: **state that outlives
 * the frame it belonged to.**
 *
 * A press sets one slot, and each `PluginSandbox` posts it from an effect that
 * waits for `loaded`. A restart mounts a *new* sandbox, so `loaded` goes false
 * to true again — with the previous press still sitting in the slot. The new
 * frame would run a command nobody pressed, on its own, as soon as it finished
 * loading.
 *
 * The guest's ignore-an-unknown-id rule does not save this, and the comment
 * that said it would was wrong: a restarted plugin registers the *same* ids it
 * registered before, so the id resolves and the command runs.
 *
 * The asymmetry with `active-file` and `vault-event` is deliberate and is the
 * point. Those are **state**, and a freshly loaded plugin *should* be told
 * which note is open. A command is an **instruction**, and an instruction aimed
 * at a frame that is gone is not owed to its replacement.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PluginSandbox } from "../features/console/plugins/PluginSandbox";
import type { InvokeMessage, PluginRuntimeBundle } from "../features/console/plugins/sandboxTypes";

const BUNDLE: PluginRuntimeBundle = {
  pluginId: "highlightr-plugin",
  version: "1.2.2",
  bundleFingerprint: "fp-1",
  manifestJson: '{"id":"highlightr-plugin"}',
  mainJs: "module.exports = class {};",
  stylesCss: null,
  runtimeToken: "runtime-token-for-test",
  expiresAt: 4_102_444_800_000,
};

const roots: Root[] = [];
afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

/**
 * Mount one host and capture what it posts into its frame.
 *
 * The frame is an opaque-origin iframe with no document jsdom will run, so the
 * seam is `contentWindow.postMessage` — which is what the host calls and what a
 * real guest would receive.
 */
function host(nonce: string, invoke: InvokeMessage | undefined) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(root);
  const posted: Record<string, unknown>[] = [];

  const render = (next: InvokeMessage | undefined) => {
    act(() => {
      root.render(createElement(PluginSandbox, {
        bundle: BUNDLE,
        nonce,
        onEvent: () => {},
        invoke: next,
      }));
    });
    const frame = container.querySelector("iframe")!;
    if (frame.contentWindow !== null && !("__patched" in frame.contentWindow)) {
      Object.defineProperty(frame.contentWindow, "__patched", { value: true });
      jest.spyOn(frame.contentWindow, "postMessage").mockImplementation(((payload: unknown) => {
        posted.push(payload as Record<string, unknown>);
      }) as typeof frame.contentWindow.postMessage);
    }
  };

  render(invoke);
  /** Tell the host its guest finished loading, the way a real one does. */
  const finishLoading = () => {
    const frame = container.querySelector("iframe")!;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", {
        source: frame.contentWindow,
        data: { source: "context-plugin-sandbox", version: 1, nonce, type: "loaded" },
      }));
    });
  };
  const commands = () => posted.filter((one) => one.type === "command");
  return { render, finishLoading, commands };
}

describe("a command is posted for a press, and only for a press", () => {
  test("a press after the plugin loaded reaches the frame once", () => {
    const one = host("nonce-a", undefined);
    one.finishLoading();
    one.render({ seq: 1, id: "toggle" });
    expect(one.commands()).toEqual([
      { source: "context-plugin-host", version: 1, type: "command", id: "toggle" },
    ]);
  });

  test("pressing the same command twice sends it twice", () => {
    const one = host("nonce-b", undefined);
    one.finishLoading();
    one.render({ seq: 1, id: "toggle" });
    one.render({ seq: 2, id: "toggle" });
    expect(one.commands()).toHaveLength(2);
  });

  /*
    A press while the bundle is still starting is aimed at *this* frame, so it
    is owed delivery once the frame is ready — the opposite of the case below.
  */
  test("a press during loading is delivered when loading finishes", () => {
    const one = host("nonce-c", { seq: 1, id: "toggle" });
    expect(one.commands()).toHaveLength(0);
    one.finishLoading();
    expect(one.commands()).toHaveLength(1);
  });

  /*
    THE BUG, and where the fix had to go.

    A restart mounts a new sandbox, so `loaded` goes false to true again with
    the previous press still in the slot — and this component cannot tell that
    case from the one above it. Both mount holding a press and then load; the
    difference is only whether the press was aimed at *this* frame, which the
    component has no way to know.

    So the sandbox keeps the contract it can honour — post what is in the slot
    once loaded — and the address is checked where the frames are known, in
    `invokeFor`, whose tests carry the restart case. What this proves here is
    that the component really does post whatever it is handed, which is what
    makes that address the only thing standing between a press and a frame.
  */
  test("it posts whatever it is handed, which is why the address is checked elsewhere", () => {
    const replacement = host("nonce-d", { seq: 1, id: "toggle" });
    replacement.finishLoading();
    expect(replacement.commands()).toHaveLength(1);
  });
});
