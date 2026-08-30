/**
 * The sharded index (v2) wired into the gateway — `searchVisibleNotes` in
 * `src/index.js` answering from `.index/v2/` through a real worker request.
 *
 * `searchShards.test.mjs` and `searchShardQuery.test.mjs` hold the two halves
 * on their own: the storage half against an instrumented bucket, the query
 * half as pure functions over fixtures. Neither can see the thing this file is
 * for, which is what happens when the gateway wires them together — the
 * budget shared between a sync and a shard walk, the visibility predicate
 * handed to the collector, and the floor language a caller actually reads.
 *
 * Why v2 at all, in one measurement: v1 is a single object that must be parsed
 * whole, so `INDEX_PARSE_BYTE_CAP` bounds it, and a brain whose capped index
 * crosses that bound plateaus at partial coverage **forever** — the write is
 * refused, the last readable object survives, and no number of passes ever
 * covers the rest. That is not an abstraction: block (c) below builds a bucket
 * whose v1 index genuinely cannot converge under a cap, then converges the
 * same bucket under v2 with the same cap per shard.
 *
 * Four properties here are not visible in any output text, so this file stands
 * up its own instrumented bucket and counts store calls by key:
 *
 * 1. **The first search creates the index and the last one re-uses it.** A
 *    manifest, its shard objects, and a second search that reads note bodies
 *    only for the hits it returns.
 * 2. **The privacy line survives the shard boundary.** The shards hold text
 *    drawn from private notes — fine inside the customer's own bucket, never
 *    fine in what leaves the gateway — so a team-scope search over a term
 *    appearing in both team notes and a private one surfaces the team paths,
 *    no private byte, and a count of exactly what it listed. Both tool dialects, because
 *    `search_notes` and the ChatGPT-dialect `search` share one path and a
 *    second path would be a second place for a visibility bug.
 * 3. **A shard the answer could not open is said out loud.** `loadShard`
 *    answers `null` for a budget refusal and for an absent object alike, so
 *    the gateway checks the budget *before* asking. Treating a refusal as an
 *    empty shard is silently answering a query from part of the corpus.
 * 4. **v1's object is deleted, once, on the pass that first writes a
 *    manifest.** Dead weight in a customer's bucket is still their bucket.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/index.js` and reverted; counts are
 * across the whole suite, as measured against the final fixtures.
 *
 * 1. **The visibility predicate dropped from the collector call**
 *    (`collectShardCandidates(shard, queryTerms, () => true)`). 2 checks
 *    failed, both in `searchIntegration.test.mjs`, and both on the *inference*
 *    line: a private note appearing changed a team connection's own answer,
 *    and private notes reordered the visible ones. That is the finding, and it
 *    is the reverse of the v1 record's first entry — every *content* check
 *    stayed green, because `rankedVisibleTo` at the output caught every
 *    private path before it was printed or counted. The two guards are not one
 *    guard with a spare here: the collector is what keeps private docs out of
 *    `N`, `df` and `avglen`, which no output filter can undo, and the filter is
 *    what keeps a private path out of the answer when the collector is wrong.
 *    Neither of them alone is the privacy line.
 * 2. **A budget-refused shard read treated as an empty shard** (the
 *    `budget.remaining` pre-check deleted and a `null` read as "this shard
 *    holds nothing"). 1 check failed, the starved-budget floor below — which
 *    is the check written for it, because every other fixture here has budget
 *    to spare and cannot tell a refusal from an absence.
 * 3. **`rankedVisibleTo` skipped** on the v2 path. 1 check failed, and it is
 *    not a privacy check: it is `searchIntegration.test.mjs`'s prefix filter,
 *    because that function applies `prefix` as well as the predicate. The
 *    *visibility* half fails zero end to end, exactly as CONTRACT.md says it
 *    must ("redundant … by construction and kept anyway: it is the half that
 *    does not depend on `visibleIndex` being correct") — the collector has
 *    already narrowed every shard to visible docs by the time it runs. It is
 *    held where a redundant guard can be held: `searchQuery.test.mjs` drives
 *    `rankedVisibleTo` directly with a list nothing narrowed first, and
 *    `searchShardQuery.test.mjs` holds the collector's own predicate. Sabotage
 *    1 above is what it is *for*, and is why it is not deleted for being
 *    unreachable.
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { SEARCH_INDEX_KEY, createSearchBudget, syncIndex } from "../src/search/maintain.js";
import { parseIndex } from "../src/search/indexer.js";
import {
  LEGACY_V1_KEY,
  MANIFEST_KEY,
  emptyManifest,
  parseManifest,
  parseShard,
  serializeManifest,
  shardKey,
  syncShardedIndex,
} from "../src/search/shards.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

/** Mirrors `SEARCH_SUBREQUEST_BUDGET` / `SEARCH_RESULT_LIMIT` in src/index.js. */
const SEARCH_SUBREQUEST_BUDGET = 40;
const SEARCH_RESULT_LIMIT = 10;
/** Every tool call reads `privacy.md` before it dispatches; not the search's to spend. */
const PRIVACY_MANIFEST_READ = 1;
/** Cloudflare's per-invocation ceiling on the free tier — the real limit. */
const SUBREQUEST_LIMIT = 50;

