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
 * 3. `steer.js` importing `toolIsWriting` from `tools/registry.js` again: "Tex reads Context's tool list only through
 *    the seam" fails.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { callContextTool, contextTools } from "../../../packages/tex/gateway/contextMcp.js";
import { callToolForSession } from "../src/tools/session.js";
import * as seam from "../../../packages/tex/gateway/contextMcp.js";
import { STAFF_ONLY_TOOLS, toolDefinitions, toolIsWriting } from "../src/tools/registry.js";
import { toolsForSession } from "../src/tools/advertised.js";
import { ACTIONS } from "../src/tools/v2/actions.js";
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

const importersOf = (pattern) =>
  walk(join(ROOT, "packages/tex"))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).split("\\").join("/"));

test("only the seam imports the gateway's MCP dispatcher", () => {
  assert.deepEqual(importersOf(/(?:from\s+|import\s*\(\s*)"[^"]*apps\/mcp\/src\/tools\/session\.js"/), ["packages/tex/gateway/contextMcp.js"]);
});

test("Tex reads Context's tool list only through the seam, never a gateway tool module", () => {
  assert.deepEqual(importersOf(/(?:from\s+|import\s*\(\s*)"[^"]*apps\/mcp\/src\/tools\/texSurface\.js"/), ["packages/tex/gateway/contextMcp.js"]);
  const modules = /apps\/mcp\/src\/(?:tools\/(?:registry|advertised|readFile|forwardRule|shownEmail|v2\/actions|v2\/translate|v2\/speak)|orient\/manual|plugins\/enablement)\.js"/;
  assert.deepEqual(importersOf(modules), []);
});

test("the seam's catalog is the gateway's own, and tools/list through it is the session's", async () => {
  assert.deepEqual(seam.toolDefinitions(), toolDefinitions());
  assert.equal(seam.STAFF_ONLY_TOOLS, STAFF_ONLY_TOOLS);
  assert.equal(seam.ACTIONS, ACTIONS);
  for (const name of ["write_note", "read_note", "send", "tex_dev"]) assert.equal(seam.toolIsWriting(name), toolIsWriting(name), name);
  const store = await storeWith({ "projects/a.md": "# A" });
  const session = { workspaceId: "w1", scope: "private", contexts: [] };
  for (const shape of ["v1", "v2", "all"]) {
    const names = (tools) => tools.map((tool) => tool.name);
    assert.deepEqual(names(await seam.listContextTools(store, session, { shape })), names(await toolsForSession(session, store, { shape })), shape);
  }
});
