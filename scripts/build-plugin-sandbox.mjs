#!/usr/bin/env node
/**
 * Write the plugin sandbox as a page of its own:
 * `apps/mobile/public/drawing-assets/plugin-sandbox/index.html`.
 *
 * The web console used to load the sandbox as a `srcdoc` frame. A `srcdoc`
 * document inherits its parent's Content Security Policy, and the sandbox
 * runs its bootstrap and every plugin as inline script, so the console could
 * never enforce a script policy without breaking plugins
 * (`infra/router/src/cspReport.ts`). Loaded by URL, the same document gets
 * the policy the router gives this path instead.
 *
 * The bytes are exactly `pluginSandboxDocument()`, its own CSP meta tag
 * included, and the frame keeps `sandbox="allow-scripts"` without
 * `allow-same-origin`, so its origin is as opaque as before. Under
 * `/drawing-assets/` because the console's service worker never answers
 * there (`apps/mobile/public/sw.js`, `NEVER`), so a navigation into the frame
 * can never be handed the console's own shell.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginSandboxDocument } from "../packages/obsidian-runtime/src/sandbox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_SANDBOX_OUT = path.join(ROOT, "apps", "mobile", "public", "drawing-assets", "plugin-sandbox");

export async function buildPluginSandbox() {
  await mkdir(PLUGIN_SANDBOX_OUT, { recursive: true });
  await writeFile(path.join(PLUGIN_SANDBOX_OUT, "index.html"), pluginSandboxDocument());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildPluginSandbox();
  console.log("built the plugin sandbox into apps/mobile/public/drawing-assets/plugin-sandbox");
}
