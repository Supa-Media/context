/**
 * A model's fetch of a long note gives its outline and first part; the gateway's own reads stay whole
 * (`src/tools/notes/readCapped.js`; `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. `capWhole` returning `whole` unchanged: "a long note fetched by a model comes back as outline and first part" fails.
 * 2. The cap applied without `fetchCap`: "the gateway's own read_note of a long note is still whole" fails.
 * 3. `capBatch` ignoring its budget: "notes read together share one budget" fails.
 * 4. `session.js` not passing `fetchCap` for a v2 fetch: "a model's v2 fetch through the session is capped" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool } from "../src/tools/dispatch.js";
import { callToolForSession } from "../src/tools/session.js";
import { PART_CHARS } from "../src/notes/sections.js";
import { BATCH_CHARS } from "../src/tools/notes/readCapped.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "projects", visibility: "team" }, { prefix: "inbox", visibility: "team" }], notes: [] };
const FETCH = { fetchCap: true };

const LONG = ["# Log", "", ...Array.from({ length: 40 }, (_, i) => [`## Week ${i + 1}`, "", `${"An entry worth keeping. ".repeat(60)}`, ""]).flat()].join("\n");
const DAY = [
  "# Email, 2026-11-19",
  "",
  ...Array.from({ length: 30 }, (_, t) => [
    `## Thread — Subject ${t}`,
    "",
    ...Array.from({ length: 5 }, (_, m) => [`### 09:0${m} · Ann · Hi {#msg-${String(t).padStart(2, "0")}${String(m).padStart(2, "0")}aaaaaaaaaaaa}`, "", "x".repeat(300), ""]).flat(),
  ]).flat(),
].join("\n");

async function storeWith(notes) {
  const raw = createMemoryStore();
  for (const [key, body] of Object.entries(notes)) await raw.put(key, body);
  return withPrivacyAuthority(withServedTree(raw), { rules: RULES });
}
const text = (result) => result.content.map((part) => part.text).join("");

test("a long note fetched by a model comes back as outline and first part, with a part's etag", async () => {
  assert.ok(LONG.length > PART_CHARS);
  const store = await storeWith({ "projects/log.md": LONG });
  const read = await callTool("read_note", { path: "projects/log.md" }, store, "team", FETCH);
  assert.notEqual(read.isError, true, text(read));
  assert.ok(text(read).length <= PART_CHARS + 2_000, `${text(read).length} characters`);
  assert.match(text(read), /^etag: \S+;part$/m);
  assert.match(text(read), /^part: lines 1-\d+ of \d+; the note is ~[\d.]+k tokens/m);
  assert.match(text(read), /^more: lines: "\d+-\d+" reads on/m);
  assert.match(text(read), /Outline:\nL1-\d+ # Log/);
  const full = await callTool("read_note", { path: "projects/log.md", full: true }, store, "team", FETCH);
  assert.ok(text(full).endsWith(LONG), "full: true reads it whole");
});

test("the gateway's own read_note of a long note is still whole, and a short note is untouched", async () => {
  const store = await storeWith({ "projects/log.md": LONG, "projects/short.md": "# Short\n" });
  assert.ok(text(await callTool("read_note", { path: "projects/log.md" }, store, "team")).endsWith(LONG));
  const short = await callTool("read_note", { path: "projects/short.md" }, store, "team", FETCH);
  assert.doesNotMatch(text(short), /;part/);
});

test("a long day of messages is its outline: threads with how many messages each holds", async () => {
  const path = "inbox/email/ann-at-example-com/2026/11/2026-11-19.md";
  assert.ok(DAY.length > PART_CHARS);
  const store = await storeWith({ [path]: DAY });
  const read = await callTool("read_note", { path }, store, "team", FETCH);
  assert.match(text(read), /part: outline of \d+ lines/);
  assert.match(text(read), /## Thread — Subject 0 \(~[\d.k]+ tokens, 5 headings under it\)/);
  assert.doesNotMatch(text(read), /x{300}/, "no message bodies");
  const one = await callTool("read_note", { path, section: "msg-0003aaaaaaaaaaaa" }, store, "team", FETCH);
  assert.match(text(one), /### 09:03 · Ann · Hi/);
  assert.ok(text(one).length < 1_000);
});

test("notes read together share one budget; past it a note comes back as its outline", async () => {
  const notes = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`projects/log-${i}.md`, LONG]));
  const store = await storeWith(notes);
  const read = await callTool("read_notes", { paths: Object.keys(notes) }, store, "team", FETCH);
  assert.notEqual(read.isError, true, text(read));
  assert.equal(read.content.length, 4);
  assert.ok(text(read).length <= BATCH_CHARS + 8_000, `${text(read).length} characters`);
  assert.match(read.content[3].text, /part: outline of/);
});

test("a model's v2 fetch through the session is capped; a legacy read_note through it stays whole", async () => {
  const store = await storeWith({ "projects/log.md": LONG });
  const session = { scope: "team", workspaceId: "ws-cap" };
  const fetched = await callToolForSession({ name: "fetch", arguments: { id: "projects/log.md" } }, store, session);
  assert.notEqual(fetched.isError, true, text(fetched));
  assert.match(text(fetched), /;part$/m);
  assert.ok(!text(fetched).includes(LONG));
  const whole = await callToolForSession({ name: "fetch", arguments: { id: "projects/log.md", args: { full: true } } }, store, session);
  assert.ok(text(whole).includes(LONG), "args full: true reads it whole");
  const legacy = await callToolForSession({ name: "read_note", arguments: { path: "projects/log.md" } }, store, session);
  assert.ok(text(legacy).endsWith(LONG), "the gateway's and Tex's own read_note is whole");
});
