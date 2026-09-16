import assert from "node:assert/strict";
import {
  PLUGIN_RPC_VERSION,
  authorizePluginRpcRequest,
  capabilityForOperation,
  parsePluginRpcRequest,
} from "../src/protocol.js";
import {
  PREVIEW_LINKS_MAX,
  PREVIEW_TEXT_MAX,
  parsePluginSandboxMessage,
  pluginSandboxDocument,
} from "../src/sandbox.js";

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
  [{ kind: "settings.save", json: "{}", expectedEtag: null }, "settings:write"],
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
refused({ version: 1, requestId: "request_1", operation: { kind: "network.request", url: "https://api.example.test:8443", method: "GET", headers: [] } }, "INVALID_URL");
refused({ version: 1, requestId: "request_1", operation: { kind: "network.request", url: "https://api.example.test", method: "TRACE", headers: [] } }, "INVALID_METHOD");
refused({ version: 1, requestId: "request_1", operation: { kind: "vault.read", path: "note.md", scope: "private" } }, "INVALID_OPERATION");

const readRequest = accepted({ kind: "vault.read", path: "note.md" });
assert.equal(authorizePluginRpcRequest(readRequest, {
  capabilities: ["vault:read"],
  networkHosts: [],
}).ok, true);
assert.equal(authorizePluginRpcRequest(readRequest, {
  capabilities: ["metadata:read"],
  networkHosts: [],
}).error.code, "CAPABILITY_DENIED");

const networkRequest = accepted({
  kind: "network.request",
  url: "https://api.example.test/v1/items",
  method: "GET",
  headers: [],
});
assert.equal(authorizePluginRpcRequest(networkRequest, {
  capabilities: ["network:request"],
  networkHosts: ["api.example.test"],
}).ok, true);
assert.equal(authorizePluginRpcRequest(networkRequest, {
  capabilities: ["network:request"],
  networkHosts: ["example.test"],
}).error.code, "NETWORK_HOST_DENIED");

const sandbox = pluginSandboxDocument();
assert.match(sandbox, /sandboxed|context-plugin-sandbox/);
assert.match(sandbox, /connect-src 'none'/);
assert.doesNotMatch(sandbox, /allow-same-origin/);
assert.doesNotMatch(sandbox, /runtimeToken|workspaceId/);
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "ready",
}, "secret"), { type: "ready" });
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "loaded",
}, "secret"), null);
/*
  `command-result` — the guest's answer to a host `command`.

  It is nonce-authenticated like every other observable event, because it is
  one: a forged result would tell the console a command it never ran had run,
  or hide a failure behind a success. `ok` is taken strictly rather than
  coerced, so a missing field reads as "no result" rather than as success.
*/
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "say-hello",
  ok: true,
}, "secret"), {
  type: "command-result",
  id: "say-hello",
  ok: true,
  error: null,
  /*
    `reason` is part of the shape, and `null` is the ordinary answer. It says
    why a command changed nothing when that is Context's sentence rather than
    the plugin's — it asked for the open note and there was none, or the owner
    has not let it write. A guest that omits the field means "nothing to say",
    never "some other reason".
  */
  reason: null,
});
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "throws",
  ok: false,
  error: "the command failed",
}, "secret"), {
  type: "command-result",
  id: "throws",
  ok: false,
  error: "the command failed",
  reason: null,
});
// And a reason outside the closed set is dropped rather than carried: the
// console turns this word into a sentence, so an unknown one would be a guest
// choosing which of Context's sentences a reader sees.
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "asked",
  ok: false,
  reason: "not-allowed",
}, "secret"), {
  type: "command-result",
  id: "asked",
  ok: false,
  error: null,
  reason: "not-allowed",
});
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "asked",
  ok: false,
  reason: "the owner is a fool",
}, "secret"), {
  type: "command-result",
  id: "asked",
  ok: false,
  error: null,
  reason: null,
});
/*
  `suggest-modal-picked` — how the reader's choice went.

  The same closed set as `command-result`'s, and the same reason for it: every
  way a pick fails looks identical from the reader's side, so the console has to
  say which it was, and it says it in its own words. A guest naming a reason
  outside the set gets `null`, which draws nothing at all.
*/
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-modal-picked",
  seq: 4,
  reopened: false,
  reason: "no-note",
}, "secret"), { type: "suggest-modal-picked", seq: 4, reopened: false, reason: "no-note" });
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-modal-picked",
  seq: 4,
  reopened: false,
}, "secret"), { type: "suggest-modal-picked", seq: 4, reopened: false, reason: null });
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-modal-picked",
  seq: 4,
  reopened: false,
  reason: { toString: () => "not-allowed" },
}, "secret"), { type: "suggest-modal-picked", seq: 4, reopened: false, reason: null });

