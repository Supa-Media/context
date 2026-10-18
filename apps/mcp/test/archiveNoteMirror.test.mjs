/**
 * `archive_note` files a note at its own path inside Archive, so Archive keeps
 * the workspace's shape (`archiveMirror.cjs`, owner 2026-10-18), and a second
 * note of the same name from the same folder arrives numbered, never on top.
 *
 * Sabotage, run as a temporary local edit and reverted: put the timestamp
 * folder back in `toolArchiveNote` and both cases fail.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolArchiveNote } from "../src/tools/moves/archive.js";

function bucket(files) {
  const objects = new Map(Object.entries(files).map(([key, body]) => [key, { body, etag: `v-${key}` }]));
  let counter = 0;
  const store = {
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    async head(key) {
      const value = objects.get(key);
      return value ? { etag: value.etag, size: value.body.length } : null;
    },
    async exists(key) {
      return objects.has(key);
    },
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return { etag: value.etag, httpMetadata: {}, text: async () => value.body, arrayBuffer: async () => new TextEncoder().encode(value.body).buffer };
    },
    async put(key, body, options = {}) {
      if (options.onlyIf?.absent && objects.has(key)) return null;
      if (options.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      const text = typeof body === "string" ? body : new TextDecoder().decode(body);
      const etag = `e${++counter}`;
      objects.set(key, { body: text, etag });
      return { etag };
    },
    async delete(key, options = {}) {
      if (options.onlyIf?.etagMatches && objects.get(key)?.etag !== options.onlyIf.etagMatches) return false;
      objects.delete(key);
      return true;
    },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      if (!delimiter) return { objects: keys.map((key) => ({ key, etag: objects.get(key).etag, size: 1 })), truncated: false };
      const direct = keys.filter((key) => !key.slice(prefix.length).includes(delimiter));
      const folders = [...new Set(keys.filter((key) => key.slice(prefix.length).includes(delimiter)).map((key) => prefix + key.slice(prefix.length).split(delimiter)[0] + delimiter))];
      return { objects: direct.map((key) => ({ key, etag: objects.get(key).etag, size: 1 })), delimitedPrefixes: folders, truncated: false };
    },
  };
  return { store, objects };
}

const RULES = [{ prefix: "4-archive", vis: "private" }];

test("a note lands at its own path inside Archive, with no date folder", async () => {
  const { store, objects } = bucket({ "1-projects/launch/plan.md": "# Plan\n" });
  const answer = await toolArchiveNote(store, "private", RULES, new Map(), "1-projects/launch/plan.md");
  assert.equal(answer.isError, undefined, answer.content[0].text);
  assert.match(answer.content[0].text, /^archived: 1-projects\/launch\/plan\.md → 4-archive\/1-projects\/launch\/plan\.md/);
  assert.equal(objects.get("4-archive/1-projects/launch/plan.md")?.body, "# Plan\n");
  assert.ok(!objects.has("1-projects/launch/plan.md"));
});

test("a second note of the same name from the same folder arrives numbered, and the first is untouched", async () => {
  const { store, objects } = bucket({
    "1-projects/launch/plan.md": "# Newer plan\n",
    "4-archive/1-projects/launch/plan.md": "# Older plan\n",
  });
  const answer = await toolArchiveNote(store, "private", RULES, new Map(), "1-projects/launch/plan.md");
  assert.match(answer.content[0].text, /→ 4-archive\/1-projects\/launch\/plan \(2\)\.md/);
  assert.equal(objects.get("4-archive/1-projects/launch/plan.md")?.body, "# Older plan\n");
  assert.equal(objects.get("4-archive/1-projects/launch/plan (2).md")?.body, "# Newer plan\n");
});
