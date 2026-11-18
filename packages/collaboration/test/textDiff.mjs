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
import { diffChars } from "diff";
import * as Y from "yjs";
import { readDocument, replaceText } from "../src/index.js";
import { replayResolution } from "../src/replay.js";
import { CHAR_EDIT_LIMIT, diffCounts, diffText, diffTextDetail, editsExceed, rememberedDiffs } from "../src/textDiff.js";

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

/*
 * A SAVE THAT REWRITES A NOTE DOES NOT PAY FOR A SEARCH THAT ANSWERS NOTHING, AND DIFFS ONCE.
 *
 * 2026-11-18: a plain `write` of a collaborative note waited a median 662 ms on its workspace object, all of it
 * computing: jsdiff's character search ran to its limit before giving up, and the save asked for that diff twice.
 * `editsExceed` says the same thing first without the search, and one replacement keeps its diffs.
 */

/** A deterministic generator, so a failure names texts that can be made again. */
function dice(seed) {
  let state = seed;
  return (below) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % below;
  };
}

test("editsExceed says exactly when jsdiff's character diff gives up, for any two texts and any limit", () => {
  const roll = dice(42);
  // Few letters, so texts share long runs by chance; a pair outside the BMP, so a token is not always one UTF-16 unit.
  // 😭 and 😀 share their first UTF-16 half, 𝒳 and 🂳 their second: shared ends must never be cut inside one.
  const alphabet = ["a", "b", "c", " ", "\n", "é", "😭", "😀", "𝒳", "🂳", "\ud83d"];
  const text = (length) => Array.from({ length }, () => alphabet[roll(alphabet.length)]).join("");
  const edited = (from) => {
    const points = Array.from(from);
    for (let edits = roll(12); edits > 0; edits -= 1) {
      const at = roll(points.length + 1);
      if (roll(2) === 0) points.splice(at, roll(4));
      else points.splice(at, 0, ...Array.from(text(roll(4))));
    }
    return points.join("");
  };
  const fixed = [["", ""], ["", "abc"], ["abc", ""], ["abc", "abc"], ["abc", "xyz"], ["😭", "😭😭"], ["a".repeat(40), "b".repeat(40)], ["ab".repeat(30), "ba".repeat(30)], ["x😭y", "x😀y"], ["x𝒳y", "x🂳y"], ["😭", "😀"], ["𝒳", "🂳"], ["a\ud83d", "a😭"], ["😭b", "\ude2db"]];
  let checked = 0;
  let gaveUp = 0;
  const check = (before, after) => {
    for (const limit of [0, 1, 2, 3, 5, 8, 13, 21, 40, 1_000]) {
      const jsdiff = diffChars(before, after, { maxEditLength: limit }) === undefined;
      assert.equal(editsExceed(before, after, limit), jsdiff, `limit ${limit}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      checked += 1;
      if (jsdiff) gaveUp += 1;
    }
  };
  for (const [before, after] of fixed) check(before, after);
  for (let round = 0; round < 1_500; round += 1) {
    const before = text(roll(60));
    check(before, roll(3) === 0 ? text(roll(60)) : edited(before));
  }
  // Both answers are exercised, or the comparison above proves nothing.
  assert.ok(gaveUp > checked / 10 && gaveUp < (checked * 9) / 10, `${gaveUp} of ${checked} gave up`);
});

test("editsExceed agrees with jsdiff at the limit a save uses, either side of it", () => {
  const before = prose(6_000, 5);
  const points = Array.from(before);
  // Replace one character at a time, spread out: each costs two edits (one out, one in).
  const withChanges = (count) => {
    const next = points.slice();
    for (let change = 0; change < count; change += 1) next[5 + change * 9] = "§";
    return next.join("");
  };
  for (const changes of [1, 250, 499, 500, 501, 600]) {
    const after = withChanges(changes);
    const jsdiff = diffChars(before, after, { maxEditLength: CHAR_EDIT_LIMIT }) === undefined;
    assert.equal(editsExceed(before, after, CHAR_EDIT_LIMIT), jsdiff, `${changes} changed characters`);
    assert.equal(jsdiff, changes > CHAR_EDIT_LIMIT / 2, `${changes} changed characters`);
  }
});

test("a rewrite never runs the character search, and an ordinary edit still gets its character diff", () => {
  const before = prose(20_000, 1);
  const rewrite = prose(24_000, 2);
  let searches = diffCounts.charSearches;
  assert.equal(diffTextDetail(before, rewrite).tier, "lines");
  assert.equal(diffCounts.charSearches, searches, "a rewrite ran jsdiff's character search to its limit");

  searches = diffCounts.charSearches;
  const small = before.slice(0, 9_000) + "one inserted sentence. " + before.slice(9_000);
  const detail = diffTextDetail(before, small);
  assert.equal(detail.tier, "chars");
  assert.equal(diffCounts.charSearches, searches + 1);
  // The parts are jsdiff's own, untouched.
  assert.deepEqual(detail.parts, diffChars(before, small, { maxEditLength: CHAR_EDIT_LIMIT }));
});

test("one replacement's diffs are each computed once, and a different pair is its own diff", () => {
  const diff = rememberedDiffs();
  const before = prose(4_000, 1);
  const after = prose(4_000, 2);
  const asked = diffCounts.detail;
  const first = diff(before, after);
  // Equal texts, not the same string objects: a save reads the text off the document each time.
  assert.equal(diff(`${before}`.slice(0), [after].join("")), first);
  assert.equal(diffCounts.detail, asked + 1);
  assert.notEqual(diff(after, before), first);
  assert.equal(diffCounts.detail, asked + 2);
  assert.deepEqual(diff(before, after), diffTextDetail(before, after));
  // Another replacement starts with nothing kept.
  const other = rememberedDiffs();
  other(before, after);
  assert.equal(diffCounts.detail, asked + 4);
});

for (const [name, change] of [
  ["a rewrite", (text) => `# Finances\n\n${prose(text.length, 9)}`],
  ["a small edit", (text) => `${text.slice(0, 500)}one inserted sentence. ${text.slice(500)}`],
]) {
  test(`a whole-note save (${name}) asks for one diff, and stores exactly the text it was given`, async () => {
    const store = new MemoryStore();
    store.objects.set("note.md", { etag: "e0", text: `# Finances\n\n${prose(12_000, 1)}` });
    const first = await readDocument(store, "note.md");
    const next = change(first.text);
    assert.notEqual(next, first.text);
    const asked = diffCounts.detail;
    const saved = await replaceText(store, "note.md", { expectedEtag: first.etag, onlyCurrent: true, text: next });
    assert.equal(saved.text, next);
    assert.equal(store.objects.get("note.md").text, next);
    assert.equal(diffCounts.detail - asked, 1, "the save computed its diff more than once");
  });
}

test("a save against an older base, with a peer's edit since, computes its base diff once and merges as before", async () => {
  const store = new MemoryStore();
  const original = "# Plan\n\nFirst line stays.\nSecond line stays.\nThird line stays.\n";
  store.objects.set("plan.md", { etag: "e0", text: original });
  const first = await readDocument(store, "plan.md");
  // A peer deletes the second line; the writer, still on the first version, rewrites the third.
  await replaceText(store, "plan.md", { expectedEtag: first.etag, text: original.replace("Second line stays.\n", "") });
  const asked = diffCounts.detail;
  const saved = await replaceText(store, "plan.md", { expectedEtag: first.etag, text: original.replace("Third line stays.", "Third line changed.") });
  assert.equal(saved.text, "# Plan\n\nFirst line stays.\nThird line changed.\n");
  // Base to desired (is the deleted run kept, then the merge's own update): one diff, not two.
  assert.equal(diffCounts.detail - asked, 1);
});

test("replayResolution decides the same with a remembered diff as without one", () => {
  const doc = (text) => {
    const made = new Y.Doc({ gc: false });
    made.getText("note").insert(0, text);
    return made;
  };
  const base = doc("alpha beta gamma\n");
  const fork = () => {
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(base));
    return copy;
  };
  const typed = fork();
  typed.getText("note").insert(typed.getText("note").length, "delta typed since\n");
  const cut = fork();
  cut.getText("note").delete(6, 5);
  const cases = [
    [base, "alpha beta gamma\n"],
    [base, "alpha beta gamma\nmore\n"],
    [typed, "alpha beta gamma\ndelta typed since\nand more\n"],
    [typed, "alpha beta gamma\n"],
    [typed, "something else entirely\n"],
    [cut, "alpha beta gamma\nmore\n"],
    [cut, "alpha gamma\nmore\n"],
  ];
  const seen = new Set();
  for (const [current, desired] of cases) {
    const plain = replayResolution(base, current, desired);
    assert.equal(replayResolution(base, current, desired, rememberedDiffs()), plain, desired);
    seen.add(plain);
  }
  // Every answer it can give is among the cases.
  assert.deepEqual([...seen].map(String).sort(), ["null", "rebase", "unchanged"]);
});