// A result for a command the host never asked about is still well-formed; the
// host decides whether it was waiting. What must not parse is a malformed one.
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "say-hello",
}, "secret"), null, "a result with no ok must not parse");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "command-result",
  id: "say-hello",
  ok: "yes",
}, "secret"), null, "ok must be a boolean, not anything truthy");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "command-result",
  id: "say-hello",
  ok: true,
}, "secret"), null, "a forged result must not parse");
// Bounded like every other guest string: a plugin controls both of these.
{
  const long = parsePluginSandboxMessage({
    source: "context-plugin-sandbox",
    version: 1,
    nonce: "secret",
    type: "command-result",
    id: "x".repeat(500),
    ok: false,
    error: "e".repeat(2000),
  }, "secret");
  assert.equal(long.id.length, 100);
  assert.equal(long.error.length, 500);
}

/*
  `status-bar` — everything the plugin has put in the status bar, each time it
  changes.

  A whole list rather than an add/remove protocol, and that is the design
  decision worth the comment: the console replaces what it holds with what
  arrives, so a plugin that empties an item, removes one, or is torn down
  mid-render cannot leave a line behind that no longer exists. There is no
  removal message to lose.

  Every string is the plugin's, so every string is bounded, and the list itself
  is truncated rather than rejected — nine items is a plugin being greedy, not a
  forged message, and refusing the message outright would drop the eight
  legitimate ones with it. A malformed *entry* is different and rejects the
  whole message: it means the sender is not the shim we wrote.
*/
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "status-bar",
  items: [{ id: "status-1", text: "412 words" }],
}, "secret"), { type: "status-bar", items: [{ id: "status-1", text: "412 words" }] });
// An empty list is a real value: the plugin cleared its status bar, and the
// console has to be able to tell that from never having been told.
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "status-bar",
  items: [],
}, "secret"), { type: "status-bar", items: [] });
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "status-bar",
  items: [{ id: "status-1", text: "412 words" }],
}, "secret"), null, "a forged status bar must not parse");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "status-bar",
  items: "412 words",
}, "secret"), null, "items must be a list");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "status-bar",
  items: [{ id: "status-1" }],
}, "secret"), null, "an entry with no text must not parse");
{
  const many = parsePluginSandboxMessage({
    source: "context-plugin-sandbox",
    version: 1,
    nonce: "secret",
    type: "status-bar",
    items: Array.from({ length: 40 }, (_, index) => ({
      id: "i".repeat(200) + index,
      text: "t".repeat(900),
    })),
  }, "secret");
  assert.equal(many.items.length, 8, "the list is truncated, not rejected");
  assert.equal(many.items[0].id.length, 60);
  assert.equal(many.items[0].text.length, 120);
}

