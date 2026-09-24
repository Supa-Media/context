/**
 * The per-note index cap: a giant note indexed by its head rather than its
 * whole body, the cap pinned at 2,048 characters in both directions, and the
 * miss text that says a long note might be the reason. See
 * searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  DEEP_TOKEN,
  NOTE_INDEX_CHAR_CAP,
  PRIVACY_MANIFEST,
  R2Store,
  convergeV2,
  createBucket,
  createSearchBudget,
  searchIndex,
  searchText,
  syncIndex,
} from "./fixtures.mjs";

export async function runSearchIntegrationPerNoteCapChecks(check, harness) {
  const { deep, env } = harness;

    // -- a giant note is indexed by its head, not its whole body -------------
    //
    // The outliers are 64KB+ saved sessions; indexing them whole is what
    // bloated the index past the memory ceiling. The head carries the
    // frontmatter, title, headings and opening prose ranking weighs most.
    {
      const capped = createBucket();
      capped.seed("privacy.md", PRIVACY_MANIFEST);
      capped.seed(
        "1-projects/log.md",
        `# Log\n\nThe AXOLOTL is in the head.\n${"filler words here ".repeat(600)}\nThe CAPYBARA hides in the tail.\n`
      );
      const cappedSync = await syncIndex(new R2Store(capped), { budget: createSearchBudget(50) });
      check(
        "a giant note is searchable by its head and its tail is deliberately not indexed",
        searchIndex(cappedSync.index, "axolotl").length === 1 &&
          searchIndex(cappedSync.index, "capybara").length === 0
      );
    }

    // -- and the cap is 2,048 characters, pinned in both directions ----------
    //
    // `#140` moved this constant from 8,192 and shipped no test of its own, so
    // a clean revert — or 10,000, or 64 — was invisible to CI: the fixture
    // above puts its discriminating token at one extreme far past the cap, and
    // every value in a wide range passes it.
    //
    // The pin is the indexed TOKEN COUNT, not a search hit, and that is the
    // whole point of the fixture. The first version put a marker either side of
    // the boundary and asserted one matched and one did not — and every cap
    // from 2,045 to 2,048 passed it, because a cut marker leaves a prefix in
    // the vocabulary and `df === 0` expansion finds it anyway. A search-based
    // probe of this constant measures the expander as much as the cap.
    //
    // The body is uniform four-character groups, so `len.body` is a direct
    // function of the cap. Measured at every value from 2,043 to 2,055: 2,046
    // through 2,049 pass and everything either side fails — four values, one
    // token group, which is as tight as a token count can be, and it catches
    // 8,192, 10,000 and 64 outright. (An earlier version of this comment said
    // "2,046 through 2,052", which was seven values and therefore could not be
    // one group wide. It came from running 2,045-2,048 and 2,053-2,055 and
    // writing the untested gap between them as if it had been measured, under
    // the word "Measured". The band's width is set by `tokenize`'s
    // `token.length >= 2` filter: a trailing "a" is dropped, "ab" is kept.)
    {
      const edge = createBucket();
      edge.seed("privacy.md", PRIVACY_MANIFEST);
      edge.seed("1-projects/edge.md", "abc ".repeat(4000));
      const edgeSync = await syncIndex(new R2Store(edge), { budget: createSearchBudget(50) });
      const doc = edgeSync.index.docs.get("1-projects/edge.md");
      check(
        "the per-note cap is 2,048 characters, pinned by the token count it produces",
        // 512 = 2,048 characters of "abc " groups. A literal, not
        // `NOTE_INDEX_CHAR_CAP / 4`: an expected value derived from the
        // constant under test moves with it and pins nothing.
        doc?.len.body === 512
      );
    }

    // -- a miss says why it might be a miss, and truncation is one of the whys
    //
    // Indexing a note by its head is a new way for a search to be incomplete,
    // and the advice on a miss enumerated the others while leaving this one
    // out: "try the term the user would have typed, drop the prefix, call
    // orient". A term 5KB into a saved session answers to none of those, and
    // the agent concludes it is not written down — about a note it can read in
    // full. Deliberately no count and no per-query signal: which notes are
    // long is a fact about the whole bucket, private ones included.
    {
      deep.seed("privacy.md", PRIVACY_MANIFEST);
      deep.seed(
        "1-projects/session.md",
        `# Session\n\nopening prose\n${"filler words here ".repeat(600)}\nThe PLATYPUS is 10KB in.\n`
      );
      // Indexed first, deliberately. A search reads a ready index and there is
      // none here yet, and the bounded literal scan that answers instead reads
      // whole notes — so it *finds* a term the index cannot, which is the right
      // behaviour and the wrong fixture for a check about the index's own
      // recall limit.
      await convergeV2(new R2Store(deep));
      const missed = await searchText(env, DEEP_TOKEN, { query: "platypus" });
      check(
        "a term past the per-note cap misses, and the advice says a long note is indexed by its head",
        missed.includes("(no matches)") &&
          /indexed by (its|their) open/i.test(missed) &&
          // The number in the sentence is the constant, not a retyped copy of
          // it: prose saying 2,000 while the code says 2,048 is the "two
          // copies of a rule" failure with nothing running both.
          missed.includes(NOTE_INDEX_CHAR_CAP.toLocaleString("en-US"))
      );
      const hit = await searchText(env, DEEP_TOKEN, { query: "opening" });
      check(
        "and that sentence is on the miss, not appended to every answer",
        hit.includes("1-projects/session.md") && !/indexed by (its|their) open/i.test(hit)
      );
    }

}
