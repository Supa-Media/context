/**
 * @jest-environment jsdom
 */

/**
 * WHO IS ALLOWED TO ASK THE HOST FOR THE SANDBOX NONCE.
 *
 * The nonce is what `parsePluginSandboxMessage` checks before it believes
 * anything a frame says about itself, and the guest is careful never to let a
 * plugin see it: *"RPC replies carry no sandbox nonce. A plugin can observe
 * every event in its own realm, so including the nonce here would reveal the
 * value the trusted host uses to reject forged status and registration
 * messages."* Every host-to-guest message after `load` omits it for that
 * reason.
 *
 * `load` itself carries it, and the two hosts decide differently when to send
 * one. The **web** host sends it from the frame's own load event and treats a
 * second load as `disowned` — *"the successor gets no nonce and no bundle"*.
 * The **native** host sends it in reply to the guest's `ready` message, which
 * is the one message the parser accepts before the nonce check, because a
 * guest that has never been told the nonce cannot quote it.
 *
 * So on native, anything that can post a `ready` can ask for the nonce — and
 * the plugin's bundle runs in that realm, as a script in global scope with
 * `window.ReactNativeWebView.postMessage` in front of it. Its own `ready`
 * would be answered with the value it is not supposed to have, and with a
 * second evaluation of its bundle into the same realm besides.
 *
 * ## Why this file mounts the component by its explicit path
 *
 * `jest.config.js` resolves `web.tsx` first, so every existing test that
 * imports `./PluginSandbox` mounts the **web** half — `pluginInvokeFrame`'s
 * own comments describe an iframe. The native half, the one that ships to iOS
 * and Android, had never been executed by this suite. That is the false green
 * the config's own comment warns about, one component later.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PluginRuntimeBundle, PluginSandboxProps } from "../features/console/plugins/sandboxTypes";

/** Everything the host posted into the frame, in order. */
const posted: string[] = [];
/** The live `onMessage`, so a test can speak as the guest does. */
let fromGuest: ((event: { nativeEvent: { data: string } }) => void) | null = null;

jest.mock("react-native-webview", () => {
  const { createElement: h, forwardRef: fwd, useImperativeHandle: handle } =
    require("react") as typeof import("react");
  const { View: RNView } = require("react-native") as typeof import("react-native");
  return {
    WebView: fwd((props: Record<string, unknown>, ref: unknown) => {
      handle(ref as never, () => ({
        postMessage: (raw: string) => { posted.push(raw); },
        injectJavaScript: () => {},
        reload: () => {},
      }));
      fromGuest = props.onMessage as typeof fromGuest;
      return h(RNView, { testID: "webview-stub" });
    }),
  };
});

const { PluginSandbox } = require("../features/console/plugins/PluginSandbox.tsx") as {
  PluginSandbox: (props: PluginSandboxProps) => ReactNode;
};

const NONCE = "nonce-the-plugin-must-not-learn";

const BUNDLE: PluginRuntimeBundle = {
  pluginId: "under-test",
  version: "1.0.0",
  bundleFingerprint: "fp-1",
  manifestJson: '{"id":"under-test"}',
  mainJs: "module.exports = class {};",
  stylesCss: null,
  runtimeToken: "runtime-token-for-test",
  expiresAt: 4_102_444_800_000,
};

const roots: Root[] = [];
afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  document.body.innerHTML = "";
  posted.length = 0;
  fromGuest = null;
});

function mount(): { events: { type: string }[] } {
  const events: { type: string }[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      createElement(PluginSandbox, {
        bundle: BUNDLE,
        nonce: NONCE,
        onEvent: (event: { type: string }) => { events.push(event); },
      } as unknown as PluginSandboxProps),
    );
  });
  return { events };
}

/** Speak as the guest realm does — which is also how plugin code can speak. */
function say(message: Record<string, unknown>) {
  act(() => {
    fromGuest?.({
      nativeEvent: { data: JSON.stringify({ source: "context-plugin-sandbox", version: 1, ...message }) },
    });
  });
}

const carriesNonce = () => posted.filter((raw) => raw.includes(NONCE));

describe("the native sandbox hands the nonce to a frame once", () => {
  test("the guest's first ready is answered with the bundle and the nonce", () => {
    mount();
    say({ type: "ready" });
    expect(carriesNonce()).toHaveLength(1);
    expect(JSON.parse(posted[0]!)).toMatchObject({ type: "load", nonce: NONCE, mainJs: BUNDLE.mainJs });
  });

  /*
    The one that matters. By the time a second `ready` can be sent, the bundle
    is running in that realm and a listener of its own would receive the reply.
    A plugin that learns the nonce can forge every message the parser gates on
    it — a status bar it never drew, a settings tab it does not have, a
    `command-result` claiming the owner refused it a capability, in Context's
    own words on Context's own card.
  */
  test("a second ready is not answered with it, and the frame is disowned", () => {
    const { events } = mount();
    say({ type: "ready" });
    say({ type: "ready" });
    expect(carriesNonce()).toHaveLength(1);
    expect(events.map((one) => one.type)).toContain("disowned");
  });

  /*
    And the bundle is not evaluated a second time into a realm that already has
    it running: two live instances share one shim, and only the later one is
    ever handed to `unload`.
  */
  test("a second ready does not re-send the bundle", () => {
    mount();
    say({ type: "ready" });
    say({ type: "ready" });
    expect(posted.filter((raw) => raw.includes(BUNDLE.mainJs))).toHaveLength(1);
  });
});
