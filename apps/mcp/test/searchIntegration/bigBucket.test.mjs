/**
 * (c)/(h) a bucket too large to index in one pass: the backfill that spends
 * its budget across searches, one unreadable note that must not park it,
 * fetching in parallel waves, and the write-side byte cap that refuses an
 * oversized shard or manifest unparsed and never writes past it either. See
 * searchIntegration.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import {
  BIG_TOKEN,
  PRIVACY_MANIFEST,
  PRIVACY_MANIFEST_READ,
  R2Store,
  RANK_CAP,
  SEARCH_INDEX_KEY,
  SEARCH_RESULT_LIMIT,
  SEARCH_SUBREQUEST_BUDGET,
  SUBREQUEST_LIMIT,
  createBucket,
  createSearchBudget,
  searchIndex,
  searchText,
  syncIndex,
} from "./fixtures.mjs";

export async function runSearchIntegrationBigBucketChecks(check, harness) {
  const { big, env } = harness;

    // -- (c)/(h) a bucket too large to index in one pass ---------------------
    big.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 65; n += 1) {
      big.seed(
        `1-projects/bulk/note-${String(n).padStart(3, "0")}.md`,
        `# Bulk note ${n}\n\nEvery bulk note mentions the widget, this one is number ${n}.\n`
      );
    }

    big.resetCounts();
    const bigFirst = await searchText(env, BIG_TOKEN, { query: "widget" });
    const bigFirstOps = big.ops;
    check(
      "one search on a 65-note context stays inside the subrequest budget",
      bigFirstOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        bigFirstOps < SUBREQUEST_LIMIT
    );
    check(
      "and it answers rather than failing on the notes it did reach",
      typeof bigFirst === "string" && bigFirst.includes("1-projects/bulk/note-")
    );

    // The floor language belongs to the *indexed* answer, and the first search
    // over a bucket with no index is the literal scan — which has its own
    // honest sentence and a different one. What the deferred pass built by then
    // is what the second search reads, and it is genuinely partial: 65 notes do
    // not fit in one invocation's budget.
    big.resetCounts();
    const bigSecond = await searchText(env, BIG_TOKEN, { query: "widget" });
    check(
      "a backfill that ran out of budget says so, in the floor language the census uses",
      bigSecond.includes("still catching up")
    );
    check(
      "and the floor carries no count, which would be a fact about notes the caller may not see",
      !/still catching up[^\]]*\d/.test(bigSecond)
    );
    check(
      "the second search on that context is bounded too, and continues the backfill",
      // Every write is behind the response now, and which ones they are is the
      // point: a shard the backfill landed in, the manifest over it, and the
      // diff under it. A pass that wrote only the manifest would be vouching
      // for docs no shard holds.
      big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET && big.counts.put >= 2
    );
    check(
      "results stay bounded at the result limit however many notes match",
      (bigSecond.match(/^1-projects\/bulk\//gm) || []).length <= SEARCH_RESULT_LIMIT
    );

    // The module directly, where `pending` is visible as a number rather than
    // as a sentence.
    const bigStore = new R2Store(big);
    // From no index at all, which is what a first search on a context this size
    // actually faces — the two searches above have already backfilled part of it.
    big.remove(SEARCH_INDEX_KEY);
    const pass = await syncIndex(bigStore, {
      budget: createSearchBudget(SEARCH_SUBREQUEST_BUDGET),
      reserve: SEARCH_RESULT_LIMIT,
    });
    check(
      "syncIndex reports the notes it did not reach rather than pretending it finished",
      pass.pending > 0 && pass.spent <= SEARCH_SUBREQUEST_BUDGET - SEARCH_RESULT_LIMIT
    );
    // Run it out: a bounded loop of bounded passes must converge, or the
    // backfill is a treadmill.
    let converged = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      converged = await syncIndex(bigStore, { budget: createSearchBudget(200) });
      if (converged.pending === 0) break;
    }
    check(
      "and repeated passes converge on a complete index",
      converged.pending === 0 && converged.index.docs.size === 65
    );
    check(
      "a converged index re-syncs without re-reading a single note body",
      await (async () => {
        big.resetCounts();
        const idle = await syncIndex(bigStore, { budget: createSearchBudget(200) });
        return idle.pending === 0 && big.counts.noteGets.length === 0 && big.counts.put === 0;
      })()
    );
    check(
      "searchIndex never returns more than the rank cap the tool's floor language assumes",
      searchIndex(converged.index, "widget").length === RANK_CAP
    );

    // -- one unreadable note must not park the backfill ----------------------
    //
    // The stale list is walked in listing order, so with a `break` on a failed
    // read, a single key the adapter refuses (a backslash, a control character
    // — keys Obsidian and rclone write without asking) stalled the sync at the
    // same spot on every pass, and every note sorting after it stayed
    // unsearchable forever. Measured live as "searched a name we have multiple
    // notes about, got nothing, forever." The unreadable note itself stays
    // pending — a skip is not a completion.
    big.remove(SEARCH_INDEX_KEY);
    big.failGetKeys.add("1-projects/bulk/note-000.md");
    const poisoned = await syncIndex(bigStore, { budget: createSearchBudget(200) });
    check(
      "a note the store refuses to read is skipped, not the end of the backfill",
      poisoned.index.docs.size === 64 && poisoned.pending === 1
    );
    big.failGetKeys.delete("1-projects/bulk/note-000.md");

    // -- the backfill fetches in parallel waves, not one awaited GET ---------
    //
    // A sequential loop was a wall-clock bug the budget could not see: a
    // paid-plan budget authorizes hundreds of fetches, which one at a time is
    // 30-60 seconds — past what MCP clients wait — so the client timed out,
    // the invocation died with it, and the conditional put never ran. Measured
    // live: a bigger budget made convergence *less* likely. The stub's gets
    // resolve on a real timer here so overlap is observable; one in-flight at
    // a time is the regression.
    {
      const slow = createBucket();
      slow.seed("privacy.md", PRIVACY_MANIFEST);
      for (let n = 0; n < 30; n += 1) {
        slow.seed(`1-projects/wave/note-${String(n).padStart(2, "0")}.md`, `# W${n}\n\nwave marker\n`);
      }
      let inFlight = 0;
      let maxInFlight = 0;
      const rawGet = slow.get.bind(slow);
      slow.get = async (key) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await rawGet(key);
        } finally {
          inFlight -= 1;
        }
      };
      const waved = await syncIndex(new R2Store(slow), { budget: createSearchBudget(200) });
      check(
        "stale notes are fetched concurrently, so a large budget converges in seconds not minutes",
        waved.pending === 0 && waved.index.docs.size === 30 && maxInFlight > 1
      );
    }

    // -- an oversized index is refused unparsed, and rebuilt slim ------------
    //
    // The 128MB memory limit is the ceiling no plan raises, and JSON.parse of
    // a many-MB index inflates several-fold in the heap. Measured live: chat
    // archives indexed whole grew the index until parsing it killed every
    // invocation, uncatchably — search down because of its own accelerator,
    // with no surviving pass to shrink the object. The byte cap breaks the
    // cycle: valid-but-huge is treated exactly like corrupt.
    {
      const bloated = createBucket();
      bloated.seed("privacy.md", PRIVACY_MANIFEST);
      bloated.seed("1-projects/small.md", "# Small\n\nA PANGOLIN appears early.\n");
      // The oversized object is a VALID index whose one doc entry carries the
      // real note's real etag, padded past the byte cap. If the sync parses it
      // anyway, the entry is fresh (etag matches the listing) and survives with
      // its bloated title; if the cap refuses to parse, the note is re-indexed
      // from its content and gets its real title. The first version of this
      // check asserted on a doc the listing did not contain, which the removal
      // pass deleted either way — the sabotage returned zero failures, so the
      // check was measuring nothing.
      const realEtag = bloated.objects.get("1-projects/small.md").etag;
      bloated.seed(
        SEARCH_INDEX_KEY,
        JSON.stringify({
          version: 1,
          generatedAt: new Date().toISOString(),
          docs: [["1-projects/small.md", { etag: realEtag, uploaded: null, title: "x".repeat(12_000_001), links: [], len: { title: 1, headings: 0, tags: 0, body: 0 }, rank: 0 }]],
          terms: [],
        })
      );
      const rebuilt = await syncIndex(new R2Store(bloated), { budget: createSearchBudget(200) });
      const slim = bloated.objects.get(SEARCH_INDEX_KEY);
      check(
        "a valid but oversized index is refused unparsed and rebuilt slim from the notes",
        rebuilt.index.docs.get("1-projects/small.md")?.title === "Small" &&
          slim.body.length < 100_000
      );
    }

    // -- and nothing is ever *written* that the same cap would refuse -------
    //
    // The cap above was read-side only and the write had none, so the loop
    // stored objects it already knew it would reject: grow, refuse, rebuild
    // from empty, grow again, forever. A workspace whose capped index crosses the
    // ceiling never converges, and — worse — a *converged* index (`pending: 0`)
    // is reachable, written, and thrown away on the next pass. Refusing the
    // write instead makes coverage plateau: the last object small enough to
    // read survives, and the query in hand is still answered from the full
    // in-memory index it built. Partial and stable beats complete and
    // unreachable.
    //
    // The cap is injected here rather than faked, so one number governs both
    // directions in the test exactly as one parameter governs both in the
    // module. Building twelve real megabytes of index would take thousands of
    // notes and minutes of wall clock.
    {
      const grow = createBucket();
      grow.seed("privacy.md", PRIVACY_MANIFEST);
      const seedNotes = (from, to) => {
        for (let n = from; n < to; n += 1) {
          grow.seed(
            `1-projects/grow/note-${String(n).padStart(3, "0")}.md`,
            `# Grow ${n}\n\nunique${n} vocabulary${n} marker${n} shared filler text\n`
          );
        }
      };
      const growStore = new R2Store(grow);

      seedNotes(0, 4);
      await syncIndex(growStore, { budget: createSearchBudget(300) });
      const stored = () => grow.objects.get(SEARCH_INDEX_KEY);
      const smallBytes = new TextEncoder().encode(stored().body).byteLength;
      // "Was it replaced" is an identity question, not a byte comparison. The
      // stub mints a fresh etag per put, and a rebuild of the same four notes
      // differs from the original only in `generatedAt` — a millisecond apart
      // or not at all depending on the clock, which is a flaky test either way.
      let smallEtag = stored().etag;

      // One number, both directions. A converged index costs no note reads; the
      // same index under a cap it already exceeds costs four, because it is
      // refused unparsed and every note looks stale. A read that consulted the
      // module constant while the write consulted the parameter would show zero
      // here — two caps that can disagree is the state the single parameter
      // exists to remove.
      grow.resetCounts();
      await syncIndex(growStore, { budget: createSearchBudget(300) });
      const idleGets = grow.counts.noteGets.length;
      grow.resetCounts();
      await syncIndex(growStore, { budget: createSearchBudget(300), byteCap: smallBytes - 1 });
      check(
        "one cap governs both directions: a stored index past it is refused on read as well",
        idleGets === 0 && grow.counts.noteGets.length === 4
      );

      // The boundary itself, in both directions at once. A cap set to exactly
      // the index's size must WRITE it — the read accepts `<=`, so anything
      // stricter on the write is the two-caps-disagree loop, one byte wide —
      // and the object it wrote must then parse, which is the same claim from
      // the other side. It is also the fixture that pins the *measurement*: a
      // rule of `length * 3 > cap` — strictly conservative, never wrong about
      // an overflow, and silently pinning a Latin-script bucket at a third of
      // the real ceiling — is refused by nothing else in this block, because
      // every other body here sits well under a third of its cap or far over
      // it.
      grow.remove(SEARCH_INDEX_KEY);
      // One variable, and the check asserts the cap *is* the body's size rather
      // than that the body is `smallBytes` — which is a fact about the body and
      // true at any cap above it. Giving this a byte of headroom to look less
      // brittle is the obvious edit, and it walks the strict-read mutation
      // straight through; written this way the headroom fails the check itself.
      const boundaryCap = smallBytes;
      await syncIndex(growStore, { budget: createSearchBudget(300), byteCap: boundaryCap });
      const atCap = stored();
      grow.resetCounts();
      const reread = await syncIndex(growStore, { budget: createSearchBudget(300), byteCap: boundaryCap });
      check(
        "an index exactly at the cap is written, and reads back — the boundary is one boundary",
        atCap !== undefined &&
          new TextEncoder().encode(atCap.body).byteLength === boundaryCap &&
          grow.counts.noteGets.length === 0 &&
          reread.index.docs.size === 4
      );

      // A default parameter fires on `undefined` alone, so an explicit `null`
      // or a non-number is not the default — it is `length > null`, true for
      // every non-empty body, and the index is never persisted again.
      grow.remove(SEARCH_INDEX_KEY);
      await syncIndex(growStore, { budget: createSearchBudget(300), byteCap: null });
      check(
        "a byteCap that is not a finite number falls back to the module's own, rather than refusing everything",
        stored() !== undefined
      );
      // The other half of the same comment, and the one a tidy-up actually
      // reaches: `??` and `== null` both look like the modern spelling of this
      // default and both let `NaN` through, where every comparison is false —
      // the write always allowed and the read always refusing. It is the read
      // half that is observable, so a converged bucket is re-synced and its
      // note reads counted.
      grow.resetCounts();
      await syncIndex(growStore, { budget: createSearchBudget(300), byteCap: Number.NaN });
      check(
        "and a NaN cap does not silently become 'write anything, parse nothing'",
        grow.counts.noteGets.length === 0 && stored() !== undefined
      );

      // The two probes above deliberately replaced the stored object, so the
      // baseline for "was it replaced" is re-taken rather than assumed.
      smallEtag = stored().etag;

      // Well past three times the small index, so a write cap that drifted to
      // its own larger number is caught rather than accommodated.
      seedNotes(4, 60);
      const overBudget = createSearchBudget(300);
      const overCap = { budget: overBudget, byteCap: smallBytes + 200 };
      const capped = await syncIndex(growStore, overCap);
      check(
        "an index that would cross the cap is not written, so the last readable one survives",
        stored()?.etag === smallEtag
      );
      check(
        "and the query that triggered the sync is still answered from what it built",
        capped.index.docs.size === 60
      );
      // The refusal returns through the same `finish()` as the ordinary path,
      // and until this check nothing in the file read any of its three numbers.
      // A second return literal there — the cheap shape to expect, since the
      // early return is right beside them — would be a caller told the index is
      // complete by a pass that persisted nothing. `spent` is read off the
      // caller's own budget object rather than a constant — which pins it
      // against a hardcoded number but *not* against a second literal that
      // still writes `spent: ops.spent`, since that coincides exactly. The two
      // checks below are what hold the other two fields.
      check(
        "the refusal reports the live budget rather than a number of its own",
        capped.spent === overBudget.spent && capped.spent > 0
      );
      {
        // The discriminating half: a converged fixture cannot tell `pending`
        // from a hardcoded `0`, so the refusal is also driven on a pass that
        // ran out of budget, where the two differ.
        const short = await syncIndex(growStore, {
          budget: createSearchBudget(20),
          byteCap: smallBytes + 200,
        });
        check(
          "and a refusal on a pass that ran out of budget still says what it did not reach",
          short.pending > 0 && short.index.docs.size < 60 && stored()?.etag === smallEtag
        );
      }
      {
        // `listingTruncated` is the third field of that return and the one no
        // fixture above drives away from its default, because a bucket small
        // enough to over-run the byte cap is normally listed to the end. This
        // one is shaped to do both at once: a budget that finishes the root
        // listing and runs out inside the folders, and a cap nothing fits
        // under. All three numbers are then non-default on a refused write.
        const wide = createBucket();
        wide.seed("privacy.md", PRIVACY_MANIFEST);
        wide.seed("root-a.md", "# A\n\nalpha marker\n");
        wide.seed("root-b.md", "# B\n\nbeta marker\n");
        for (let folder = 0; folder < 6; folder += 1) {
          for (let n = 0; n < 3; n += 1) {
            wide.seed(`f${folder}/n${n}.md`, `# F${folder}N${n}\n\nword${folder}${n}\n`);
          }
        }
        const wideStore = new R2Store(wide);
        const cut = await syncIndex(wideStore, { budget: createSearchBudget(6), byteCap: 50 });
        // The control: the same pass with the ordinary cap writes, so the
        // refusal below is the cap's doing and not the budget's.
        const loose = createBucket();
        loose.seed("privacy.md", PRIVACY_MANIFEST);
        for (const [key, object] of wide.objects) if (key !== "privacy.md") loose.seed(key, object.body);
        const wrote = await syncIndex(new R2Store(loose), { budget: createSearchBudget(6) });
        check(
          "a refused pass charges no subrequest for the write it did not make",
          cut.spent === wide.ops
        );
        check(
          "a refused write on a truncated listing still reports the truncation, not a literal false",
          cut.listingTruncated === true &&
            cut.pending > 0 &&
            cut.index.docs.size > 0 &&
            wide.objects.get(SEARCH_INDEX_KEY) === undefined &&
            wrote.listingTruncated === true &&
            loose.objects.get(SEARCH_INDEX_KEY) !== undefined
        );
      }
      const again = await syncIndex(growStore, { ...overCap, budget: createSearchBudget(300) });
      check(
        "a second pass under the same cap plateaus rather than cycling through a rebuild",
        stored()?.etag === smallEtag && again.index.docs.size === 60
      );

      // Bytes, not characters. The read compares `bytes.byteLength`, so a
      // write measured in UTF-16 code units lets a CJK index through at up to
      // three times the cap — stored once and refused on every read after,
      // which is the same defect wearing a different alphabet.
      const wide = createBucket();
      wide.seed("privacy.md", PRIVACY_MANIFEST);
      for (let n = 0; n < 8; n += 1) {
        wide.seed(`1-projects/wide/note-${n}.md`, `# ${"見出しの日本語".repeat(120)}${n}\n\nwide body ${n}\n`);
      }
      const wideStore = new R2Store(wide);
      await syncIndex(wideStore, { budget: createSearchBudget(300) });
      const wideBody = wide.objects.get(SEARCH_INDEX_KEY).body;
      const wideChars = wideBody.length;
      const wideBytes = new TextEncoder().encode(wideBody).byteLength;
      wide.remove(SEARCH_INDEX_KEY);
      // One byte under the real size: refused when measured in bytes, accepted
      // by every cheaper stand-in. The fixture is CJK-dominant on purpose, so
      // the cap also sits above *twice* the character count — that is what
      // pins the helper's fast-accept bound at UTF-8's real worst case of
      // three bytes per UTF-16 unit. Assume two and this body is waved through
      // unmeasured.
      const wideCap = wideBytes - 1;
      await syncIndex(wideStore, { budget: createSearchBudget(300), byteCap: wideCap });
      check(
        "the write cap is counted in bytes, so a multibyte index is refused rather than stored unreadable",
        wideChars * 2 <= wideCap && wideCap < wideBytes && wide.objects.get(SEARCH_INDEX_KEY) === undefined
      );
    }

}
