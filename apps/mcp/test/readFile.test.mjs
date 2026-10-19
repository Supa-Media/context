/**
 * `read_file`: a stored file's words, through `fetch`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are the checks that failed.
 *
 * 1. **`canSee` dropped from `toolReadFile`** — 2: the hidden-file row (a
 *    team caller reads a private attachment's words) and the no-converter row.
 * 2. **The bytes fetched before `canSee`** — the hidden-file row fails on the
 *    store's get log.
 * 3. **`read_file` removed from `UNTRUSTED_READS`** — the egress row fails.
 * 4. **The file branch in `translateFetch` removed** — the routing row fails:
 *    a PDF path lists a folder.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toolReadFile, readableFileType, MAX_FILE_BYTES } from "../src/tools/readFile.js";
import { translateFetch } from "../src/tools/v2/searchFetch.js";
import { newLedger, recordRead } from "../src/privacy/egress.js";
import { loadPrivacyState } from "../src/privacy/state.js";
import { PRIVACY_KEY } from "../src/privacy/engine.js";

const PDF = "0-inbox/email/someone-at-example-com/attachments/2026/10/16/abc123-pricing.pdf";
const HIDDEN = "1-projects/vault/contract.pdf";

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.gets = [];
  }
  seed(key, value) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.objects.set(key, { bytes, etag: `e${this.objects.size + 1}` });
  }
  async get(key) {
    this.gets.push(key);
    const item = this.objects.get(key);
    if (!item) return null;
    return {
      key,
      etag: item.etag,
      size: item.bytes.byteLength,
      text: async () => new TextDecoder().decode(item.bytes),
      arrayBuffer: async () => item.bytes.buffer.slice(item.bytes.byteOffset, item.bytes.byteOffset + item.bytes.byteLength),
    };
  }
  async head(key) {
    const item = this.objects.get(key);
    return item ? { key, etag: item.etag, size: item.bytes.byteLength } : null;
  }
  async list({ prefix = "" } = {}) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, item]) => ({ key, etag: item.etag, size: item.bytes.byteLength }));
    return { objects, truncated: false };
  }
}

const RULES = `# Privacy

<!-- BEGIN BRAIN PRIVACY RULES -->

\`\`\`yaml
default_visibility: team

folder_defaults:
  1-projects/vault/: private

note_overrides:
  # none
\`\`\`

<!-- END BRAIN PRIVACY RULES -->
`;

function fakeAi(answer) {
  const calls = [];
  return {
    calls,
    run: async () => ({}),
    toMarkdown: async (files) => {
      calls.push(files);
      return typeof answer === "function" ? answer(files) : answer;
    },
  };
}

async function world(ai = fakeAi([{ name: "pricing.pdf", format: "markdown", data: "# Pricing\n\nOct 30: $40 per lane hour" }])) {
  const store = new MemoryStore();
  store.seed(PRIVACY_KEY, RULES);
  store.seed(PDF, "%PDF-1.7 fake");
  store.seed(HIDDEN, "%PDF-1.7 secret");
  if (ai) store.ai = ai;
  const { rules, overrides } = await loadPrivacyState(store);
  return { store, rules, overrides, ai };
}

const text = (result) => result.content.map((part) => part.text).join("\n");

test("a stored PDF comes back as its words, marked untrusted", async () => {
  const { store, rules, overrides, ai } = await world();
  const result = await toolReadFile(store, "private", rules, overrides, PDF);
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /Oct 30: \$40 per lane hour/);
  assert.match(text(result), /^trust: untrusted$/m);
  assert.match(text(result), /^type: application\/pdf$/m);
  const [[file]] = ai.calls;
  assert.equal(file.name, "abc123-pricing.pdf");
  assert.equal(file.blob.type, "application/pdf");
  assert.equal(await file.blob.text(), "%PDF-1.7 fake");
});

test("a file the caller cannot see is refused exactly as a missing one, and its bytes are never read", async () => {
  const { store, rules, overrides, ai } = await world();
  const hidden = await toolReadFile(store, "team", rules, overrides, HIDDEN);
  const missing = await toolReadFile(store, "team", rules, overrides, "1-projects/vault/never.pdf");
  assert.equal(hidden.isError, true);
  assert.equal(JSON.stringify(hidden), JSON.stringify(missing));
  assert.ok(!store.gets.includes(HIDDEN), "the hidden file's bytes were fetched");
  assert.equal(ai.calls.length, 0);
});

test("a deployment without the converter says so, after the visibility check", async () => {
  const { store, rules, overrides } = await world(null);
  assert.match(text(await toolReadFile(store, "private", rules, overrides, PDF)), /not available on this deployment/);
  assert.match(text(await toolReadFile(store, "team", rules, overrides, HIDDEN)), /^not found$/);
});

test("a converter failure, an error answer and an empty answer are each a plain refusal", async () => {
  const thrown = await world(fakeAi(() => { throw new Error("boom"); }));
  assert.match(text(await toolReadFile(thrown.store, "private", thrown.rules, thrown.overrides, PDF)), /could not be read just now/);
  const refused = await world(fakeAi([{ name: "x", format: "error", error: "bad pdf" }]));
  assert.match(text(await toolReadFile(refused.store, "private", refused.rules, refused.overrides, PDF)), /no words could be taken/);
  const empty = await world(fakeAi([{ name: "x", format: "markdown", data: "  " }]));
  assert.match(text(await toolReadFile(empty.store, "private", empty.rules, empty.overrides, PDF)), /no words could be taken/);
});

test("a file over the ceiling is refused before it is converted", async () => {
  const { store, rules, overrides, ai } = await world();
  store.seed(PDF, new Uint8Array(MAX_FILE_BYTES + 1));
  assert.match(text(await toolReadFile(store, "private", rules, overrides, PDF)), /over the 10 MB/);
  assert.equal(ai.calls.length, 0);
});

test("only the listed file types are opened; a note is not", async () => {
  const { store, rules, overrides } = await world();
  assert.match(text(await toolReadFile(store, "private", rules, overrides, "1-projects/a.md")), /a note is read with read_note/);
  assert.equal(readableFileType("a/B.PDF"), "application/pdf");
  assert.equal(readableFileType("a/b.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(readableFileType("a/b.svg"), null);
  assert.equal(readableFileType("a/b.md"), null);
});

test("fetch routes a file path to read_file, and a folder or note as before", () => {
  assert.deepEqual(translateFetch({ id: PDF }, { client: "claude-code" }), {
    name: "read_file",
    arguments: { path: PDF },
    action: "file",
  });
  assert.equal(translateFetch({ id: "1-projects/a.md" }, { client: "claude-code" }).name, "read_note");
  assert.equal(translateFetch({ id: "0-inbox/email/" }, { client: "claude-code" }).name, "list_notes");
  assert.match(translateFetch({ id: PDF, args: { limit: 3 } }, { client: "claude-code" }).error, /takes no args/);
});

test("reading a file marks the turn as having taken in outside words", () => {
  const ledger = newLedger();
  recordRead(ledger, { name: "read_file", args: { path: "1-projects/plan.pdf" }, result: { content: [{ type: "text", text: "path: x" }] } });
  assert.equal(ledger.untrusted, true);
});
