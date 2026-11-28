/**
 * Tex calls Context's tools through one seam, `packages/tex/gateway/contextMcp.js`, as an MCP client would
 * (`docs/decisions/texting-assistant/tex-service.md`). Today it answers in-process through the gateway's own MCP
 * dispatcher; when Tex becomes its own Worker, only that file changes.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `callContextTool` dropping `options`: "a legacy caller keeps its option" fails.
 * 2. `heartbeat.js` importing `callToolForSession` again: "only the seam imports the gateway's MCP dispatcher" fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { callContextTool, contextTools } from "../../../packages/tex/gateway/contextMcp.js";
import { callToolForSession } from "../src/tools/session.js";
import { STAFF_ONLY_TOOLS } from "../src/tools/registry.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "projects", visibility: "team" }], notes: [] };
const text = (result) => result.content.map((part) => part.text).join("");

async function storeWith(notes) {
  const raw = createMemoryStore();
  for (const [key, body] of Object.entries(notes)) await raw.put(key, body);
  return withPrivacyAuthority(withServedTree(raw), { rules: RULES });
}

test("a tool call through the seam answers as the gateway's MCP dispatcher does", async () => {
  const store = await storeWith({ "projects/plan.md": "# Plan\n\nShip it." });
  const session = { scope: "team", workspaceId: "ws-tex" };
  const params = { name: "fetch", arguments: { id: "projects/plan.md" } };
  const direct = await callToolForSession(params, store, session);
  const seam = await callContextTool(store, session, params);
  assert.equal(text(seam), text(direct));
  const dispatch = contextTools(store, session);
  assert.equal(text(await dispatch("fetch", { id: "projects/plan.md" })), text(direct));
});

test("a staff-only tool is refused to Tex as to any client", async () => {
  const [staffOnly] = [...STAFF_ONLY_TOOLS];
  assert.ok(staffOnly, "there is a staff-only tool to try");
  const store = await storeWith({});
  const result = await contextTools(store, { scope: "team", workspaceId: "ws-tex" })(staffOnly, {});
  assert.equal(result.isError, true);
});

test("a legacy caller keeps its option", async () => {
  const store = await storeWith({ "projects/plan.md": "# Plan\n\nShip it." });
  const session = { scope: "team", workspaceId: "ws-tex" };
  const call = { name: "fetch", arguments: { id: "projects/plan.md" } };
  const legacy = await contextTools(store, session, { legacy: true })(call.name, call.arguments);
  const direct = await callToolForSession(call, store, session, { legacy: true });
  const current = await callToolForSession(call, store, session);
  assert.notEqual(text(direct), text(current), "the option changes the answer, so this test can see it dropped");
  assert.equal(text(legacy), text(direct));
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?js$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

test("only the seam imports the gateway's MCP dispatcher", () => {
  const importers = walk(join(ROOT, "packages/tex"))
    .filter((file) => /from\s+"[^"]*apps\/mcp\/src\/tools\/session\.js"/.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).split("\\").join("/"));
  assert.deepEqual(importers, ["packages/tex/gateway/contextMcp.js"]);
});
