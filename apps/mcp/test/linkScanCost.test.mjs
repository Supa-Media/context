/**
 * THE LINK SCANNERS ARE LINEAR, AND STILL MATCH WHAT THE REGEXES MATCHED.
 *
 * `codeRanges` and `parseLinks` (`src/links.js`) used to be quadratic in the
 * length of a note: a run of `[[` with no `]]` on the line made
 * `[^\]\n]+` scan to the end of the line from every start position, an
 * unclosed backtick run did the same for the inline-code span, and the
 * membership tests (`ranges.some`, `inCode`) walked the whole range list once
 * per match. Measured on the pre-fix code, `parseLinks` took 8.4 s on 64 KB of
 * `[[` and 33 s on 128 KB — clean 4x per doubling.
 *
 * That matters because nothing caps the text these see. The search indexer cuts
 * its input to `NOTE_INDEX_CHAR_CAP`, but reading a note
 * (`src/notes/embeds.js`, `src/notes/uploadedImages.js`), rewriting links on a
 * move (`src/tools/moves/references.js`, which walks every visible note) and
 * serving a published website page all hand over a whole note — and content
 * arrives in a workspace from outside it, through email ingestion into
 * `0-inbox/` under a 2 MB cap and through a `collect` form. One planted note
 * was enough to spend a request's entire CPU budget.
 *
 * Two kinds of check here, because a fast scanner that matches something else
 * is worse than a slow one:
 *
 *  1. **A differential fuzz** against the original regexes, kept below as the
 *     oracle. This module rewrites customer notes, so "linear" is worth
 *     nothing without "identical".
 *  2. **Cost bounds** on the shapes that used to blow up. The bounds are loose
 *     on purpose — 50x the fixed cost and a fraction of the old — so they fail
 *     on a quadratic regression and not on a slow machine.
 *
 * ## Sabotage record
 *
 * Each of these was put back into `src/links.js`, run, and taken out again.
 *
 *  - The old `WIKILINK` loop failed "a run of `[[` is linear", "`[[` broken up
 *    by filler", "a run of `[`" and the growth check.
 *  - The old inline-span regex failed "a run of backticks is linear" (3.1 s),
 *    "an unclosed fence over backticks" (3.1 s) and "many code spans alone".
 *  - `some` in place of the `within` cursors failed "many code spans and many
 *    links" (11.0 s against 42 ms) and "many code spans alone" (10.6 s against
 *    11 ms). It passed at 5,000 spans, which is why those two shapes are sized
 *    by the spans x queries product rather than by bytes.
 *  - Narrowing the wikilink inner class to exclude `[` — the tempting
 *    linear-looking one-character fix — failed "the shapes a note really has"
 *    on `[[a[b]]` and **not** the random fuzz. That is what the named shapes
 *    are for: the alphabet below produces `[[a[b]]` rarely enough that 2,000
 *    random cases missed it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { codeRanges, parseLinks } from "../src/links.js";

/* ------------------------------ the oracle ------------------------------- */

/*
  The scanners as they were written, byte for byte, before they were made
  linear. Slow on a pathological note, which is why they are here and not in
  `src/`, and exactly right on everything else, which is why they are the thing
  the fuzz compares against.
*/

function oracleCodeRanges(text) {
  const ranges = [];
  let offset = 0;
  let fence = null;

  for (const line of text.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence === null) {
      if (opener) fence = { char: opener[1][0], length: opener[1].length, start: offset };
    } else if (opener && opener[1][0] === fence.char && opener[1].length >= fence.length) {
      ranges.push([fence.start, offset + line.length]);
      fence = null;
    }
    offset += line.length + 1;
  }
  if (fence !== null) ranges.push([fence.start, text.length]);

  const spans = /(`+)(?:[^`]|(?!\1)`)*?\1/g;
  for (const match of text.matchAll(spans)) {
    const start = match.index;
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    ranges.push([start, start + match[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

const ORACLE_WIKILINK = /(!?)\[\[([^\]\n]+)\]\]/g;
const ORACLE_INLINE = /\[([^\]\n]*)\]\((<[^>\n]*>|[^\s()]*)\s*(?:"[^"\n]*"|'[^'\n]*')?\)/g;

function oracleParseLinks(text) {
  const skip = oracleCodeRanges(text);
  const inCode = (index) => skip.some(([from, to]) => index >= from && index < to);
  const found = [];

  for (const match of text.matchAll(ORACLE_WIKILINK)) {
    if (inCode(match.index)) continue;
    const inner = match[2];
    const bar = inner.indexOf("|");
    const target = bar === -1 ? inner : inner.slice(0, bar);
    const start = match.index + match[1].length + 2;
    found.push({ kind: "wiki", embed: match[1] === "!", target, start, end: start + target.length });
  }

  for (const match of text.matchAll(ORACLE_INLINE)) {
    if (inCode(match.index)) continue;
    const raw = match[2];
    const bracketed = raw.startsWith("<") && raw.endsWith(">");
    const target = bracketed ? raw.slice(1, -1) : raw;
    const start = match.index + match[1].length + 3 + (bracketed ? 1 : 0);
    found.push({
      kind: "inline",
      embed: match.index > 0 && text[match.index - 1] === "!",
      target,
      start,
      end: start + target.length,
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/* -------------------------------- the fuzz ------------------------------- */

/** xorshift32, so a failure is reproducible from the seed printed with it. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/*
  Every character that steers one of the three scanners, and nothing else: the
  bracket and paren grammar, the embed marker, the alias bar, the anchor, both
  fence characters, both quote characters, the angle brackets a bracketed target
  uses, whitespace, and two ordinary characters to separate them. A corpus of
  mostly-metacharacters is what finds a disagreement; prose would not.
*/
const ALPHABET = [..."[]()!`~\n |#<>\"' \t.a/"];

