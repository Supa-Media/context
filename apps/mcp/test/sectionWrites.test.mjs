/**
 * Changing part of a note: one section, or find-and-replace edits (`src/tools/notes/writePart.js`;
 * `docs/decisions/gateway-protocol/section-reads.md`).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. The section hash ignored (`unchanged` forced false): "a section write lands after an edit elsewhere" fails.
 * 2. The stale check skipped (`stale` forced false): "a section changed since it was read is refused" fails.
 * 3. Multiple matches allowed: "an edit that matches twice is refused, naming both lines" fails.
 * 4. The comment-anchor check removed: "an edit that would remove a comment's anchor is refused" fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { callTool } from "../src/tools/dispatch.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { withServedTree } from "./servedTree.mjs";

const RULES = { etag: "rows-v1", accessVersion: 1, folders: [{ prefix: "projects", visibility: "team" }, { prefix: "private", visibility: "private" }], notes: [] };

const NOTE = [
  "# Plan",
  "",
  "## Goals",
  "",
  "- Ship it",
  "",
  "## Risks",
  "",
  "Legal may slip. Legal is slow.",
  "",
  "## Decisions",
  "",
  "We chose <!--c:k7f2-->Friday<!--/c:k7f2-->.",
  "",
  "```comments",
  'k7f2 "Friday"',
  "- 2026-09-27T07:30:12Z Codex: sure?",
  "```",
].join("\n");

async function storeWith(notes) {
  const raw = createMemoryStore();
  for (const [key, body] of Object.entries(notes)) await raw.put(key, body);
  return withPrivacyAuthority(withServedTree(raw), { rules: RULES });
}

const text = (result) => result.content.map((part) => part.text).join("");
const etagOf = (result) => /^etag: (\S+)$/m.exec(text(result))?.[1];
async function bodyNow(store, path = "projects/plan.md") {
  const read = await callTool("read_note", { path }, store, "team");
  return text(read).slice(text(read).indexOf("\n\n") + 2);
}

test("a section read, changed and written back replaces just that section", async () => {
  const store = await storeWith({ "projects/plan.md": NOTE });
  const read = await callTool("read_note", { path: "projects/plan.md", section: "Risks" }, store, "team");
  const written = await callTool("write_note", { path: "projects/plan.md", section: "Risks", content: "## Risks\n\nNone left.", expected_etag: etagOf(read) }, store, "team");
  assert.notEqual(written.isError, true, text(written));
  const after = await bodyNow(store);
  assert.match(after, /## Risks\n\nNone left\.\n\n## Decisions/);
  assert.match(after, /- Ship it/);
  assert.match(after, /```comments\nk7f2/);
});

test("a section write lands after an edit elsewhere, and is refused when its own section changed", async () => {
  const store = await storeWith({ "projects/plan.md": NOTE });
  const read = await callTool("read_note", { path: "projects/plan.md", section: "Risks" }, store, "team");
  const other = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "- Ship it", new: "- Ship it soon" }] }, store, "team");
  assert.notEqual(other.isError, true, text(other));
  const landed = await callTool("write_note", { path: "projects/plan.md", section: "Risks", content: "## Risks\n\nFew.", expected_etag: etagOf(read) }, store, "team");
  assert.notEqual(landed.isError, true, text(landed));
  assert.match(await bodyNow(store), /- Ship it soon[\s\S]*## Risks\n\nFew\./);

  const again = await callTool("read_note", { path: "projects/plan.md", section: "Risks" }, store, "team");
  await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Few.", new: "Some." }] }, store, "team");
  const refused = await callTool("write_note", { path: "projects/plan.md", section: "Risks", content: "## Risks\n\nMine.", expected_etag: etagOf(again) }, store, "team");
  assert.equal(refused.isError, true);
  assert.match(text(refused), /this section changed since you read it[\s\S]*Some\./);
  assert.doesNotMatch(text(refused), /Ship it/, "only the section comes back, never the whole note");
  const noEtag = await callTool("write_note", { path: "projects/plan.md", section: "Risks", content: "## Risks\n\nMine." }, store, "team");
  assert.match(text(noEtag), /needs the etag its section read gave/);
});

test("append and prepend add to a section without an etag", async () => {
  const store = await storeWith({ "projects/plan.md": NOTE });
  assert.notEqual((await callTool("write_note", { path: "projects/plan.md", section: "Goals", insert: "append", content: "- Tell people" }, store, "team")).isError, true);
  assert.notEqual((await callTool("write_note", { path: "projects/plan.md", section: "Decisions", insert: "prepend", content: "Latest first." }, store, "team")).isError, true);
  const after = await bodyNow(store);
  assert.match(after, /- Ship it\n- Tell people\n\n## Risks/);
  assert.match(after, /## Decisions\nLatest first\.\n\nWe chose/);
});

test("an edit must match once: zero or two matches change nothing and say where", async () => {
  const store = await storeWith({ "projects/plan.md": NOTE });
  const none = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Tuesday", new: "x" }] }, store, "team");
  assert.match(text(none), /edit 1: 0 matches/);
  const twice = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Legal", new: "Counsel" }] }, store, "team");
  assert.match(text(twice), /edit 1: 2 matches in the note, at L9, L9/);
  const scoped = await callTool("write_note", { path: "projects/plan.md", section: "Goals", edits: [{ old: "Legal", new: "x" }] }, store, "team");
  assert.match(text(scoped), /0 matches for its old text in that section/);
  const all = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Legal", new: "Counsel", replace_all: true }, { old: "- Ship it", new: "- Ship" }] }, store, "team");
  assert.notEqual(all.isError, true, text(all));
  const after = await bodyNow(store);
  assert.match(after, /Counsel may slip\. Counsel is slow\./);
  assert.match(after, /^- Ship$/m);
  const halfway = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "- Ship", new: "- Go" }, { old: "nowhere", new: "x" }] }, store, "team");
  assert.equal(halfway.isError, true);
  assert.match(await bodyNow(store), /^- Ship$/m, "all or nothing");
});

test("an edit never reaches the comments block, and may not remove a comment's anchor", async () => {
  const store = await storeWith({ "projects/plan.md": NOTE });
  const block = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Codex: sure?", new: "gone" }] }, store, "team");
  assert.match(text(block), /0 matches/);
  const anchor = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "<!--c:k7f2-->Friday<!--/c:k7f2-->", new: "Monday" }] }, store, "team");
  assert.match(text(anchor), /comment's anchor/);
  const inside = await callTool("write_note", { path: "projects/plan.md", edits: [{ old: "Friday<!--/c", new: "Monday<!--/c" }] }, store, "team");
  assert.notEqual(inside.isError, true, text(inside));
});

test("a part write to a note the caller cannot see is refused as a whole write would be", async () => {
  const store = await storeWith({ "private/secret.md": NOTE });
  const refused = await callTool("write_note", { path: "private/secret.md", edits: [{ old: "Friday", new: "x" }] }, store, "team");
  const read = await callTool("read_note", { path: "private/secret.md" }, store, "team");
  assert.equal(refused.isError, true);
  assert.deepEqual(refused, read);
});
