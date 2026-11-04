import assert from "node:assert/strict";
import { worker, env, accessTokenFor } from "./harness.mjs";

const names = ["get_profile", "list_workspaces", "get_workspace_overview", "list_notes", "search", "fetch", "create_note", "update_note", "move_note", "archive_note"];
let id = 0;
async function rpc(method, params = {}, token = "priv-token", headers = {}) {
  const response = await worker.fetch(new Request("https://x/mcp/chatgpt", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessTokenFor(token)}`, ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  }), env, { waitUntil() {} });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
const call = (name, args = {}, token) => rpc("tools/call", { name, arguments: args }, token);
const text = (result) => result?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? "";

const initial = await rpc("initialize", { protocolVersion: "2025-11-25" });
assert.ok(!/CALL.*FIRST|rediscover|save_session/.test(initial.instructions));
const listing = await rpc("tools/list");
assert.deepEqual(listing.tools.map(t => t.name).sort(), names.sort());
for (const tool of listing.tools) {
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(typeof tool.annotations.title, "string");
  for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) assert.equal(typeof tool.annotations[hint], "boolean");
}
assert.equal((await rpc("tools/list", {}, "readonly-token")).tools.length, 6);
for (const name of ["write", "manage", "send", "write_note", "save_context", "create_form"]) {
  assert.equal((await call(name, { path: "inbox/blocked.md", content: "blocked" })).isError, true);
}
assert.equal((await call("create_note", { workspace: "@alpha", path: "inbox/a.md", content: "a", share: "public" })).isError, true);
assert.equal((await call("fetch", { id: "apps:slack" })).isError, true);
assert.equal((await call("create_note", { path: "inbox/directory.md", content: "# Directory sample" }, "readonly-token")).isError, true);
assert.equal((await call("create_note", { path: "website/index.md", content: "publish" })).isError, true);
assert.equal((await call("create_note", { path: "inbox/form.md", content: "```form\nid: intake\n```" })).isError, true);
assert.equal((await call("create_note", { path: "inbox/directory.md", content: "# Directory sample" })).isError, undefined);
assert.equal((await call("create_note", { path: "inbox/directory.md", content: "overwrite" })).isError, true);
assert.equal((await call("update_note", { path: "inbox/missing.md", content: "bad", expected_etag: "" })).isError, true);
const found = (await call("search", { query: "Directory sample" })).structuredContent;
assert.ok(found.results.some(hit => hit.id.endsWith("inbox/directory.md")));
assert.match(found.results[0].url, /^https:\/\/context\.lc\/console\//);
assert.ok(!(await call("list_notes", { folder: "inbox" })).isError);
assert.ok(!(await call("get_workspace_overview")).isError);
const opened = await call("fetch", { id: "inbox/directory.md" });
assert.match(text(opened), /Directory sample/);
const note = opened.structuredContent;
assert.ok(note.metadata.etag);
assert.equal((await call("update_note", { path: "inbox/directory.md", content: "stale", expected_etag: "stale" })).isError, true);
assert.equal((await call("update_note", { path: "inbox/directory.md", content: "# Updated sample", expected_etag: note.metadata.etag })).isError, undefined);
assert.equal((await call("fetch", { id: "1-projects/secret-thing/status.md" }, "team-token")).isError, true);
assert.equal((await call("fetch", { id: "@no-access/inbox/directory.md" })).isError, true);
const updated = (await call("fetch", { id: "inbox/directory.md" })).structuredContent;
const moved = await call("move_note", { path: "inbox/directory.md", destination: "inbox/directory-renamed.md", expected_etag: updated.metadata.etag });
assert.ok(!moved.isError, text(moved));
const renamed = (await call("fetch", { id: "inbox/directory-renamed.md" })).structuredContent;
const archived = await call("archive_note", { path: "inbox/directory-renamed.md", expected_etag: renamed.metadata.etag });
assert.ok(!archived.isError, text(archived));
const profile = (await call("get_profile")).structuredContent;
assert.ok(profile.id);
assert.deepEqual((await call("get_profile")).structuredContent, profile);
const metadata = await worker.fetch(new Request("https://x/.well-known/oauth-protected-resource/mcp/chatgpt"), env, { waitUntil() {} });
assert.equal((await metadata.json()).resource, "https://x/mcp/chatgpt");
const hostile = await worker.fetch(new Request("https://x/mcp/chatgpt", { method: "POST", headers: { Origin: "https://evil.example" }, body: "{}" }), env, { waitUntil() {} });
assert.equal(hostile.status, 403);
console.log("PASS directory endpoint: explicit tools, hidden-operation refusal, privacy, writes, conflict, OAuth and origin checks");
