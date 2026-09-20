/**
 * @jest-environment jsdom
 */

/**
 * THE FOUR PROPS THAT ARE THE NATIVE SANDBOX, AND WHY NOTHING ELSE STANDS IN.
 *
 * On the web half a plugin realm may navigate itself wherever it likes — a
 * `sandbox="allow-scripts"` iframe with no `allow-top-navigation` can still
 * replace its *own* document, and neither the guest's CSP nor any sandbox flag
 * stops it (`connect-src 'none'` governs fetches, not the address bar the
 * document does not have). The web host is built for that: it counts document
 * loads, and the second one sets `disowned`, after which `post` is a no-op —
 * *"the successor gets no nonce and no bundle"*.
 *
 * **The native half has no such counter.** `handed` only fires on a second
 * `ready`, and a foreign document has no reason to send one. What stands in its
 * place is a WebView configured to refuse the navigation outright:
 *
 *     originWhitelist={["about:blank"]}
 *     onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
 *     setSupportMultipleWindows={false}
 *     domStorageEnabled={false}
 *
 * So on iOS and Android those lines are not hardening in depth, they are the
 * boundary itself, and this suite had nothing that would notice their removal.
 * `pluginSandboxNativeReady.test.ts` mounts the same component and asserts the
 * nonce handshake, but it reads no props at all. Measured rather than inferred:
 * with **all four deleted at once**, the pre-existing suite is 324 suites and
 * 6,181 tests, fully green. That is what this file is for — per
 * `docs/decisions/testing.md`, a guard nobody has checked is not a guard.
 *
 * ## What their loss would actually cost, which is not what it first looks like
 *
 * The obvious answer — "the plugin could exfiltrate the note it just read" — is
 * wrong, and worth writing down so nobody re-derives it as a finding. A plugin
 * that has legitimately been given note text can already put it in the URL it
 * navigates to; it is spending its own data. Nothing is gained.
 *
 * The real cost is what the host keeps sending **afterwards**. Because the
 * native half never disowns on navigation, `loaded` stays true, and every
 * host-to-guest effect in the component goes on posting into whatever document
 * now occupies the frame:
 *
 *   - `suggest-query` — the line the person is typing, on every keystroke
 *   - `active-file`   — the path and etag of the note they are reading
 *   - `vault-event`   — the path of every note that changes while they work
 *   - `preview-query` — the links in the note they have open
 *
 * That is a live feed of note material the plugin was never handed, delivered
 * by the host to a page of the attacker's choosing, continuing for as long as
 * the console stays open. The distance between "a plugin spends what it has"
 * and that is the whole value of these four lines.
 *
 * ## Measured by sabotage, against this file
 *
 * | break | reddens |
 * | --- | --- |
 * | drop `onShouldStartLoadWithRequest` | **2** |
 * | let it answer `true` for an https URL | **1** |
 * | widen `originWhitelist` to `["*"]` | **1** |
 * | `setSupportMultipleWindows` to true | **1** |
 * | `domStorageEnabled` to true | **1** |
 * | point `source` at a remote url instead of inline html | **1** |
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  PluginRuntimeBundle,
  PluginSandboxProps,
} from "../features/console/plugins/sandboxTypes";

/** Every prop the host handed the WebView, so the boundary can be read back. */
let mockProps: Record<string, unknown> = {};

jest.mock("react-native-webview", () => {
  const { createElement: h, forwardRef: fwd, useImperativeHandle: handle } =
    require("react") as typeof import("react");
  const { View: RNView } = require("react-native") as typeof import("react-native");
  return {
    WebView: fwd((props: Record<string, unknown>, ref: unknown) => {
      handle(ref as never, () => ({
        postMessage: () => {},
        injectJavaScript: () => {},
        reload: () => {},
      }));
      mockProps = props;
      return h(RNView, { testID: "webview-stub" });
    }),
  };
});

const { PluginSandbox } = require("../features/console/plugins/PluginSandbox.tsx") as {
  PluginSandbox: (props: PluginSandboxProps) => ReactNode;
};

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

beforeEach(() => {
  mockProps = {};
});

afterEach(() => {
  while (roots.length > 0) act(() => roots.pop()!.unmount());
  document.body.innerHTML = "";
});

function mount(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      createElement(PluginSandbox, {
        bundle: BUNDLE,
        nonce: "nonce-the-plugin-must-not-learn",
        onEvent: () => {},
      } as unknown as PluginSandboxProps),
    );
  });
}

/** The navigation decision, as react-native-webview will call it. */
function mayNavigateTo(url: string): boolean {
  const decide = mockProps.onShouldStartLoadWithRequest as
    | ((request: { url: string }) => boolean)
    | undefined;
  if (typeof decide !== "function") {
    throw new Error("the WebView was mounted with no navigation decision at all");
  }
  return decide({ url });
}

describe("the native plugin sandbox refuses to leave about:blank", () => {
  test("the one document it is allowed to be is the one the host wrote", () => {
    mount();
    expect(mayNavigateTo("about:blank")).toBe(true);

    // Anti-vacuity: a decision function that answered `false` to everything
    // would satisfy the refusals below while breaking the sandbox outright, and
    // the suite would read as hardened rather than as broken.
    expect(mockProps.source).toMatchObject({ baseUrl: "about:blank" });
    expect(typeof (mockProps.source as { html?: unknown }).html).toBe("string");
    expect(mockProps.source).not.toHaveProperty("uri");
  });

  test("and refuses every other address, not merely the http ones", () => {
    /*
      A plugin reaches this by assigning to `location` in its own realm. The
      guest's CSP does not cover it — `default-src 'none'` governs what the
      document fetches, and there is no directive for the document replacing
      itself. `frame-src 'none'` closes the iframe route and `form-action
      'none'` closes the form route, which leaves exactly this one, which is
      why the answer has to be here.
    */
    mount();
    for (const url of [
      "https://attacker.example/collector",
      "http://attacker.example/collector",
      // The schemes that do not look like navigation.
      "data:text/html,<script>fetch('https://attacker.example')</script>",
      "blob:about:blank/0d4e0dfe-0000-4000-8000-000000000000",
      "javascript:void 0",
      "file:///etc/passwd",
      // A near-miss on the allowed value, because a `startsWith` would take it.
      "about:blank#/../../",
      "about:blanket.example",
      "about:srcdoc",
      // And an app the phone would hand to something else entirely.
      "intent://scan/#Intent;scheme=zxing;package=com.example;end",
    ]) {
      expect(mayNavigateTo(url)).toBe(false);
    }
  });

  test("the realm gets no storage, and cannot open a second window to carry one", () => {
    /*
      `setSupportMultipleWindows` is the other half of the same door:
      `window.open` is not a navigation of this frame, so the decision above
      never sees it. With it false the WebView refuses the open instead.

      `domStorageEnabled` is not a navigation control and is here because it is
      the other thing the boundary promises: a realm that is rebuilt from
      `pluginSandboxDocument()` on every mount, with nothing of the last
      plugin's left in it for the next one to read.
    */
    mount();
    expect(mockProps.setSupportMultipleWindows).toBe(false);
    expect(mockProps.domStorageEnabled).toBe(false);
    expect(mockProps.originWhitelist).toEqual(["about:blank"]);
  });
});
