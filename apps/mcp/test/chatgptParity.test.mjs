import assert from "node:assert/strict";
import { chatgptOperations, chatgptCoverage } from "../src/mcp/chatgpt/operations.js";
import { chatgptTools } from "../src/mcp/chatgpt/tools.js";
import { ACTIONS } from "../src/tools/v2/actions.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { readFileSync } from "node:fs";
import { worker, env, accessTokenFor } from "./harness.mjs";

let id = 0;
async function rpc(method, params = {}, token = "priv-token", path = "/mcp/chatgpt/v2") {
  const response = await worker.fetch(new Request(`https://x${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessTokenFor(token)}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const call = (name, args = {}, token) => rpc("tools/call", { name, arguments: args }, token);
const text = r => r?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";

for (const [family, actions] of Object.entries(ACTIONS)) {
  for (const action of Object.keys(actions)) {
    const row = chatgptCoverage().find(r => r.capability === `${family}.${action}`);
    assert.ok(row, `Unaccounted existing capability: ${family}.${action}`);
    assert.ok(row.tools.length || row.exclusion, `Neither implemented nor explicitly excluded: ${row.capability}`);
  }
}
assert.deepEqual(chatgptCoverage().filter(r => r.exclusion).map(r => r.capability).sort(), ["send.api", "send.app"]);
const documented = JSON.parse(readFileSync(new URL("../../../docs/connectors/chatgpt-capabilities.json", import.meta.url), "utf8"));
assert.deepEqual(documented.capabilities, chatgptCoverage());
assert.deepEqual(documented.tool_names, chatgptOperations().map(op => op.name));
for (const original of toolDefinitions().filter(t => t.annotations.readOnlyHint)) {
  assert.ok(chatgptOperations().some(op => op.name === original.name || op.target === original.name), `Unaccounted read capability: ${original.name}`);
}
const definitions = await chatgptTools({ scope: "private", scopes: ["context:read", "context:write", "context:private"], contexts: [] });
assert.ok(definitions.some(t => t.name === "orient"));
for (const name of ["save_context", "remember", "create_form", "add_comment", "read_calendar", "send_email", "read_file", "move_folder", "set_visibility"]) {
  assert.ok(definitions.some(t => t.name === name), name);
}
for (const t of definitions) {
  assert.equal(t.inputSchema.additionalProperties, false, t.name);
  for (const flag of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof t.annotations[flag], "boolean", `${t.name}.${flag}`);
  assert.ok(!["write", "manage", "send", "app_read", "app_change", "slack_api", "vault_api"].includes(t.name));
}
const listing = await rpc("tools/list");
assert.ok(listing.tools.some(t => t.name === "orient"));
assert.equal((await rpc("tools/list", {}, "priv-token", "/mcp/chatgpt")).tools.length, 10, "Claude's frozen contract changed");
assert.deepEqual((await rpc("tools/list", {}, "priv-token", "/mcp")).tools.map(t => t.name).sort(), ["fetch", "manage", "orient", "search", "send", "write"]);
const orientation = await call("orient");
assert.ok(!orientation.isError, text(orientation));
assert.match(text(orientation), /Workspaces|Folders/);
assert.match(text(orientation), /orient_mark:/);
assert.ok(!text(orientation).includes("Six tools:"));
const manual = text(await call("orient", { about: "tools" }));
assert.match(manual, /save_context/);
assert.ok(!manual.includes("### send\n"));
assert.ok(!manual.includes("args: object"));
assert.ok(!text(await call("orient", { about: "website" })).includes("use manage `website`"));
assert.ok(!text(await call("orient", { about: "access" })).includes("share=anyone"));
assert.equal((await call("create_note", { path: "tex/parity.md", content: "# Parity note" })).isError, undefined);
const fetched = await call("fetch", { id: "tex/parity.md" });
assert.ok(!fetched.isError, text(fetched));
assert.match(text(fetched), /Parity note/);
assert.equal((await call("create_note", { path: "inbox/parity.md", content: "# Parity note" })).isError, undefined);
const scopedSearch = await call("search", { query: "Parity", prefix: "tex" });
assert.ok(scopedSearch.structuredContent.results.some(r => r.id.endsWith("tex/parity.md")));
assert.ok(scopedSearch.structuredContent.results.every(r => !r.id.endsWith("inbox/parity.md")));
assert.equal((await call("remember", { fact: "The parity sample ships on Friday.", kind: "stated", note: "tex/parity.md" })).isError, undefined);
assert.equal((await call("add_comment", { path: "tex/parity.md", quote: "Parity note", text: "Review comment" })).isError, undefined);
assert.equal((await call("create_form", { path: "inbox/parity-form.md", fields: [{ name: "answer", type: "line", max: 80 }] })).isError, undefined);
const savedMany = await call("save_notes", { notes: [{ path: "inbox/parity-bulk.md", content: "# Bulk sample" }] });
assert.ok(!savedMany.isError, text(savedMany));
assert.equal((await call("save_context", { platform: "chatgpt", content: "The user requested saving the sample decision.", title: "Parity summary" })).isError, undefined);
assert.equal((await call("create_note", { path: "tex/parity.md", content: "overwrite" })).isError, true);
assert.equal((await call("create_note", { path: "inbox/readonly.md", content: "no" }, "readonly-token")).isError, true);
assert.equal((await call("fetch", { id: "1-projects/secret-thing/status.md" }, "team-token")).isError, true);
assert.equal((await call("fetch", { id: "@no-access/index.md" })).isError, true);
assert.equal((await call("fetch", { id: "apps:slack", args: { tool: "delete", arguments: {} } })).isError, true);
assert.equal((await call("list_saved_credentials", { fetch: { url: "https://example.com" } })).isError, true);
assert.equal((await call("list_connected_apps", { app: "slack", tool: "write" })).isError, true);
assert.equal((await call("check_website", { action: "publish" })).isError, true);
assert.equal((await call("post_slack_message", { channel: "#sample", text: "sample", method: "admin.users.remove" })).isError, true);
assert.equal((await call("save_context", { platform: "chatgpt", content: "Decision summary", history: "raw transcript" })).isError, true);
assert.match(text(await call("report_problem", { message: "The tool failed.", share_texts: true })), /unknown argument "?share_texts/);
for (const name of ["write", "manage", "send", "app_change", "vault_list"]) assert.equal((await call(name, {})).isError, true);
assert.equal((await call("update_note", { path: "tex/parity.md", content: "bad", expected_etag: "stale" })).isError, true);
const metadata = await worker.fetch(new Request("https://x/.well-known/oauth-protected-resource/mcp/chatgpt/v2"), env, { waitUntil() {} });
assert.equal((await metadata.json()).resource, "https://x/mcp/chatgpt/v2");
const hostile = await worker.fetch(new Request("https://x/mcp/chatgpt/v2", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" }), env, { waitUntil() {} });
assert.equal(hostile.status, 403);
const unauthenticated = await worker.fetch(new Request("https://x/mcp/chatgpt/v2", { method: "POST", body: "{}" }), env, { waitUntil() {} });
assert.equal(unauthenticated.status, 401);
assert.match(unauthenticated.headers.get("WWW-Authenticate"), /oauth-protected-resource\/mcp\/chatgpt\/v2/);
assert.ok(chatgptOperations().length > 50);
console.log("PASS ChatGPT capability census, real orientation, frozen Claude contract, schemas and authority gates");
