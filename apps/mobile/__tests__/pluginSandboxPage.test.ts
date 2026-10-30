/**
 * @jest-environment jsdom
 */

/**
 * The web console loads the plugin sandbox by URL, never as `srcdoc`.
 *
 * A `srcdoc` document inherits the console's Content Security Policy, and the
 * sandbox runs its bootstrap and every plugin as inline script, so while it
 * was one the console could never enforce `script-src`
 * (`infra/router/src/cspReport.ts`). By URL it gets the policy the router
 * gives its own path (`infra/router/src/pluginSandbox.ts`). The frame's
 * sandbox flags, and so its opaque origin, are exactly what they were.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PluginSandbox, PLUGIN_SANDBOX_PATH } from "../features/console/plugins/PluginSandbox.web";
import type { PluginRuntimeBundle } from "../features/console/plugins/sandboxTypes";

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
});

function frame(): HTMLIFrameElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(createElement(PluginSandbox, { bundle: BUNDLE, nonce: "n-1", onEvent: () => {} })));
  return container.querySelector("iframe")!;
}

describe("the plugin sandbox frame", () => {
  test("loads the sandbox page by URL, with no srcdoc", () => {
    const element = frame();
    expect(element.getAttribute("src")).toBe(PLUGIN_SANDBOX_PATH);
    expect(element.hasAttribute("srcdoc")).toBe(false);
  });

  test("keeps an opaque origin: scripts only, never same-origin", () => {
    const flags = (frame().getAttribute("sandbox") ?? "").split(/\s+/);
    expect(flags).toEqual(["allow-scripts"]);
  });

  test("the path is the one the build writes and the router answers", () => {
    expect(PLUGIN_SANDBOX_PATH).toBe("/drawing-assets/plugin-sandbox/index.html");
    const repo = join(__dirname, "..", "..", "..");
    const build = readFileSync(join(repo, "scripts", "build-plugin-sandbox.mjs"), "utf8");
    expect(build).toContain('"drawing-assets", "plugin-sandbox"');
    expect(build).toContain('"index.html"');
    expect(readFileSync(join(repo, "infra", "router", "src", "pluginSandbox.ts"), "utf8")).toContain('"/drawing-assets/plugin-sandbox/"');
    // The console's service worker never answers there, so a navigation into
    // the frame is never handed the console's shell.
    expect(readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8")).toMatch(/NEVER = \[[^\]]*"\/drawing-assets\/"/);
  });
});