function fuzzCase(next, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[next() % ALPHABET.length];
  return out;
}

test("the scanners match the regexes they replaced, over random metacharacter soup", () => {
  for (const seed of [1, 2, 3, 7, 11, 13, 29, 101]) {
    const next = rng(seed);
    for (let i = 0; i < 250; i += 1) {
      const text = fuzzCase(next, 1 + (next() % 60));
      const label = `seed ${seed} case ${i}: ${JSON.stringify(text)}`;
      assert.deepEqual(codeRanges(text), oracleCodeRanges(text), label);
      assert.deepEqual(parseLinks(text), oracleParseLinks(text), label);
    }
  }
});

test("the scanners match the regexes on longer random cases", () => {
  const next = rng(4242);
  for (let i = 0; i < 60; i += 1) {
    const text = fuzzCase(next, 200 + (next() % 800));
    const label = `case ${i}: ${JSON.stringify(text)}`;
    assert.deepEqual(codeRanges(text), oracleCodeRanges(text), label);
    assert.deepEqual(parseLinks(text), oracleParseLinks(text), label);
  }
});

test("the scanners match the regexes on the shapes a note really has", () => {
  const cases = [
    "",
    "no links here at all",
    "[[note]] and [[folder/note|alias]] and ![[drawing.excalidraw.md]]",
    "[label](./a.md) [t](<a b.md> \"title\") [x](a.md#heading)",
    "```\n[[fenced.md]]\n```\n[[real.md]]",
    "~~~js\n[x](a.md)\n~~~\n`[[inline.md]]` [[outside.md]]",
    "``a `b` c`` [[after.md]]",
    "[[a[b]]",
    "[[]]",
    "[[ ]]",
    "[[a]]]",
    "[[[a]]",
    "[](a.md)",
    "[x]()",
    "![x](a.png)",
    "[x](<>)",
    "[id]: ./a.md",
    "unclosed ``` fence\n[[hidden.md]]",
    "mixed `one ``two``` [[x.md]]",
    "[[a|b|c]] [[#anchor]] [[a#b|c]]",
    "text [a](b.md) `[c](d.md)` [e](f.md)",
  ];
  for (const text of cases) {
    assert.deepEqual(codeRanges(text), oracleCodeRanges(text), JSON.stringify(text));
    assert.deepEqual(parseLinks(text), oracleParseLinks(text), JSON.stringify(text));
  }
});

/* ------------------------------ cost bounds ------------------------------ */

/*
  Each shape is 64 KB, well inside a note: the ingestion cap is 2 MB and
  `write_note`'s is larger still. The bound is 1 s against a fixed cost of a
  few ms and an old cost of seconds, so only a return to quadratic trips it.
*/
const BOUND_MS = 1_000;

function cost(run) {
  const started = performance.now();
  run();
  return performance.now() - started;
}

const SHAPES = {
  "a run of `[[` is linear": "[[".repeat(32768),
  "`[[` broken up by filler is linear": "[[a".repeat(21845),
  "a run of backticks is linear": "`".repeat(65536),
  "a run of `[` is linear": "[".repeat(65536),
  "an unclosed fence over backticks is linear": "```\n" + "`".repeat(65000),
  // The membership tests are quadratic in spans x queries rather than in
  // length, so these two are sized by that product and not by bytes: with
  // `some` back in place, 5,000 spans stayed inside the bound and 30,000 did
  // not. Both shapes are smaller than the 2 MB a note can arrive at.
  "many code spans and many links is linear": "`x` [[a.md]] ".repeat(30000),
  "many code spans alone is linear": "`a".repeat(65536),
  "many fences is linear": "```\nx\n```\n[[a.md]]\n".repeat(3000),
};

for (const [name, text] of Object.entries(SHAPES)) {
  test(name, () => {
    const ms = cost(() => parseLinks(text));
    assert.ok(ms < BOUND_MS, `${text.length} characters took ${Math.round(ms)} ms (bound ${BOUND_MS} ms)`);
  });
}

test("cost grows linearly, not quadratically, with length", () => {
  // Doubling the input must not quadruple the time. Measured against the
  // 32 KB cost with a 4x allowance, which a quadratic scanner blows by 2x
  // again at this size and a linear one comes nowhere near.
  const small = "[[".repeat(16384);
  const large = "[[".repeat(32768);
  const warm = () => {
    parseLinks(small);
    parseLinks(large);
  };
  warm();
  const smallMs = Math.max(cost(() => parseLinks(small)), 1);
  const largeMs = cost(() => parseLinks(large));
  assert.ok(largeMs < smallMs * 4, `32 KB took ${Math.round(smallMs)} ms, 64 KB took ${Math.round(largeMs)} ms`);
});
