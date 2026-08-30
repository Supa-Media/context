/**
 * The indexer half of the search format contract: field extraction, the
 * in-memory Maps, and the serialize/parse round trip — against
 * `src/search/CONTRACT.md`.
 *
 * The prototype-pollution checks are the ones that matter most here: a path
 * of `"__proto__"` or a term of `"constructor"` is ordinary attacker-chosen
 * text sitting inside a note somebody's context already holds, and
 * `parseIndex` reads it back off the bucket on every search. If it ever landed
 * as a plain-object property name instead of a `Map` key, every future reader
 * of that object would inherit it.
 */

import {
  emptyIndex,
  extractFields,
  addDoc,
  removeDoc,
  serializeIndex,
  parseIndex,
} from "../src/search/indexer.js";
import { exceedsUtf8Bytes } from "../src/search/maintain.js";
import { termsOf, tokenize } from "../src/search/text.js";

export async function runSearchIndexerChecks(check) {
  // -- field extraction --------------------------------------------------

  {
    const content =
      "---\n" +
      "tags: [Project-X, planning]\n" +
      "---\n\n" +
      "# The Heading\n\n" +
      "Some body text.\n";
    const fields = extractFields("1-projects/plan.md", content);
    check("an inline frontmatter tags array feeds the tags field", fields.tags.join(",") === "Project-X,planning");
    check("the first ATX heading becomes the title", fields.title === "The Heading");
  }

  {
    const content = "---\ntags:\n  - solo\n  - 'quoted tag'\n---\n\nNo heading here.\n";
    const fields = extractFields("notes/x.md", content);
    check(
      "a list-form frontmatter tags block feeds the tags field, quotes stripped",
      fields.tags.join(",") === "solo,quoted tag"
    );
    check(
      "a note with no ATX heading falls back to its filename for the title",
      fields.title === "x"
    );
  }

  {
    const content = "---\ntags: [a]\n---\n\n# Title\n\n## Sub heading\n\nBody paragraph one.\n\nBody paragraph two.\n";
    const fields = extractFields("n.md", content);
    check("frontmatter never leaks into body", !fields.body.includes("tags:"));
    check("heading lines never leak into body", !fields.body.includes("Title") && !fields.body.includes("Sub heading"));
    check("body still carries the ordinary paragraphs", fields.body.includes("Body paragraph one."));
    check("headings carries every heading level, title's line included", fields.headings === "Title\nSub heading");
  }

  {
    const content = "# Note\n\nSee [[Other Note]] and [[Other Note|an alias]] and [[already.md]].\n";
    const fields = extractFields("1-projects/note.md", content);
    check(
      "a bare wikilink resolves against the note's folder with .md appended",
      fields.links.includes("1-projects/Other Note.md")
    );
    check(
      "a wikilink alias is dropped and only the target is resolved",
      fields.links.filter((l) => l === "1-projects/Other Note.md").length === 1
    );
    check(
      "a wikilink target that already ends in .md is not double-suffixed",
      fields.links.includes("1-projects/already.md")
    );
  }

  {
    const content =
      "# Note\n\n" +
      "[sibling](./sibling.md) and [up-and-over](../../2-areas/topic.md) " +
      "and [escapes](../../../outside.md) and [web](https://example.com/x.md) " +
      "and [mail](mailto:a@b.com) and [image](./pic.png).\n";
    // note lives two folders deep (1-projects/sub/), so two ../ reaches the
    // bucket root and three ../ overshoots it.
    const fields = extractFields("1-projects/sub/note.md", content);
    check(
      "a ./ relative link resolves against the note's own folder",
      fields.links.includes("1-projects/sub/sibling.md")
    );
    check(
      "a ../ relative link normalizes up and back across folders",
      fields.links.includes("2-areas/topic.md")
    );
    check(
      "a relative link with enough ../ to escape the bucket root is dropped",
      !fields.links.some((l) => l.includes("outside.md"))
    );
    check(
      "a scheme'd URL is dropped even when it ends in .md",
      !fields.links.some((l) => l.includes("example.com"))
    );
    check("a mailto: link is dropped", !fields.links.some((l) => l.includes("b.com")));
    check("a link that does not resolve to .md is dropped", !fields.links.some((l) => l.includes("pic.png")));
  }

  // -- add / replace / remove --------------------------------------------

  {
    const index = emptyIndex();
    addDoc(index, "a.md", { etag: "e1", uploaded: "2026-01-01T00:00:00.000Z", content: "# Alpha\n\nFirst body.\n" });
    check("a fresh doc is recorded with rank 0", index.docs.get("a.md").rank === 0);
    check("a term from the indexed doc is posted under its path", index.terms.get("alpha")?.has("a.md"));

    addDoc(index, "a.md", { etag: "e2", uploaded: "2026-01-02T00:00:00.000Z", content: "# Beta\n\nSecond body.\n" });
    check("re-adding the same path replaces its doc entry", index.docs.get("a.md").etag === "e2");
    check("replacing a doc removes its old terms", !index.terms.has("alpha"));
    check("replacing a doc's terms leaves no dangling posting for the new term either", index.terms.get("beta")?.get("a.md")?.[0] === 1);
    check("a term with only the replaced doc's old posting is dropped entirely, not left empty", !index.terms.has("first"));

    const otherIndex = emptyIndex();
    addDoc(otherIndex, "shared.md", { etag: "e1", uploaded: null, content: "# Gamma\n\nGamma body gamma.\n" });
    addDoc(otherIndex, "other.md", { etag: "e1", uploaded: null, content: "# Gamma too\n\nUnrelated.\n" });
    check(
      "two docs sharing a term both keep a posting for it",
      otherIndex.terms.get("gamma")?.has("shared.md") && otherIndex.terms.get("gamma")?.has("other.md")
    );
    removeDoc(otherIndex, "shared.md");
    check("removeDoc drops the doc entry", !otherIndex.docs.has("shared.md"));
    check("removeDoc leaves no dangling posting for the removed doc", !otherIndex.terms.get("gamma")?.has("shared.md"));
    check("a shared term survives removal of one of its two docs", otherIndex.terms.get("gamma")?.has("other.md"));

    removeDoc(otherIndex, "other.md");
    check("removing the last doc referencing a term drops the term entirely", !otherIndex.terms.has("gamma"));
    check("removeDoc on a path that was never indexed is a harmless no-op", (() => {
      removeDoc(otherIndex, "never-existed.md");
      return otherIndex.docs.size === 0 && otherIndex.terms.size === 0;
    })());
  }

  // -- serialize / parse round trip ---------------------------------------

  {
    const index = emptyIndex();
    addDoc(index, "1-projects/plan.md", {
      etag: "e1",
      uploaded: "2026-02-01T00:00:00.000Z",
      content: "---\ntags: [work]\n---\n\n# The Plan\n\nLinks to [[Other]].\n",
    });
    addDoc(index, "0-inbox/note.md", { etag: "e2", uploaded: null, content: "# Quick Note\n\nNothing else.\n" });
    const text = serializeIndex(index);
    const parsed = JSON.parse(text);
    check("serializeIndex emits the pinned version number", parsed.version === 1);
    check("serializeIndex stamps a generatedAt timestamp", typeof parsed.generatedAt === "string" && !Number.isNaN(Date.parse(parsed.generatedAt)));
    check("serializeIndex emits docs as an array of pairs, not a keyed object", Array.isArray(parsed.docs) && Array.isArray(parsed.docs[0]));
    check("serializeIndex sorts docs by path", parsed.docs[0][0] === "0-inbox/note.md" && parsed.docs[1][0] === "1-projects/plan.md");

    const restored = parseIndex(text);
    check("parseIndex succeeds on serializeIndex's own output", restored !== null);
    check("the round trip preserves every doc path", [...restored.docs.keys()].sort().join(",") === "0-inbox/note.md,1-projects/plan.md");
    check(
      "the round trip preserves a doc's fields exactly",
      restored.docs.get("1-projects/plan.md").etag === "e1" &&
        restored.docs.get("1-projects/plan.md").title === "The Plan" &&
        restored.docs.get("1-projects/plan.md").uploaded === "2026-02-01T00:00:00.000Z"
    );
    check(
      "the round trip preserves per-field term counts",
      JSON.stringify(restored.docs.get("1-projects/plan.md").len) === JSON.stringify(index.docs.get("1-projects/plan.md").len)
    );
    check(
      "the round trip preserves term postings",
      JSON.stringify(restored.terms.get("plan")?.get("1-projects/plan.md")) ===
        JSON.stringify(index.terms.get("plan")?.get("1-projects/plan.md"))
    );
    check(
      "re-serializing the parsed index reproduces the same bytes (minus the timestamp)",
      serializeIndex(restored).replace(/"generatedAt":"[^"]*"/, "") === text.replace(/"generatedAt":"[^"]*"/, "")
    );
  }

  // -- parseIndex: null on anything it cannot fully validate --------------

  check("parseIndex rejects a non-string argument", parseIndex(undefined) === null && parseIndex(42) === null);
  check("parseIndex rejects unparseable garbage", parseIndex("not json at all {{{") === null);
  check(
    "parseIndex rejects the wrong version",
    parseIndex(JSON.stringify({ version: 2, docs: [], terms: [] })) === null
  );
  {
    const full = JSON.stringify({ version: 1, docs: [["a.md", { etag: "e", uploaded: null, title: "A", links: [], len: { title: 0, headings: 0, tags: 0, body: 0 }, rank: 0 }]], terms: [] });
    const truncated = full.slice(0, Math.floor(full.length / 2));
    check("parseIndex rejects truncated JSON", parseIndex(truncated) === null);
  }
  check(
    "parseIndex rejects a posting whose tf is not an array",
    parseIndex(JSON.stringify({ version: 1, docs: [], terms: [["word", [["a.md", "not-an-array"]]]] })) === null
  );
  check(
    "parseIndex rejects a doc entry missing a required field",
    parseIndex(JSON.stringify({ version: 1, docs: [["a.md", { etag: "e", title: "A" }]], terms: [] })) === null
  );
  check(
    "parseIndex rejects when docs is not an array",
    parseIndex(JSON.stringify({ version: 1, docs: {}, terms: [] })) === null
  );
  check(
    "parseIndex never returns a partially-valid index — one bad doc among good ones fails the whole parse",
    parseIndex(
      JSON.stringify({
        version: 1,
        docs: [
          ["a.md", { etag: "e", uploaded: null, title: "A", links: [], len: { title: 0, headings: 0, tags: 0, body: 0 }, rank: 0 }],
          ["b.md", { etag: "e" }],
        ],
        terms: [],
      })
    ) === null
  );
  check("parseIndex never throws on malformed input", (() => {
    try {
      parseIndex("{");
      parseIndex(null);
      parseIndex(JSON.stringify({ version: 1, docs: "nope", terms: "nope" }));
      return true;
    } catch {
      return false;
    }
  })());

  // -- prototype pollution: the load-bearing case --------------------------

  {
    const index = emptyIndex();
    addDoc(index, "__proto__", { etag: "e1", uploaded: null, content: "# Danger\n\nconstructor body constructor.\n" });
    check(
      "a doc path of \"__proto__\" indexes as an ordinary Map key",
      index.docs.has("__proto__") && index.docs.get("__proto__").etag === "e1"
    );
    check(
      "indexing a \"__proto__\" path never touches Object.prototype",
      !Object.prototype.hasOwnProperty.call(Object.prototype, "etag")
    );
    check(
      "a term of \"constructor\" (from the body text) indexes as an ordinary Map key",
      index.terms.get("constructor")?.has("__proto__")
    );

    const text = serializeIndex(index);
    const restored = parseIndex(text);
    check("parseIndex round-trips a \"__proto__\" doc path safely", restored !== null && restored.docs.has("__proto__"));
    check("parseIndex round-trips a \"constructor\" term safely", restored.terms.get("constructor")?.has("__proto__"));
    check(
      "after the full add → serialize → parse round trip, Object.prototype is still clean",
      Object.getOwnPropertyNames(Object.prototype).every(
        (name) => !["etag", "uploaded", "title", "links", "len", "rank"].includes(name)
      )
    );

    // The same two strings arriving straight through JSON.parse, with no
    // validation in between, is the attack this whole check exists to catch.
    const hostile = JSON.stringify({
      version: 1,
      docs: [["__proto__", { etag: "e", uploaded: null, title: "T", links: [], len: { title: 0, headings: 0, tags: 0, body: 0 }, rank: 0 }]],
      terms: [["constructor", [["__proto__", [1, 0, 0, 0]]]]],
    });
    const parsedHostile = parseIndex(hostile);
    check(
      "parseIndex accepts a hostile-but-well-typed __proto__/constructor payload without polluting Object.prototype",
      parsedHostile !== null &&
        parsedHostile.docs.get("__proto__").etag === "e" &&
        Object.getOwnPropertyNames(Object.prototype).every(
          (name) => !["etag", "uploaded", "title", "links", "len", "rank"].includes(name)
        )
    );
    check(
      "an ordinary plain object is unaffected by any of the above",
      JSON.stringify({}) === "{}"
    );
  }

  // -- the tokenizer's floor, which nothing had pinned ----------------------
  //
  // `token.length >= 2` in text.js, and it is load-bearing in BOTH directions
  // while being tested in neither: mutated to `>= 1` or to `>= 3` the whole
  // suite stayed green, and only `>= 4` failed — through the per-note cap's
  // token count, which is a different rule entirely.
  //
  // At `>= 3`, every two-character term silently stops being searchable. "AI",
  // "ML", "US", "id", "ok", "go", "PR" are ordinary words in a personal brain,
  // and the failure mode is a miss with no explanation attached — the same
  // shape as a term past the per-note cap, and this one would not even have the
  // sentence on the miss to explain it.
  //
  // At `>= 1`, every stray letter becomes a vocabulary entry. That is index
  // size, and index size is what `INDEX_PARSE_BYTE_CAP` exists to bound: a
  // brain of prose has a single-letter run on most lines.
  //
  // text.js calls itself "the one copy of the rules", and `searchQuery`'s
  // header is explicit that it borrows `termsOf` as a fixture helper rather
  // than as a subject. So this is the tokenizer's first test.
  {
    const twoChars = tokenize("AI and ML at 3M, PR go ok");
    check(
      "a two-character run is a term, so ordinary short words stay searchable",
      ["ai", "ml", "at", "3m", "pr", "go", "ok"].every((term) => twoChars.includes(term))
    );
    check(
      "a one-character run is not a term, so single letters stay out of the vocabulary",
      tokenize("a b c 1 2 x").length === 0 &&
        tokenize("one a two").join(" ") === "one two"
    );
    // Through `termsOf` as well, since that is what the indexer and the query
    // parser both call — a floor enforced in `tokenize` and lost in the wrapper
    // would be a floor that holds nowhere it matters.
    check(
      "and the same floor holds through termsOf, which is what both sides call",
      termsOf("a b AI").join(" ") === "ai" && !termsOf("x y z").length
    );
  }

  // -- the write cap's byte count, against the encoder it stands in for ------
  //
  // `exceedsUtf8Bytes` exists so the sync can decide whether the serialized
  // index fits *without* allocating a second copy of it to find out, inside
  // the 128MB limit the cap is there to respect. That makes it a hand-written
  // reimplementation of one line of `TextEncoder`, and the way to hold a
  // second copy of a rule is to run both against a corpus rather than to read
  // it — the method that beat reading in `#121`.
  //
  // The corpus is chosen for the four widths and the two ways a surrogate can
  // appear, because those are what a plausible edit gets wrong: a pair is one
  // code point in four bytes, and a *lone* surrogate of either half is not a
  // code point at all — `TextEncoder` emits the three-byte replacement
  // character, and a count that treated it as two would drift under the cap on
  // exactly the malformed input a note is free to contain.
  {
    const encoder = new TextEncoder();
    const corpus = [
      "",
      "a",
      "plain ascii index body",
      "\u0000\u007f\u0080\u07ff",
      "\u0800\uffff",
      "見出しの日本語",
      "\u{1f600}\u{10ffff}",
      "lone high \ud800 then text",
      "lone low \udc00 then text",
      "\ud800\ud800\udc00\udfff",
      // A high surrogate followed by a multi-byte character. Not decoration:
      // in every other malformed case here the two readings happen to total
      // the same — a lone high before a space is 3 + 1, and mistaking them for
      // a pair is 4 — so a pair test that never checks the *second* half
      // agrees with the encoder by coincidence. These two are where it stops.
      "\ud800\u6f22",
      "\ud800\ud800",
      // Two adjacent LOW surrogates. Widening the pair test's upper bound from
      // 0xdc00 to 0xe000 — one word, and it reads like a tidier "is this a
      // surrogate" — makes this pair four bytes where the encoder says six,
      // and undercounting is the direction that stores an object the read then
      // refuses.
      "\udc00\udc00",
      "mixed aé漢\u{1f4a9}z",
      "x".repeat(300),
      "é".repeat(300),
      "漢".repeat(300),
      "\u{1f600}".repeat(300),
    ];
    let compared = 0;
    const disagreements = [];
    for (const value of corpus) {
      const truth = encoder.encode(value).byteLength;
      for (const cap of [0, 1, truth - 1, truth, truth + 1, Math.floor(truth / 2), value.length, value.length * 3]) {
        compared += 1;
        if (exceedsUtf8Bytes(value, cap) !== truth > cap) disagreements.push([value, cap, truth]);
      }
    }
    check(
      "the write cap's byte count agrees with TextEncoder on every width, both surrogate shapes, and each cap either side of the true size",
      // The literal is the point. `compared === corpus.length * 8` derives both
      // sides from the same array, so it holds for any corpus including an
      // empty one — the corpus could be gutted, taking the surrogate cases with
      // it, and this check would still pass while a mutation it is credited
      // with catching walked through.
      compared === 144 && disagreements.length === 0
    );
    check(
      "and it answers without allocating: a body under a third of the cap and one longer than it are decided from the length alone",
      exceedsUtf8Bytes("\u{1f600}".repeat(10), 1000) === false &&
        exceedsUtf8Bytes("a".repeat(1001), 1000) === true
    );

    // The hand-picked corpus above says which cases somebody thought of. This
    // says what the encoder says, over every code unit there is and over
    // strings nobody chose — the difference between a fixture and a corpus,
    // and the reason a doc comment may not cite a fuzz run that lives only in
    // a terminal somewhere. Seeded, so a failure is reproducible and the suite
    // stays deterministic; still well under a second.
    // The pad is two-byte on purpose. With an ASCII pad, an ASCII code unit at
    // `cap = truth - 1` has `length > cap` and is refused by the O(1) bound
    // without ever being counted — 128 of the cases below, silently not
    // testing the thing this loop is named for. A pad whose bytes outnumber
    // its code units keeps `length` under every cap tried here.
    const pad = "\u00e9\u00e9\u00e9";
    let unitCases = 0;
    let unitBad = 0;
    let unitScanned = 0;
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const value = `${pad}${String.fromCharCode(unit)}${pad}`;
      const truth = encoder.encode(value).byteLength;
      for (const cap of [truth - 1, truth, truth + 1]) {
        unitCases += 1;
        if (value.length <= cap && value.length * 3 > cap) unitScanned += 1;
        if (exceedsUtf8Bytes(value, cap) !== truth > cap) unitBad += 1;
      }
    }
    check(
      "every BMP code unit, padded so neither O(1) bound can decide it, is counted as TextEncoder counts it",
      unitCases === 65536 * 3 && unitScanned === unitCases && unitBad === 0
    );

    let seed = 0x9e3779b9;
    const next = () => {
      // xorshift32 — deterministic, and short enough not to be a dependency.
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed;
    };
    let fuzzCases = 0;
    let fuzzBad = 0;
    // Counted, because `fuzzCases === 4000 * 6` is a fact about the loop rather
    // than about the corpus: widen the first branch to `roll < 1000` and every
    // string is plain ASCII, the check's own name becomes false, and nothing
    // fails. These are what the name claims are in here.
    let sawAstral = 0;
    let sawLoneSurrogate = 0;
    let sawTwoByte = 0;
    let sawThreeByte = 0;
    for (let trial = 0; trial < 4000; trial += 1) {
      let value = "";
      const length = 1 + (next() % 24);
      for (let i = 0; i < length; i += 1) {
        const roll = next() % 100;
        if (roll < 35) value += String.fromCharCode(next() % 0x80);
        else if (roll < 55) value += String.fromCharCode(0x80 + (next() % 0x780));
        else if (roll < 75) value += String.fromCharCode(0x800 + (next() % 0xd000));
        else if (roll < 90) value += String.fromCodePoint(0x10000 + (next() % 0xfffff));
        // The last tenth is a bare surrogate of either half, which is what
        // makes the corpus adversarial rather than merely wide.
        else value += String.fromCharCode(0xd800 + (next() % 0x800));
      }
      if (/[\u{10000}-\u{10ffff}]/u.test(value)) sawAstral += 1;
      // Not `\p{Surrogate}` — a well-formed pair does not match a lone one, and
      // it is the lone half this corpus exists to carry.
      if (/(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/.test(value)) {
        sawLoneSurrogate += 1;
      }
      if (/[\u0080-\u07ff]/.test(value)) sawTwoByte += 1;
      if (/[\u0800-\ud7ff\ue000-\uffff]/.test(value)) sawThreeByte += 1;
      const truth = encoder.encode(value).byteLength;
      for (const cap of [0, truth - 1, truth, truth + 1, value.length, value.length * 3]) {
        fuzzCases += 1;
        if (exceedsUtf8Bytes(value, cap) !== truth > cap) fuzzBad += 1;
      }
    }
    check(
      "and so is every string a seeded corpus of astral pairs and unpaired surrogates can produce",
      fuzzCases === 4000 * 6 &&
        fuzzBad === 0 &&
        sawAstral > 1000 &&
        sawLoneSurrogate > 1000 &&
        sawTwoByte > 1000 &&
        sawThreeByte > 1000
    );
  }
}
