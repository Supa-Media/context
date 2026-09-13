import assert from "node:assert/strict";
import {
  PLUGIN_RPC_VERSION,
  capabilityForOperation,
  parsePluginRpcRequest,
} from "../src/protocol.js";

function accepted(operation) {
  const parsed = parsePluginRpcRequest({
    version: PLUGIN_RPC_VERSION,
    requestId: "request_1",
    operation,
  });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return parsed.request;
}

function refused(value, code) {
  const parsed = parsePluginRpcRequest(value);
  assert.equal(parsed.ok, false, JSON.stringify(parsed));
  assert.equal(parsed.error.code, code);
}

const operations = [
  [{ kind: "vault.list", prefix: "1-projects" }, "vault:read"],
  [{ kind: "vault.read", path: "1-projects/plan.md" }, "vault:read"],
  [{ kind: "metadata.get", path: "1-projects/plan.md" }, "metadata:read"],
  [{ kind: "vault.create", path: "1-projects/new.md", text: "# New\n" }, "vault:write"],
  [{ kind: "vault.modify", path: "1-projects/plan.md", text: "# Plan\n", expectedEtag: "etag-1" }, "vault:write"],
  [{ kind: "vault.rename", from: "1-projects/a.md", to: "1-projects/b.md", expectedEtag: "etag-1" }, "vault:rename"],
  [{ kind: "vault.delete", path: "1-projects/a.md", expectedEtag: "etag-1" }, "vault:delete"],
  [{ kind: "settings.load" }, "settings:read"],
  [{ kind: "settings.save", json: "{}", expectedEtag: "etag-1" }, "settings:write"],
  [{ kind: "network.request", url: "https://api.example.test/v1/items", method: "GET", headers: [] }, "network:request"],
];

for (const [operation, capability] of operations) {
  const request = accepted(operation);
  assert.equal(capabilityForOperation(request.operation), capability);
  assert.deepEqual(request.operation, operation);
}

refused({ version: 2, requestId: "request_1", operation: operations[0][0] }, "UNSUPPORTED_VERSION");
refused({ version: 1, requestId: "request_1", workspaceId: "other", operation: operations[0][0] }, "INVALID_REQUEST");
refused({ version: 1, requestId: "request_1", pluginId: "forged", operation: operations[0][0] }, "INVALID_REQUEST");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.read", path: ".obsidian/plugins/x/data.json" } }, "INVALID_PATH");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.read", path: "../private.md" } }, "INVALID_PATH");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.modify", path: "note.md", text: "changed" } }, "ETAG_REQUIRED");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.delete", path: "note.md", expectedEtag: "" } }, "ETAG_REQUIRED");
refused({ version: 1, requestId: "request_1", operation: { kind: "network.request", url: "http://127.0.0.1/secrets", method: "GET", headers: [] } }, "INVALID_URL");
refused({ version: 1, requestId: "request_1", operation: { kind: "network.request", url: "https://user:pass@example.test", method: "GET", headers: [] } }, "INVALID_URL");
refused({ version: 1, requestId: "request_1", operation: { kind: "network.request", url: "https://api.example.test", method: "TRACE", headers: [] } }, "INVALID_METHOD");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.read", path: "note.md", scope: "private" } }, "INVALID_OPERATION");

console.log("obsidian runtime protocol: ok");
