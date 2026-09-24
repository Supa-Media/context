/**
 * Placement (the hash) and the two on-bucket formats (manifest, docmap and
 * shard — the v1 legacy shape and the v2 sharded one). See
 * searchShards.test.mjs for the module overview and the sabotage-testing
 * record.
 */

import {
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  MANIFEST_PARSE_BYTE_CAP,
  NOTE_INDEX_CHAR_CAP,
  SHARD_PARSE_BYTE_CAP,
  addDoc,
  buildTermFilter,
  bytesOf,
  chooseShardCount,
  emptyManifest,
  emptyShard,
  fnv1a32,
  parseDocmap,
  parseManifest,
  parseShard,
  referenceFnv1a32,
  serializeDocmap,
  serializeManifest,
  serializeShard,
  shardKey,
  shardOf,
} from "./fixtures.mjs";

export async function runSearchShardsPlacementAndFormatsChecks(check) {
  // -- placement: the hash ------------------------------------------------

  check(
    "fnv1a32 answers the published FNV-1a 32-bit vectors",
    fnv1a32("") === 0x811c9dc5 && fnv1a32("a") === 0xe40c292c && fnv1a32("foobar") === 0xbf9cf968
  );

  {
    // The vectors above are ASCII, where hashing UTF-16 code units and hashing
    // UTF-8 bytes agree — so they cannot tell the two apart, and the divergence
    // that matters is a Japanese or emoji note path. A seeded corpus of astral
    // pairs and lone surrogates against `TextEncoder` is what pins the fold.
    let seed = 0x1a2b3c4d;
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    let cases = 0;
    let bad = 0;
    let sawAstral = 0;
    let sawLoneSurrogate = 0;
    let sawMultibyte = 0;
    for (let trial = 0; trial < 2000; trial += 1) {
      let value = "";
      const length = 1 + (next() % 20);
      for (let i = 0; i < length; i += 1) {
        const roll = next() % 100;
        if (roll < 40) value += String.fromCharCode(next() % 0x80);
        else if (roll < 60) value += String.fromCharCode(0x80 + (next() % 0x780));
        else if (roll < 80) value += String.fromCharCode(0x800 + (next() % 0xd000));
        else if (roll < 92) value += String.fromCodePoint(0x10000 + (next() % 0xfffff));
        else value += String.fromCharCode(0xd800 + (next() % 0x800));
      }
      if (/[\u{10000}-\u{10ffff}]/u.test(value)) sawAstral += 1;
      if (/(?:[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff])/.test(value)) {
        sawLoneSurrogate += 1;
      }
      if (/[^\u0000-\u007f]/.test(value)) sawMultibyte += 1;
      cases += 1;
      if (fnv1a32(value) !== referenceFnv1a32(value)) bad += 1;
    }
    check(
      "and it folds to UTF-8 exactly as TextEncoder does, over astral pairs and unpaired surrogates",
      cases === 2000 && bad === 0 && sawAstral > 500 && sawLoneSurrogate > 500 && sawMultibyte > 1500
    );
  }

  {
    const folders = ["1-projects", "2-areas", "3-resources/reading", "0-inbox"];
    const paths = Array.from(
      { length: 1000 },
      (_, i) => `${folders[i % folders.length]}/meeting-${i}-notes.md`
    );
    const occupancy = new Array(8).fill(0);
    let inRange = true;
    let stable = true;
    for (const path of paths) {
      const id = shardOf(path, 8);
      if (!Number.isInteger(id) || id < 0 || id >= 8) inRange = false;
      if (shardOf(path, 8) !== id) stable = false;
      occupancy[id] += 1;
    }
    check(
      "shardOf is deterministic, in range, and leaves no shard empty over a thousand paths",
      inRange && stable && occupancy.every((n) => n > 0)
    );
    // Found while writing the check above, and worth pinning rather than
    // forgetting: `% 2^k` takes FNV-1a's *low* bits, and its low bit is
    // nothing but the parity of every byte xored together. A corpus whose
    // paths are byte-parity-paired — `topic-<i>/note-<i>.md`, the same digits
    // twice — therefore has a constant low bit and uses half the shards. It is
    // a balance defect, never a correctness one (placement stays a function of
    // the path, which is all the format needs), and it is the reason the
    // fixture above is ordinary note paths rather than a generated pair.
    const paired = new Set(
      Array.from({ length: 200 }, (_, i) => shardOf(`1-projects/topic-${i}/note-${i}.md`, 8))
    );
    check(
      "and a parity-paired corpus is known to use only half of a power-of-two shard count",
      paired.size === 4 && [...paired].every((id) => id % 2 === 1)
    );
  }

  check(
    "chooseShardCount is clamp(ceil(n/300), 1, 64) at both ends and at the step",
    chooseShardCount(0) === 1 &&
      chooseShardCount(1) === 1 &&
      chooseShardCount(300) === 1 &&
      chooseShardCount(301) === 2 &&
      chooseShardCount(600) === 2 &&
      chooseShardCount(1e9) === 64 &&
      chooseShardCount(Number.NaN) === 1 &&
      chooseShardCount(-5) === 1
  );

  /*
    ...and the volume term, which is the whole of the mailbox fix. The two
    terms take the max, and the calibration is what makes that safe: an
    ordinary note is worth at most `NOTE_INDEX_CHAR_CAP` and a shard is aimed
    at `300 * NOTE_INDEX_CHAR_CAP`, so over ordinary notes the volume term can
    never win and no existing index moves. A bundled note is worth its bytes,
    which is how one listed object can now ask for more than one shard.
  */
  const PER_SHARD = 300 * NOTE_INDEX_CHAR_CAP;
  check(
    "an ordinary vault is never sized up by its volume: the note term always wins",
    [1, 7, 42, 300, 301, 5000].every(
      (n) => chooseShardCount(n, n * NOTE_INDEX_CHAR_CAP) === chooseShardCount(n)
    )
  );
  check(
    "volume alone buys shards, which counting two notes never could",
    chooseShardCount(2, PER_SHARD) === 1 &&
      chooseShardCount(2, PER_SHARD + 1) === 2 &&
      chooseShardCount(2, 8 * PER_SHARD) === 8
  );
  check(
    "...clamped at MAX_SHARD_COUNT and floored at one, exactly like the note term",
    chooseShardCount(2, 1e12) === 64 &&
      chooseShardCount(0, 0) === 1 &&
      chooseShardCount(1, Number.NaN) === 1 &&
      chooseShardCount(1, -7) === 1
  );
  check(
    "a volume-per-shard of nothing falls back to the pinned one rather than dividing by zero",
    chooseShardCount(1, PER_SHARD * 4, 0) === 4 &&
      chooseShardCount(1, PER_SHARD * 4, Number.NaN) === 4
  );

  check(
    "shardKey is the zero-padded decimal name the contract pins",
    shardKey(0) === ".context/search/v2/shard-000.json" &&
      shardKey(7) === ".context/search/v2/shard-007.json" &&
      shardKey(63) === ".context/search/v2/shard-063.json" &&
      MANIFEST_KEY === ".context/search/v2/manifest.json" &&
      LEGACY_V1_KEY === ".context/search/search-v1.json"
  );

  // -- the two formats ----------------------------------------------------

  {
    const manifest = emptyManifest(3);
    manifest.docsByShard[0].set("__proto__", "e1");
    manifest.docsByShard[0].set("1-projects/plan.md", "e2");
    manifest.docsByShard[2].set("constructor", "e3");
    manifest.stats[0] = { docCount: 2, lenTotals: { title: 4, headings: 2, tags: 1, body: 90 } };
    manifest.filters[0] = buildTermFilter(["plan", "shipping"]);
    manifest.freshness = { listedAt: "2026-09-01T00:00:00.000Z", pending: 4, truncated: true };
    // Two objects, one round trip each: the manifest is what a query reads and
    // the docmap is the diff only maintenance needs. They are parsed back
    // together here because every property below belongs to the index as a
    // whole, and the split is a storage decision rather than a semantic one.
    const round = parseManifest(serializeManifest(manifest));
    round.docsByShard = parseDocmap(serializeDocmap(manifest), 3);
    check(
      "a manifest round trips through serialize/parse with its docs, versions and stats intact",
      round !== null &&
        round.shardCount === 3 &&
        round.docsByShard.length === 3 &&
        round.docsByShard[0].get("1-projects/plan.md") === "e2" &&
        round.docsByShard[2].get("constructor") === "e3" &&
        round.stats[0].docCount === 2 &&
        round.stats[0].lenTotals.body === 90 &&
        typeof round.generatedAt === "string"
    );
    check(
      "and it carries the two things a query cannot ask a listing for",
      round.filters[0] === manifest.filters[0] &&
        round.filters[1] === null &&
        round.freshness.listedAt === "2026-09-01T00:00:00.000Z" &&
        round.freshness.pending === 4 &&
        round.freshness.truncated === true
    );
    check(
      "a docmap for MORE shards than the manifest is refused, never applied to this index",
      parseDocmap(serializeDocmap(manifest), 2) === null &&
        parseDocmap(serializeDocmap(manifest), 3) !== null
    );
    {
      /*
        ...and one for FEWER is padded rather than refused, because the count
        can now grow and the two objects are written in separate steps: the
        manifest first, the docmap only if an op is left for it. Refusing a
        docmap one shard behind would re-index the whole bucket to learn what
        it already knew — and rebuild shards from empty while it did, so an
        index that was answering goes dark. Growth moves nothing, so every
        claim in the shorter docmap is still true and the shards it does not
        name are the new empty ones.
      */
      const grown = parseDocmap(serializeDocmap(manifest), 5);
      check(
        "a docmap for FEWER shards is padded with empty ones, since growth moves no doc",
        grown !== null &&
          grown.length === 5 &&
          grown[0].get("__proto__") === "e1" &&
          grown[3].size === 0 &&
          grown[4].size === 0
      );
      check(
        "...and a shardCount that is not a positive integer is still refused",
        parseDocmap(JSON.stringify({ version: 3, shardCount: 0, docsByShard: [] }), 3) === null &&
          parseDocmap(
            JSON.stringify({ version: 3, shardCount: 1.5, docsByShard: [[]] }),
            3
          ) === null &&
          parseDocmap(
            JSON.stringify({ version: 3, shardCount: "1", docsByShard: [[]] }),
            3
          ) === null
      );
    }
    check(
      "and a note path of \"__proto__\" is a Map key, never a property name",
      round.docsByShard[0].get("__proto__") === "e1" &&
        Object.getPrototypeOf(round.docsByShard[0]) === Map.prototype &&
        ({}).e1 === undefined &&
        Object.prototype.e1 === undefined
    );
  }

  {
    const shard = emptyShard();
    addDoc(shard, "__proto__", {
      etag: "e1",
      uploaded: null,
      content: "# constructor\n\nprototype pollution __proto__ text\n",
    });
    addDoc(shard, "1-projects/real.md", {
      etag: "e2",
      uploaded: "2026-01-01T00:00:00.000Z",
      content: "# Real\n\nOrdinary body words.\n",
    });
    const body = serializeShard(shard);
    const stored = JSON.parse(body);
    const round = parseShard(body);
    check(
      "a shard round trips with its docs and postings, in-memory version 2 and all",
      round !== null &&
        round.version === 2 &&
        round.docs.size === 2 &&
        round.docs.get("1-projects/real.md").uploaded === "2026-01-01T00:00:00.000Z" &&
        round.terms.get("ordinary")?.get("1-projects/real.md")?.length === 4
    );
    check(
      "and the stored form is version 3 with postings interned as doc indexes, never path strings",
      stored.version === 3 &&
        stored.terms.length > 0 &&
        stored.terms.every(([, postings]) => postings.every(([key]) => Number.isInteger(key)))
    );
    check(
      "and neither a \"__proto__\" path nor a \"constructor\" term reaches Object.prototype",
      round.docs.has("__proto__") &&
        round.terms.has("constructor") &&
        ({}).etag === undefined &&
        Object.prototype.etag === undefined &&
        Object.getPrototypeOf({}) === Object.prototype
    );
  }

  {
    // The version-2 stored dialect: postings keyed by the full path string.
    // Earlier deployments wrote this, so a bucket holds such shards today, and
    // refusing them would rebuild a working index for no gain. This literal IS
    // the fixture — generating it from current code would test nothing.
    const legacy = JSON.stringify({
      version: 2,
      generatedAt: "2026-08-01T00:00:00.000Z",
      docs: [
        ["1-projects/real.md", { etag: "e2", uploaded: null, title: "Real", links: [], len: { title: 1, headings: 0, tags: 0, body: 3 }, rank: 1 }],
      ],
      terms: [["ordinary", [["1-projects/real.md", [0, 0, 0, 1]]]]],
    });
    const round = parseShard(legacy);
    check(
      "a version-2 stored shard — path-keyed postings, what earlier deployments wrote — still parses",
      round !== null &&
        round.docs.get("1-projects/real.md")?.etag === "e2" &&
        round.terms.get("ordinary")?.get("1-projects/real.md")?.[3] === 1
    );
  }

  {
    // The reason version 3 exists, pinned as a measurement: path-keyed
    // postings repeat every doc's path once per unique term, so a shard of
    // real notes under long paths crossed SHARD_PARSE_BYTE_CAP at about half
    // of NOTES_PER_SHARD and its write was refused on every pass — the live
    // workspace's permanent "still catching up". The legacy body is built from the
    // same in-memory shard by the fixture rule above, and interning must beat
    // it by at least 2x on this corpus or the plateau is back.
    const shard = emptyShard();
    for (let n = 0; n < 40; n += 1) {
      const words = Array.from({ length: 60 }, (_, w) => `word${(n * 7 + w * 13) % 240}`).join(" ");
      addDoc(shard, `2-areas/communications/2026-08-${String((n % 28) + 1).padStart(2, "0")}-subject-line-${n}.md`, {
        etag: `e${n}`,
        uploaded: null,
        content: `# Subject line ${n}\n\n${words}\n`,
      });
    }
    const interned = serializeShard(shard);
    const parsed = JSON.parse(interned);
    const pathOf = parsed.docs.map(([path]) => path);
    const legacyBody = JSON.stringify({
      version: 2,
      generatedAt: parsed.generatedAt,
      docs: parsed.docs,
      terms: parsed.terms.map(([term, postings]) => [
        term,
        postings.map(([idx, tf]) => [pathOf[idx], tf]),
      ]),
    });
    const legacyRound = parseShard(legacyBody);
    check(
      "interned postings serialize the same shard to less than half the path-keyed bytes",
      bytesOf(interned) * 2 < bytesOf(legacyBody) &&
        legacyRound !== null &&
        legacyRound.docs.size === shard.docs.size
    );
  }

  check(
    "parseManifest refuses everything it cannot fully validate, rather than half-reading it",
    parseManifest("not json at all") === null &&
      parseManifest(JSON.stringify({ version: 1, shardCount: 1, generatedAt: null, docsByShard: [[]], stats: [{ docCount: 0, lenTotals: { title: 0, headings: 0, tags: 0, body: 0 } }] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 2, generatedAt: null, docsByShard: [[]], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 0, generatedAt: null, docsByShard: [], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 65, generatedAt: null, docsByShard: [], stats: [] })) === null &&
      parseManifest(JSON.stringify({ version: 2, shardCount: 1, generatedAt: null, docsByShard: [[["p", 7]]], stats: [{ docCount: 0, lenTotals: { title: 0, headings: 0, tags: 0, body: 0 } }] })) === null &&
      parseManifest(null) === null
  );

  check(
    "parseShard refuses a wrong version, a malformed posting, and anything that is not a string",
    parseShard("{ truncated") === null &&
      parseShard(JSON.stringify({ version: 1, docs: [], terms: [] })) === null &&
      parseShard(JSON.stringify({ version: 4, docs: [], terms: [] })) === null &&
      parseShard(JSON.stringify({ version: 2, docs: [], terms: [["t", [["p", [1, 2, 3]]]]] })) === null &&
      parseShard(JSON.stringify({ version: 2, docs: [["p", { etag: "e", uploaded: null, title: "t", links: [], len: { title: 0, headings: 0, tags: 0 }, rank: 0 }]], terms: [] })) === null &&
      parseShard(undefined) === null
  );

  {
    /*
      The two fields shedding added, in both directions.

      A manifest written before shedding existed carries no `shed` in its
      stats and a shard written then carries no `shed` on its docs, and both
      must read back as "nothing is shed" rather than being refused —
      refusing would rebuild every working index on the day this deploys. In
      the other direction an older gateway reads the new objects: it validates
      only the fields it knows, so the extra keys ride along. What is NOT
      tolerated is a present-but-malformed value, which would parse as
      `undefined` and be reported as zero — the one direction this number must
      not be wrong in.
    */
    const statsOf = (extra) => [{ docCount: 1, lenTotals: { title: 1, headings: 0, tags: 0, body: 1 }, ...extra }];
    const manifestWith = (extra) =>
      JSON.stringify({ version: 3, shardCount: 1, generatedAt: null, stats: statsOf(extra) });
    check(
      "a manifest with no shed count reads as none, one with a count reads it, a malformed one is refused",
      parseManifest(manifestWith({}))?.stats[0].shed === 0 &&
        parseManifest(manifestWith({ shed: 3 }))?.stats[0].shed === 3 &&
        parseManifest(manifestWith({ shed: "3" })) === null &&
        parseManifest(manifestWith({ shed: -1 })) === null
    );

    const shedDoc = (extra) => [
      "0-inbox/email/name-at-example-com/2026-09-07.md#msg-0123456789abcdef",
      {
        etag: "e",
        uploaded: null,
        title: "Subject",
        links: [],
        len: { title: 1, headings: 0, tags: 0, body: 1 },
        rank: 1,
        notePath: "0-inbox/email/name-at-example-com/2026-09-07.md",
        anchor: "msg-0123456789abcdef",
        ...extra,
      },
    ];
    const shardWith = (extra) =>
      JSON.stringify({ version: 3, generatedAt: null, docs: [shedDoc(extra)], terms: [] });
    const key = "0-inbox/email/name-at-example-com/2026-09-07.md#msg-0123456789abcdef";
    check(
      "a doc with no shed flag reads as whole, one flagged reads as shed, a malformed flag refuses the shard",
      parseShard(shardWith({}))?.docs.get(key)?.shed === false &&
        parseShard(shardWith({ shed: true }))?.docs.get(key)?.shed === true &&
        parseShard(shardWith({ shed: "yes" })) === null
    );
    check(
      "...and the flag round-trips, while an unshed doc does not carry the key at all",
      JSON.parse(serializeShard(parseShard(shardWith({ shed: true })))).docs[0][1].shed === true &&
        JSON.parse(serializeShard(parseShard(shardWith({})))).docs[0][1].shed === undefined
    );
  }

  {
    // The interned dialect's own refusals: each key must be an integer index
    // into this shard's docs array. Anything else names no doc, and the two
    // dialects must not blur — a path string inside a version-3 posting is a
    // shape violation, not a fallback.
    const doc = ["1-projects/real.md", { etag: "e", uploaded: null, title: "Real", links: [], len: { title: 1, headings: 0, tags: 0, body: 1 }, rank: 1 }];
    const v3With = (key) =>
      JSON.stringify({ version: 3, generatedAt: null, docs: [doc], terms: [["real", [[key, [1, 0, 0, 0]]]]] });
    check(
      "a version-3 posting index outside the docs array, fractional, or a path string refuses the shard whole",
      parseShard(v3With(0)) !== null &&
        parseShard(v3With(1)) === null &&
        parseShard(v3With(-1)) === null &&
        parseShard(v3With(0.5)) === null &&
        parseShard(v3With("1-projects/real.md")) === null
    );
  }

  {
    // Oversized is refused **unparsed**, which is the half that protects the
    // 128MB heap: an object big enough to kill the invocation kills it before
    // any pass can shrink it. Driven at a small injected cap, because building
    // two real megabytes of shard here would cost more than it proves — and
    // then once at the real constant, so the default is what it says it is.
    const shard = emptyShard();
    addDoc(shard, "1-projects/a.md", { etag: "e1", uploaded: null, content: "# A\n\nbody words\n" });
    const body = serializeShard(shard);
    check(
      "a shard or manifest over its byte cap is refused unparsed, at the injected cap and at the real one",
      parseShard(body) !== null &&
        parseShard(body, bytesOf(body) - 1) === null &&
        parseShard(body, bytesOf(body)) !== null &&
        parseShard(`${" ".repeat(SHARD_PARSE_BYTE_CAP)}{}`) === null &&
        parseManifest(`${" ".repeat(MANIFEST_PARSE_BYTE_CAP)}{}`) === null
    );
  }

}
