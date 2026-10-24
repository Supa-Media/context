/**
 * A rewrite of a long note saves in time.
 *
 * 2026-10-24: every save of a long finance note from the texting assistant
 * timed out, because a whole-note rewrite went through a character diff that
 * is roughly quadratic in the size of the edit (18 s for 20,000 characters,
 * run up to three times per save). `textDiff.js` bounds it; these tests hold
 * the bound and the exactness every tier must keep.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readDocument, replaceText } from "../src/index.js";
import { diffText } from "../src/textDiff.js";

const WORDS = "spending rent wealthfront marcus savings dining groceries uber verizon streaming card interest august september october total".split(" ");

/** Deterministic prose of about `size` characters, with a line break now and then. */
function prose(size, seed) {
  let state = seed;
  let text = "";
  while (text.length < size) {
    state = (state * 1103515245 + 12345) % 2147483648;
    text += WORDS[state % WORDS.length] + (state % 7 === 0 ? ` $${state % 9000}` : "") + (state % 11 === 0 ? "\n" : " ");
  }
  return text;
}

function spell(parts) {
  return {
    before: parts.filter((part) => !part.added).map((part) => part.value).join(""),
    after: parts.filter((part) => !part.removed).map((part) => part.value).join(""),
  };
}

test("every tier's parts spell exactly the text before and the text after", () => {
  const long = prose(30_000, 1);
  const cases = [
    ["", ""],
    ["", "new"],
    ["old", ""],
    ["same", "same"],
    ["a small edit 😭 here", "a smaller edit 😭 there"],
    [long, long.slice(0, 15_000) + "one inserted sentence. " + long.slice(15_000)],
    [long, prose(30_000, 2)], // a rewrite: past the character limit
    [long.replaceAll("\n", " "), prose(30_000, 3).replaceAll("\n", " ")], // a rewrite with no lines at all
    ["head " + "x\n".repeat(3_000) + " tail", "head " + "y\n".repeat(3_000) + " tail"], // past the line limit
  ];
  for (const [before, after] of cases) assert.deepEqual(spell(diffText(before, after)), { before, after });
});

test("a whole-note rewrite of a long note diffs in well under a second", () => {
  const before = prose(20_000, 1);
  const after = prose(24_000, 2);
  const began = Date.now();
  diffText(before, after);
  assert.ok(Date.now() - began < 2_000, `took ${Date.now() - began} ms`);
});

class MemoryStore {
  constructor() {
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true };
    this.objects = new Map();
    this.sequence = 0;
  }
  async get(key) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.text } : null;
  }
  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    if (options.onlyIf?.absent && current) return null;
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text: typeof value === "string" ? value : new TextDecoder().decode(value) });
    return { etag };
  }
  async delete(key) {
    this.objects.delete(key);
  }
  async list({ prefix = "" } = {}) {
    return { objects: [...this.objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, object]) => ({ key, etag: object.etag })), truncated: false };
  }
}

test("an agent rewriting a long note with new numbers saves it, in seconds, exactly", async () => {
  const store = new MemoryStore();
  store.objects.set("finances.md", { etag: "e0", text: `# Finances\n\n${prose(20_000, 1)}` });
  const first = await readDocument(store, "finances.md");
  const rewritten = `# Finances\n\n${prose(24_000, 2)}`;
  const began = Date.now();
  const saved = await replaceText(store, "finances.md", { documentId: first.documentId, expectedEtag: first.etag, text: rewritten });
  assert.ok(Date.now() - began < 5_000, `took ${Date.now() - began} ms`);
  assert.equal(saved.text, rewritten);
  // The same save again, as a retry after a timeout would send it, changes nothing.
  const again = await replaceText(store, "finances.md", { documentId: first.documentId, expectedEtag: first.etag, text: rewritten });
  assert.equal(again.text, rewritten);
});