const MAIN_OWNER_TOKEN = `cat_searchv2_owner_${"0".repeat(17)}`;
const MAIN_TEAM_TOKEN = `cat_searchv2_member_${"0".repeat(16)}`;
const WIDE_TOKEN = `cat_searchv2_wide_${"0".repeat(18)}`;
const SPREAD_TOKEN = `cat_searchv2_spread_${"0".repeat(16)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  1-projects/vault: private\n" +
  "  2-areas: team\n  3-resources: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object as R2 and S3 both do, and counts every call.
 *
 * A local copy of the pattern in `searchIntegration.test.mjs` rather than an
 * import of it: a fixture shared between two files is a fixture neither file
 * can change, and this one counts deletes, which that one does not.
 */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, delete: 0, puts: [], deletes: [], noteGets: [], getKeys: [] };
  const failGetKeys = new Set();

  const api = {
    objects,
    counts,
    failGetKeys,
    listEtags: true,
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.puts = [];
      counts.deletes = [];
      counts.noteGets = [];
      counts.getKeys = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.put + counts.list + counts.delete;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      counts.getKeys.push(key);
      if (key.endsWith(".md") && key !== "privacy.md") counts.noteGets.push(key);
      if (failGetKeys.has(key)) throw new Error("storage backend refused the read");
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      counts.puts.push(key);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      counts.deletes.push(key);
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({
            key,
            size: stored.body.length,
            uploaded: stored.uploaded,
            ...(api.listEtags ? { etag: stored.etag } : {}),
          });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
  return api;
}

async function callTool(env, token, name, args = {}) {
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    { waitUntil() {} }
  );
  return (await response.json())?.result;
}

async function searchText(env, token, args) {
  return (await callTool(env, token, "search_notes", args))?.content?.[0]?.text;
}

function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  return raw ? parseManifest(raw.body) : null;
}

/** Every doc path the stored v2 index holds, across every shard the manifest names. */
function indexedPaths(bucket) {
  const manifest = storedManifest(bucket);
  if (!manifest) return null;
  const paths = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const raw = bucket.objects.get(shardKey(id));
    const shard = raw ? parseShard(raw.body) : null;
    if (shard) paths.push(...shard.docs.keys());
  }
  return paths;
}

/** The note paths a `search_notes` answer actually listed, in the order it listed them. */
function pathsIn(text) {
  return (String(text).match(/^\S+\.md$/gm) || []).filter((line) => !line.startsWith("["));
}

const utf8 = new TextEncoder();
const byteLength = (value) => utf8.encode(value).byteLength;

export async function runSearchV2IntegrationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const main = createBucket();
    const wide = createBucket();
    const spread = createBucket();

    for (const [workspace, slug, binding] of [
      ["ws_v2_main", "v2main", "V2_MAIN_BUCKET"],
      ["ws_v2_wide", "v2wide", "V2_WIDE_BUCKET"],
      ["ws_v2_spread", "v2spread", "V2_SPREAD_BUCKET"],
    ]) {
      controlPlane.addWorkspace(workspace, slug, {
        provider: "r2-binding",
        bindingName: binding,
        capabilities: { conditionalWrite: true },
        status: "active",
      });
    }
    for (const [token, workspace, role, scopes, client, user] of [
      [
        MAIN_OWNER_TOKEN,
        "ws_v2_main",
        "owner",
        ["context:read", "context:write", "context:private"],
        "owner",
        "u_v2_owner",
      ],
      [MAIN_TEAM_TOKEN, "ws_v2_main", "editor", ["context:read"], "member", "u_v2_member"],
      [WIDE_TOKEN, "ws_v2_wide", "owner", ["context:read", "context:private"], "wide", "u_v2_wide"],
      [
        SPREAD_TOKEN,
        "ws_v2_spread",
        "owner",
        ["context:read", "context:private"],
        "spread",
        "u_v2_spread",
      ],
    ]) {
      await controlPlane.addGrant({
        accessToken: token,
        workspaceId: workspace,
        role,
        scopes,
        clientId: `mcp_client_searchv2_${client}`,
        userId: user,
      });
    }

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "V2_MAIN_BUCKET,V2_WIDE_BUCKET,V2_SPREAD_BUCKET",
      V2_MAIN_BUCKET: main,
      V2_WIDE_BUCKET: wide,
      V2_SPREAD_BUCKET: spread,
    };

    // -- (a) the first search builds `.index/v2/` and answers from it --------
    //
    // A multi-folder bucket, because the listing walk is delimited at the root
    // and flat inside each real folder: a fixture with one folder cannot tell
    // that walk from a flat one.
    main.seed("privacy.md", PRIVACY_MANIFEST);
    main.seed("index.md", "# Front page\n\nThe map of everything.\n");
    main.seed(
      "1-projects/atlas/protocol.md",
      "# NARWHAL protocol\n\nThe NARWHAL protocol is how atlas ships.\n"
    );
    main.seed("1-projects/atlas/notes.md", "# Atlas notes\n\nA passing NARWHAL is mentioned here.\n");
    main.seed("1-projects/beta/plan.md", "# Beta plan\n\nBeta is unrelated to atlas.\n");
    main.seed(
      "1-projects/vault/secret.md",
      "# Vault\n\nNARWHAL-PRIVATE-MARKER is filed here and must never leave.\n"
    );
    main.seed("2-areas/handbook.md", "# Handbook\n\nHouse rules for everyone.\n");
    main.seed("3-resources/reading/list.md", "# Reading\n\nBooks about the sea.\n");
    // Plumbing seeded beside the notes rather than assumed absent.
    main.seed("scopes.yml", "legacy: true\n");
    main.seed(".obsidian/app.json", "{}");
    main.seed(".history/index.md.2020-01-01.md", "# Front page\n\nNARWHAL once lived here.\n");
    // (d) v1's object, left behind by a deployment that ran the old index.
    main.seed(
      LEGACY_V1_KEY,
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), docs: [], terms: [] })
    );

    main.resetCounts();
    const firstOwner = await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
    const firstManifest = storedManifest(main);
    const firstPaths = indexedPaths(main);
    check(
      "the first search through the worker writes a v2 manifest and the shard objects under it",
      firstManifest !== null &&
        firstManifest.shardCount >= 1 &&
        main.counts.puts.includes(MANIFEST_KEY) &&
        main.counts.puts.includes(shardKey(0)) &&
        firstPaths.length > 0
    );
    check(
      "and answers from them, best match first, with no plumbing key anywhere in the index",
      pathsIn(firstOwner)[0] === "1-projects/atlas/protocol.md" &&
        firstOwner.includes("1-projects/vault/secret.md") &&
        firstPaths.every(
          (key) =>
            key.endsWith(".md") &&
            key !== "privacy.md" &&
            !key.split("/").some((segment) => segment.startsWith("."))
        )
    );

    // (d) v1's object is dead weight the moment a manifest exists, and the
    // delete is one blind op on the pass that first creates one — never a
    // probe on every search.
    check(
      "v1's object is deleted on the pass that first creates a manifest, and not probed again",
      main.objects.get(LEGACY_V1_KEY) === undefined &&
        main.counts.deletes.filter((key) => key === LEGACY_V1_KEY).length === 1 &&
        (await (async () => {
          main.resetCounts();
          await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
          return main.counts.delete === 0;
        })())
    );

    // -- (e) the second search re-uses the shards: no O(N) body reads --------
    main.resetCounts();
    const secondOwner = await searchText(env, MAIN_OWNER_TOKEN, { query: "narwhal" });
    const ownerHits = pathsIn(secondOwner);
    check(
      "a second search reads note bodies only for the hits it returns, and writes nothing",
      main.counts.noteGets.length === ownerHits.length &&
        main.counts.noteGets.every((key) => ownerHits.includes(key)) &&
        main.counts.noteGets.length < firstPaths.length &&
        main.counts.put === 0
    );

    // -- (b) THE PRIVACY LINE, across the shard boundary ---------------------
    //
    // The index was built by an owner-scope search, so a shard holds the
    // private note's path, title, terms and vocabulary. A team-scope search
    // over the shared term must disclose none of it — not the path, not a
    // snippet, and not a count that counts it.
    const teamSearch = await searchText(env, MAIN_TEAM_TOKEN, { query: "narwhal" });
    check(
      "a team search over an owner-built shard surfaces only the team-visible notes",
      typeof teamSearch === "string" &&
        teamSearch.includes("1-projects/atlas/protocol.md") &&
        !teamSearch.includes("1-projects/vault/secret.md") &&
        !teamSearch.includes("vault")
    );
    check(
      "no byte of the private note's text reaches a team connection",
      !teamSearch.includes("NARWHAL-PRIVATE-MARKER") && !teamSearch.includes("must never leave")
    );
    check(
      "and the reported count is the visible count exactly, never the shard's count",
      /^2 matching notes$/m.test(teamSearch) &&
        pathsIn(teamSearch).length === 2 &&
        /^3 matching notes$/m.test(secondOwner)
    );
    // One search path: `search_notes` and the ChatGPT-dialect `search` share
    // `searchVisibleNotes`, so a second path cannot disagree about what a query
    // matches or about who may see it.
    const teamDialect = JSON.parse(
      (await callTool(env, MAIN_TEAM_TOKEN, "search", { query: "narwhal" }))?.content?.[0]?.text
    );
    check(
      "the ChatGPT dialect rides the same v2 path and the same filter",
      Array.isArray(teamDialect.results) &&
        teamDialect.results.map((result) => result.id).sort().join(",") ===
          pathsIn(teamSearch).sort().join(",") &&
        !JSON.stringify(teamDialect).includes("NARWHAL-PRIVATE-MARKER")
    );

    // -- (f) an unprefixed search on a wide-ish context stays inside the budget
    wide.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 60; n += 1) {
      wide.seed(
        `1-projects/bulk/note-${String(n).padStart(3, "0")}.md`,
        `# Bulk note ${n}\n\nEvery bulk note mentions the widget, this one is number ${n}.\n`
      );
    }
    wide.resetCounts();
    const wideFirst = await searchText(env, WIDE_TOKEN, { query: "widget" });
    const wideFirstOps = wide.ops;
    const wideStore = new R2Store(wide);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pass = await syncShardedIndex(wideStore, { budget: createSearchBudget(300) });
      if (pass.pending === 0) break;
    }
    wide.resetCounts();
    const wideSteady = await searchText(env, WIDE_TOKEN, { query: "widget" });
    check(
      "an unprefixed search on a 60-note context stays inside the budget, cold and converged alike",
      wideFirstOps - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        wideFirstOps < SUBREQUEST_LIMIT &&
        wide.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET &&
        typeof wideFirst === "string" &&
        wideFirst.includes("1-projects/bulk/note-")
    );
    check(
      "and a converged one answers at the result limit without re-reading the bucket",
      pathsIn(wideSteady).length === SEARCH_RESULT_LIMIT &&
        wide.counts.noteGets.length === SEARCH_RESULT_LIMIT &&
        wide.counts.put === 0 &&
        !wideSteady.includes("still catching up")
    );

    // -- (3) a shard the budget could not open is a floor, not an empty shard -
    //
    // `loadShard` answers `null` for a budget refusal and for an absent object
    // alike — deliberately, since to most callers the answer is the same — so
    // the gateway checks `budget.remaining` before it asks. Reading a refusal
    // as "this shard holds nothing" is answering the query from part of the
    // corpus while telling the caller it is the whole of it.
    //
    // The manifest is seeded at twenty shards before anything is indexed (the
    // count is chosen once, at creation, and never changes) so the walk costs
    // twenty reads on a bucket of two dozen notes. That is the cheap way to
    // reach the state a 6,000-note brain reaches on the free tier.
    spread.seed("privacy.md", PRIVACY_MANIFEST);
    spread.seed(MANIFEST_KEY, serializeManifest(emptyManifest(20)));
    for (let n = 0; n < 24; n += 1) {
      spread.seed(
        `1-projects/spread/note-${String(n).padStart(2, "0")}.md`,
        `# Spread ${n}\n\nA PORPOISE swims through note number ${n}.\n`
      );
    }
    const spreadStore = new R2Store(spread);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const pass = await syncShardedIndex(spreadStore, { budget: createSearchBudget(300) });
      if (pass.pending === 0) break;
    }
    const spreadManifest = storedManifest(spread);
    // The starved budget is the floor of the deployment override, and the pass
    // is otherwise complete: nothing is stale, the listing finishes, the
    // manifest fits. The only thing this answer can be incomplete about is a
    // shard it could not afford to open.
    spread.resetCounts();
    const starved = await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "16" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    const starvedOps = spread.ops;
    const roomy = await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "200" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    check(
      "a search that cannot afford to open every shard says so, in the census's floor language",
      spreadManifest?.shardCount === 20 &&
        typeof starved === "string" &&
        starved.includes("still catching up") &&
        starvedOps - PRIVACY_MANIFEST_READ <= 16
    );
    check(
      "and the same query with budget to spare says nothing of the kind, so that is a floor and not a banner",
      typeof roomy === "string" &&
        !roomy.includes("still catching up") &&
        pathsIn(roomy).length === SEARCH_RESULT_LIMIT
    );
    check(
      "the starved answer is still an answer, from the shards it did reach",
      pathsIn(starved).length > 0 &&
        pathsIn(starved).every((path) => path.startsWith("1-projects/spread/"))
    );

    // 24 notes over 20 shards leaves some shards genuinely empty, and the walk
    // must not spend a GET proving each one holds nothing — the sync already
    // skips them on the manifest's authority, and an over-sharded small bucket
    // otherwise pays one 404 per empty shard on every query.
    const occupied = spreadManifest
      ? spreadManifest.stats.filter((entry) => (entry?.docCount || 0) > 0).length
      : 0;
    spread.resetCounts();
    await searchText({ ...env, SEARCH_SUBREQUEST_BUDGET: "200" }, SPREAD_TOKEN, {
      query: "porpoise",
    });
    const shardGets = spread.counts.getKeys.filter((key) =>
      key.startsWith(".index/v2/shard-")
    ).length;
    check(
      "an empty shard is never fetched: the walk reads exactly the occupied shards",
      occupied > 0 && occupied < 20 && shardGets === occupied
    );

    // -- (c) THE WHOLE POINT: a bucket v1 cannot converge on, converged ------
    //
    // Driven at module level rather than through the worker, and deliberately:
    // the byte caps are injectable parameters on the two sync functions and
    // nothing in production passes them, so there is no way to reach this
    // through a tool call — and building twelve real megabytes of index would
    // take thousands of notes and minutes of wall clock. What the fixture
    // proves is the shape, at a cap small enough to run: **one number, applied
    // to v1's single object and to each v2 shard, is a plateau for one and a
    // convergence for the other.**
    //
    // The distinct vocabulary per note is what makes the index grow with the
    // corpus rather than with its filler — the contact-heavy vocabulary of the
    // live brain that hit the real ceiling.
    {
      const seedNotes = (bucket) => {
        bucket.seed("privacy.md", PRIVACY_MANIFEST);
        for (let n = 0; n < 80; n += 1) {
          bucket.seed(
            `1-projects/grow/note-${String(n).padStart(3, "0")}.md`,
            `# Grow ${n}\n\nunique${n} vocabulary${n} marker${n} distinct${n} separate${n} filler\n`
          );
        }
      };

      // Both indexes built once with no cap at all, to measure what a cap has
      // to sit between: v1's whole object above it, v2's largest shard below.
      const measureV1 = createBucket();
      seedNotes(measureV1);
      await syncIndex(new R2Store(measureV1), { budget: createSearchBudget(400) });
      const wholeIndexBytes = byteLength(measureV1.objects.get(SEARCH_INDEX_KEY).body);

      const measureV2 = createBucket();
      seedNotes(measureV2);
      // Sixteen shards, chosen at creation as `chooseShardCount` would for a
      // brain sixteen times this size. The sizing formula is not what is under
      // test here; what a shard costs to store is.
      measureV2.seed(MANIFEST_KEY, serializeManifest(emptyManifest(16)));
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const pass = await syncShardedIndex(new R2Store(measureV2), {
          budget: createSearchBudget(400),
        });
        if (pass.pending === 0) break;
      }
      let largestShardBytes = 0;
      for (let id = 0; id < 16; id += 1) {
        const stored = measureV2.objects.get(shardKey(id));
        if (stored) largestShardBytes = Math.max(largestShardBytes, byteLength(stored.body));
      }
      // Halfway between the two, so the fixture is not one byte from either
      // side of its own claim.
      const cap = Math.floor((largestShardBytes + wholeIndexBytes) / 2);

      const v1Bucket = createBucket();
      seedNotes(v1Bucket);
      const v1Store = new R2Store(v1Bucket);
      // Five passes, unconditionally: v1's `pending` describes what it built in
      // memory, not what it stored, so a refused write reports a clean pass and
      // "run it until it says it is done" would stop after the first one.
      let v1Pass = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        v1Pass = await syncIndex(v1Store, { budget: createSearchBudget(400), byteCap: cap });
      }
      const v1Stored = v1Bucket.objects.get(SEARCH_INDEX_KEY);
      const v1StoredDocs = v1Stored ? parseIndex(v1Stored.body)?.docs.size ?? 0 : 0;

      const v2Bucket = createBucket();
      seedNotes(v2Bucket);
      v2Bucket.seed(MANIFEST_KEY, serializeManifest(emptyManifest(16)));
      const v2Store = new R2Store(v2Bucket);
      let v2Pass = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        v2Pass = await syncShardedIndex(v2Store, {
          budget: createSearchBudget(400),
          shardByteCap: cap,
        });
        if (v2Pass.pending === 0) break;
      }
      const v2StoredDocs = indexedPaths(v2Bucket);

      check(
        "the fixture is honest: one cap, above every v2 shard and below v1's single object",
        largestShardBytes > 0 && largestShardBytes < cap && cap < wholeIndexBytes
      );
      check(
        "under that cap v1 plateaus — the stored index never holds the corpus, however many passes run",
        v1StoredDocs < 80 && v1Pass !== null
      );
      check(
        "and v2 converges on the same bucket under the same number, one shard at a time",
        v2Pass.pending === 0 &&
          v2StoredDocs.length === 80 &&
          new Set(v2StoredDocs).size === 80 &&
          v2Pass.manifestOverflow === false
      );
      check(
        "with every shard it wrote small enough for the same cap to read back",
        (() => {
          const manifest = storedManifest(v2Bucket);
          for (let id = 0; id < manifest.shardCount; id += 1) {
            const stored = v2Bucket.objects.get(shardKey(id));
            if (!stored) continue;
            if (byteLength(stored.body) > cap) return false;
            if (parseShard(stored.body, cap) === null) return false;
          }
          return true;
        })()
      );
    }
  } finally {
    restore?.();
  }
}