/*
  `suggest-results` / `suggest-applied` — the two halves of an editor
  suggestion, which is a round trip over one line and nothing else.

  Both are nonce-authenticated because both are observable: a forged result
  would put words into a completion menu somebody is about to accept into their
  own note, and a forged applied-line would hand the trusted editor text no
  plugin produced. `seq` is required on both so a result computed for a line the
  cursor has already left can be dropped rather than offered.
*/
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-results",
  seq: 3,
  items: [{ text: "John 3:16 (NIV)" }],
}, "secret"), { type: "suggest-results", seq: 3, items: [{ text: "John 3:16 (NIV)" }] });
// No match is an empty list, which is a different answer from no plugin at all.
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-results",
  seq: 4,
  items: [],
}, "secret"), { type: "suggest-results", seq: 4, items: [] });
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "suggest-results",
  seq: 3,
  items: [],
}, "secret"), null, "a forged suggestion list must not parse");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-results",
  items: [],
}, "secret"), null, "a result with no sequence cannot be matched to a query");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-results",
  seq: 3,
  items: [{ label: "John 3:16" }],
}, "secret"), null, "an entry without text must not parse");
{
  const many = parsePluginSandboxMessage({
    source: "context-plugin-sandbox",
    version: 1,
    nonce: "secret",
    type: "suggest-results",
    seq: 5,
    items: Array.from({ length: 40 }, () => ({ text: "t".repeat(900) })),
  }, "secret");
  assert.equal(many.items.length, 8, "the menu is truncated, not rejected");
  assert.equal(many.items[0].text.length, 200);
}
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "suggest-applied",
  seq: 3,
  line: "see [John 3:16](https://www.bible.com/bible/1/John.3.16)",
}, "secret"), {
  type: "suggest-applied",
  seq: 3,
  line: "see [John 3:16](https://www.bible.com/bible/1/John.3.16)",
});
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "suggest-applied",
  seq: 3,
  line: "anything",
}, "secret"), null, "a forged applied line must not reach the editor");
{
  const long = parsePluginSandboxMessage({
    source: "context-plugin-sandbox",
    version: 1,
    nonce: "secret",
    type: "suggest-applied",
    seq: 3,
    line: "x".repeat(9000),
  }, "secret");
  assert.equal(long.line.length, 4000);
}

/*
  `preview-results` — what a plugin's markdown post-processor attached to each
  of the note's links.

  Nonce-authenticated for the sharpest reason in this file: a forged one would
  draw somebody else's words in a tooltip over a link in a person's own note,
  under the name of a plugin they trusted enough to enable.

  The href travels with each preview rather than the previews being positional,
  because a processor may answer for a subset — YouVersion previews bible.com
  links and ignores the rest — and a positional list would slide every remaining
  verse onto the wrong link.
*/
const JOHN = "https://www.bible.com/bible/1/JHN.3.16";
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "preview-results",
  seq: 7,
  previews: [{ href: JOHN, text: "For God so loved the world" }],
}, "secret"), {
  type: "preview-results",
  seq: 7,
  previews: [{ href: JOHN, text: "For God so loved the world" }],
});
// A note whose links no processor was interested in, which is not the same
// answer as a guest that never replied.
assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "preview-results",
  seq: 8,
  previews: [],
}, "secret"), { type: "preview-results", seq: 8, previews: [] });
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "wrong",
  type: "preview-results",
  seq: 7,
  previews: [{ href: JOHN, text: "anything at all" }],
}, "secret"), null, "a forged preview must never reach a reader's tooltip");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "preview-results",
  previews: [],
}, "secret"), null, "a preview with no sequence cannot be matched to a query");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "preview-results",
  seq: 7,
  previews: [{ text: "a verse with no link to hang on" }],
}, "secret"), null, "a preview without an href must not parse");
assert.equal(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "preview-results",
  seq: 7,
  previews: "not a list",
}, "secret"), null, "previews must be a list");
{
  const many = parsePluginSandboxMessage({
    source: "context-plugin-sandbox",
    version: 1,
    nonce: "secret",
    type: "preview-results",
    seq: 9,
    previews: Array.from({ length: 200 }, (_, index) => ({
      href: JOHN + "#" + index,
      text: "v".repeat(5000),
    })),
  }, "secret");
  assert.equal(many.previews.length, PREVIEW_LINKS_MAX, "the list is truncated, not rejected");
  assert.equal(many.previews[0].text.length, PREVIEW_TEXT_MAX);
}

