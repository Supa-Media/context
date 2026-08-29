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
}