assert.deepEqual(parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  nonce: "secret",
  type: "rpc",
  request: {
    version: 1,
    requestId: "one",
    operation: { kind: "vault.read", path: "a.md" },
  },
}, "secret"), {
  type: "rpc",
  request: {
    version: 1,
    requestId: "one",
    operation: { kind: "vault.read", path: "a.md" },
  },
});

/*
  A SETTINGS PANE FROM A GUEST THAT IS NOT PLAYING ALONG.

  The real guest emits dense indices from zero, so nothing that drives it can
  reach these branches — which is exactly why they need their own checks. The
  index is what a reader's press is addressed by, so a guest that renumbered
  its rows could point a toggle at a different setting than the one on screen.
*/
const renumbered = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: true,
  error: null,
  rows: [
    { kind: "toggle", index: 0, name: "First", desc: "", value: true },
    // Claims to be row 7. Accepting it would make every later index wrong, and
    // a press on "Third" would arrive at the plugin as a press on something
    // else entirely.
    { kind: "toggle", index: 7, name: "Second", desc: "", value: false },
    { kind: "toggle", index: 1, name: "Third", desc: "", value: false },
  ],
});
assert.deepEqual(
  renumbered.rows.map((row) => [row.kind, row.name, row.index]),
  [
    ["toggle", "First", 0],
    ["toggle", "Third", 1],
  ],
  "a row claiming the wrong index is dropped, and the rest keep dense positions",
);

const unknownKind = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: true,
  error: null,
  rows: [
    { kind: "iframe", index: 0, name: "Sponsor" },
    { kind: "toggle", index: 0, name: "Real", desc: "", value: true },
  ],
});
assert.deepEqual(
  unknownKind.rows.map((row) => row.kind),
  ["toggle"],
  "a kind this console does not draw is dropped rather than passed through",
);

const closed = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: false,
  rows: [{ kind: "toggle", index: 0, name: "Ignored", desc: "", value: true }],
});
assert.deepEqual(closed, { type: "settings-pane", open: false, rows: [], error: null });

/*
  WHAT `display()` THREW HAS TO SURVIVE THE PARSE.

  The guest sends `error` on both branches and the console draws it, because a
  pane that stopped part-way looks exactly like a plugin with fewer settings —
  the quieter failure and the worse one, and the one the shim's missing
  `hide()` actually produced. A parser that drops the field on the OPEN branch
  puts that failure back: the rows the plugin managed to draw arrive looking
  like the whole pane.

  The closed branch is asserted just above. This is its twin, and `undefined`
  is checked for by name rather than by `?? null`, which is what let this
  through: the browser check reads `last.error ?? null`, so it passed whether
  the field survived or not.
*/
const stopped = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: true,
  error: "settingEl.hide is not a function",
  rows: [{ kind: "toggle", index: 0, name: "First", desc: "", value: true }],
});
assert.equal(
  stopped.error,
  "settingEl.hide is not a function",
  "what display() threw reaches the console that draws it",
);

const finished = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: true,
  error: null,
  rows: [{ kind: "toggle", index: 0, name: "First", desc: "", value: true }],
});
assert.strictEqual(
  finished.error,
  null,
  "a pane that ran to the end says so as null, never as a missing field",
);

// A guest that sends something other than a string says nothing, rather than
// putting an object into a sentence a reader is shown.
const oddError = parsePluginSandboxMessage({
  source: "context-plugin-sandbox",
  version: 1,
  type: "settings-pane",
  open: true,
  error: { toString: "not a string" },
  rows: [],
});
assert.strictEqual(oddError.error, null, "an error that is not a string is no error");

console.log("obsidian runtime protocol: ok");
