/**
 * The search index wired into the gateway: the budget, the privacy line, and
 * every way the sync is allowed to be incomplete.
 *
 * The bug this replaces was not a slow search, it was a broken one. The
 * brute-force scan fetched up to 400 notes per query against a per-invocation
 * subrequest limit of 50, so a real 154-note context answered *every*
 * unprefixed search with "Too many subrequests". A cap that is eight times the
 * limit is not a cap, and nothing in the old suite could see it: the shared
 * fixture holds a few dozen notes, so the scan never got near its own ceiling.
 *
 * This file therefore stands up its own instrumented bucket and **counts store
 * calls**, because the property that matters here cannot be asserted from
 * output text. Three things are checked that a green run alone would not show:
 *
 * 1. **The op count is bounded.** One search stays inside
 *    `SEARCH_SUBREQUEST_BUDGET` on a bucket of 65 notes, and the second search
 *    reads note bodies only for the hits it returns.
 * 2. **The index is not a privacy hole**, in two senses that need separate
 *    checks. It holds text drawn from private notes — fine inside the
 *    customer's own bucket, never fine in what leaves the gateway — so a
 *    team-scope search over a term appearing in both a team note and a private
 *    one must surface one path, one snippet set, and a count of exactly one.
 *    That is the *content* line, and it was held from the start. The
 *    *inference* line is the other question and was held by nothing: a team
 *    connection's own answer must not change when a note it cannot see
 *    changes. Three channels did — see block (d2).
 * 3. **Every incompleteness is said out loud.** A backfill that ran out of
 *    budget, a listing that could not finish, an index that had to be rebuilt,
 *    a conditional write somebody else won — none of them may quietly return
 *    fewer results than the answer implies.
 *
 * ## Which index each block drives, since there are now two
 *
 * The gateway answers from the **sharded** index (CONTRACT.md § v2): a search
 * through the worker syncs `.index/v2/manifest.json` and its shards, and never
 * touches `.index/search-v1.json`. So every block here that goes through
 * `searchText` / `callTool` exercises v2 and reads its objects; the blocks that
 * call `syncIndex` directly — the plateau and byte-cap fixtures, the per-note
 * char cap, the parallel-wave backfill, the etag-less backend — are checks
 * about the v1 module, which is retained and unchanged, and they stay as they
 * were rather than being deleted for testing code the gateway no longer calls.
 *
 * The sabotage record below is in the same two halves. **Entries 1-6 were
 * measured against the v1 gateway path and are kept as the history of how those
 * channels were found, not as claims about the code running today** — the
 * numbers for v2 are re-measured in `searchV2Integration.test.mjs`, and one of
 * them inverts (dropping the visibility predicate now fails the *inference*
 * checks while `rankedVisibleTo` catches the content leak). Entries 7-9 are the
 * v1 byte cap and are about the module those blocks still drive, so they are
 * current.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`canSee` dropped from the indexed result filter** in
 *    `searchVisibleNotes`. 10 checks failed: five here — the private path
 *    surfaced, its text surfaced, the count read 2, the floor marker appeared,
 *    and the ChatGPT dialect leaked the same note — and five of the shared
 *    suite's existing privacy checks, which is the reassuring half. The index
 *    changed how search finds a note; it did not get its own privacy rules.
 * 2. **The reported count taken from `ranked` instead of the filtered list.**
 *    2 checks failed, and only the two about counts: every path and snippet
 *    stayed correct while a team connection was told "2 matching notes" over
 *    one visible result. That is why the count is asserted separately — it is
 *    the one channel that leaks by arithmetic rather than by content, and the
 *    reason `matchCountIsFloor` is read off the visible list too.
 * 3. **`budget.take` made to always succeed** (never decrement). 4 checks
 *    failed: both budget assertions, the pending-backfill floor language (the
 *    sync now finished everything in one pass, so there was nothing to be
 *    honest about), and `syncIndex`'s own `pending`. A 60-note probe spent 75
 *    store ops in one search against a limit of 50 — the original bug,
 *    reproduced.
 * 4. **`visibleIndex` made to return the index it was given** (the early-out
 *    condition forced true, not a deletion). 3 checks failed, one per channel:
 *    the expansion oracle, the idf reorder and the rank reorder. Every other
 *    privacy check in the suite stayed green, which is the finding — the
 *    *content* line was held all along and the *inference* line was held by
 *    nothing.
 * 5. **`computeRanks(view)` alone skipped**, the view still filtered. Exactly 1
 *    check failed, the rank one. That is the half filtering cannot close, so it
 *    is the half that needed its own check rather than riding on the other two.
 *
 * 6. **The output filter neutered** (`rankedVisibleTo`'s predicate forced
 *    true). At base that failed **ten** checks across this file and the shared
 *    suite. At head, with `visibleIndex` in front of it, it failed **zero** —
 *    which is what a review caught, and it is row 127's shape exactly: *two
 *    guards that mask one another are one guard with a spare.* Narrowing the
 *    corpus made the filter correct and untestable in the same commit. It is a
 *    separate function with its own checks in searchQuery.test.mjs now, driven
 *    with a list the view deliberately did not narrow; the same sabotage fails
 *    2 there.
 *
 * 7. **The write-side byte cap and its byte counter, nineteen mutations.**
 *    Every count below is as measured against the final fixtures. They were
 *    re-taken after each of the four rounds of new checks and moved every
 *    time, which is the register's own "a measurement has a timestamp"
 *    arriving inside a sabotage record: earlier versions of this list were
 *    written before the next round landed and were wrong within their own
 *    commit, twice.
 *
 *      the write guard, off entirely                        5
 *      UTF-16 code units instead of bytes                   1
 *      a write cap of its own (`byteCap * 3`)               1
 *      a second return literal (`pending: 0, …: false`)     2
 *      a literal lying only about `listingTruncated`        1
 *      the read consulting the module constant              1
 *      the read made strict (`< byteCap`)                   1
 *      `length * 3 > cap`, never measuring                  4
 *      fast-accept bound, 3 -> 2 bytes per unit             4
 *      `Number.isFinite` deleted                            2
 *      `Number.isFinite` -> `??`                            1
 *      `Number.isFinite` -> `== null`                       1
 *      a surrogate pair counted as three bytes              2
 *      a lone surrogate counted as two                      3
 *      the 2-byte boundary off by one                       2
 *      `>=` for `>`                                         4
 *      pair detection dropping the second-half check        3
 *      pair upper bound 0xdc00 -> 0xe000                    2
 *      the budget op charged before the size check          1
 *
 *    One more is an **equivalent mutant** and correctly fails 0: dropping
 *    `i + 1 < value.length` from pair detection, because `charCodeAt` past the
 *    end is `NaN` and `NaN & 0xfc00` is never `0xdc00`. The bound stays as
 *    written rather than as relied-upon arithmetic.
 *
 *    Two **more**, outside the nineteen above and each failing 1, are
 *    mutations of a *fixture* rather than of the module — twenty-two driven in
 *    total, counting the equivalent mutant. Both are the plausible edit rather
 *    than an invented one: giving the at-cap fixture a byte of headroom to
 *    look less brittle (which walks the
 *    strict-read mutation through, so `boundaryCap` is asserted equal to the
 *    measured body), and widening the fuzz's first branch so every string is
 *    plain ASCII (which makes the check's own name false, so its distribution
 *    is counted).
 * 8. **Four rounds, and each round's fixtures were found by attacking the
 *    previous round's.** Round one's five were all on/off or operator
 *    replacements and left three holes: `length * 3 > cap` never measures and
 *    nothing sat in the measurement band; a second return literal walked
 *    through because nothing read `pending`, `listingTruncated` or `spent`;
 *    and a read made strict is the two-caps-disagree loop one byte wide. Round
 *    two closed those with a body *exactly* at the cap and a refusal driven on
 *    a budget-starved pass — and left three more: `NaN` was named in a comment
 *    and tested nowhere, `listingTruncated` was still `false` in every
 *    fixture, and the corpus check's own size guard was `compared ===
 *    corpus.length * 8`, which derives both sides from the same array and
 *    holds for an empty corpus. Round three is the literal `144`, a `NaN`
 *    cap, and a listing shaped to truncate *and* overflow at once — and left
 *    three more, two of them the same self-referential shape one level up:
 *    `fuzzCases === 4000 * 6` is a fact about the loop rather than about the
 *    corpus, the at-cap fixture asserted a fact about the *body* that is true
 *    at any cap above it, and the budget op was charged before the size check
 *    so a refused pass spent a subrequest on a `put` that never ran. Round
 *    four counts the fuzz's own distribution, names the cap once and asserts
 *    it equals the measured size, and compares `spent` against the store's
 *    real call count rather than against the budget object it came from.
 * 9. **The counter is held by a corpus rather than by reading it**, in
 *    `searchIndexer.test.mjs`: every one of the 65,536 BMP code units, padded
 *    so neither O(1) bound can decide it, plus a seeded xorshift corpus of
 *    astral pairs and unpaired surrogates — 220,608 comparisons against
 *    `TextEncoder`, under a second. The BMP pad is two-byte on purpose: with
 *    an ASCII pad, 128 of those cases are refused by the O(1) length bound and
 *    never counted at all, so the loop was not testing what it is named for. The hand-picked corpus beside it says
 *    which cases somebody thought of, and it needed three entries added before
 *    it could tell the surrogate mutations apart: in every case originally
 *    there the two readings totalled the same, so those mutations agreed with
 *    the encoder by coincidence.
 *
 * (Entries 1-6 above concern the visibility channels; the three named in 4-6
 * were all measured *before* the fix and all three failed, end to end through
 * the worker with a real `context:read` editor grant — not reasoned about from
 * the source. Entries 7-9 are the byte cap and have no channels; the sentence
 * used to sit at the end of the list, where a reader landed on it and
 * mis-attributed it.)
 */

import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import {
  NOTE_INDEX_CHAR_CAP,
  SEARCH_INDEX_KEY,
  createSearchBudget,
  defaultIsIndexable,
  syncIndex,
} from "../src/search/maintain.js";
import {
  MANIFEST_KEY,
  parseManifest,
  parseShard,
  shardKey,
  syncShardedIndex,
} from "../src/search/shards.js";
import { searchIndex } from "../src/search/query.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

/** Mirrors `SEARCH_SUBREQUEST_BUDGET` / `SEARCH_RESULT_LIMIT` in src/index.js. */
const SEARCH_SUBREQUEST_BUDGET = 40;
const SEARCH_RESULT_LIMIT = 10;
/** Mirrors `MAX_RESULTS` in src/search/query.js, asserted below rather than trusted. */
const RANK_CAP = 50;
/**
 * Every tool call reads `privacy.md` before it dispatches, and that read is not
 * the search's to spend. Counted separately so the budget assertions are about
 * the budget rather than about how many things happen to touch the bucket.
 */
const PRIVACY_MANIFEST_READ = 1;
/** Cloudflare's per-invocation ceiling on the free tier — the real limit. */
const SUBREQUEST_LIMIT = 50;

const OWNER_TOKEN = `cat_searchidx_owner_${"0".repeat(16)}`;
const TEAM_TOKEN = `cat_searchidx_member_${"0".repeat(15)}`;
const BIG_TOKEN = `cat_searchidx_big_${"0".repeat(18)}`;
const BROKEN_TOKEN = `cat_searchidx_broken_${"0".repeat(15)}`;
const DEEP_TOKEN = `cat_searchidx_deep_${"0".repeat(17)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  1-projects/vault: private\n" +
  "  2-areas: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object the way R2 and S3 both do, and counts every call.
 *
 * The hooks are how the failure modes get reached without monkey-patching the
 * modules under test: `failGetKeys` makes one key unreadable (a storage error
 * mid-sync), and `onBeforePut` is what lets a conditional write lose a race it
 * really ran.
 */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, noteGets: [] };
  const failGetKeys = new Set();
  let onBeforePut = null;

  const api = {
    objects,
    counts,
    failGetKeys,
    /** Off for the Dropbox-shaped backend, whose listings carry no etag. */
    listEtags: true,
    setBeforePut(hook) {
      onBeforePut = hook;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.noteGets = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.put + counts.list;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
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
      if (onBeforePut) onBeforePut(key, options);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
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
  const { ctx, settle } = createWorkerCtx();
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
    ctx
  );
  const result = (await response.json())?.result;
  // The worker finishes the search index after its response, on the same
  // subrequest counter the answer spent from. Settling here is what makes an
  // op count a count of one whole invocation rather than of whatever part of
  // the deferred pass happened to have run.
  await settle();
  return result;
}

async function searchText(env, token, args) {
  return (await callTool(env, token, "search_notes", args))?.content?.[0]?.text;
}

/**
 * The gateway answers from the sharded index now, so "what did the worker
 * build" is a manifest plus its shard objects rather than one parsed blob —
 * which is what the three helpers below read. The v1 module checks further
 * down still drive `syncIndex` directly and read its object by key, because
 * they are checks about that module rather than about the gateway.
 */
function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  return raw ? parseManifest(raw.body) : null;
}

/** Every doc path the stored v2 index holds, across every shard it names. */
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

/** Every v2 object gone, which is what "nothing has indexed this bucket" means. */
function removeV2Index(bucket) {
  for (const key of [...bucket.objects.keys()]) {
    if (key.startsWith(".index/v2/")) bucket.remove(key);
  }
}

/**
 * The v2 sync run to convergence, standing in for the many searches a real
 * context would spend getting there. The fixtures below use it wherever they
 * need the *whole* bucket indexed before a worker search asks a question about
 * ranking or about counts.
 */
async function convergeV2(store) {
  let pass = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    pass = await syncShardedIndex(store, { budget: createSearchBudget(300) });
    if (pass.pending === 0) break;
  }
  return pass;
}

export async function runSearchIntegrationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const big = createBucket();
    const broken = createBucket();
    // Its own bucket, so the per-note cap's fixtures cannot disturb the counts
    // the shared one is asserted on.
    const deep = createBucket();

    for (const [workspace, slug, binding] of [
      ["ws_search", "search", "SEARCH_BUCKET"],
      ["ws_search_big", "searchbig", "BIG_BUCKET"],
      ["ws_search_broken", "searchbroken", "BROKEN_BUCKET"],
      ["ws_search_deep", "searchdeep", "DEEP_BUCKET"],
    ]) {
      controlPlane.addWorkspace(workspace, slug, {
        provider: "r2-binding",
        bindingName: binding,
        capabilities: { conditionalWrite: true },
        status: "active",
      });
    }
    for (const [token, workspace, role, scopes, client, user] of [
      [OWNER_TOKEN, "ws_search", "owner", ["context:read", "context:write", "context:private"], "owner", "u_owner"],
      [TEAM_TOKEN, "ws_search", "editor", ["context:read"], "member", "u_member"],
      [BIG_TOKEN, "ws_search_big", "owner", ["context:read", "context:private"], "big", "u_big"],
      [BROKEN_TOKEN, "ws_search_broken", "owner", ["context:read", "context:private"], "broken", "u_broken"],
      [DEEP_TOKEN, "ws_search_deep", "owner", ["context:read", "context:private"], "deep", "u_deep"],
    ]) {
      await controlPlane.addGrant({
        accessToken: token,
        workspaceId: workspace,
        role,
        scopes,
        clientId: `mcp_client_searchidx_${client}`,
        userId: user,
      });
    }

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "SEARCH_BUCKET,BIG_BUCKET,BROKEN_BUCKET,DEEP_BUCKET",
      SEARCH_BUCKET: bucket,
      BIG_BUCKET: big,
      BROKEN_BUCKET: broken,
      DEEP_BUCKET: deep,
    };

    // -- the main fixture: a team note and a private note sharing one term ----
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# Front page\n\nThe map of everything.");
    // The term is in the title so this note outranks any number of body-only
    // matches — the owner's floor check at the end of this block needs it to
    // stay inside `searchIndex`'s 50-result cap however much private noise is
    // added. That crowding is the owner's own now: since `visibleIndex`, a team
    // connection is scored against a corpus the private notes are not in, so
    // they cannot push a visible note out of its ranked list at all.
    bucket.seed(
      "1-projects/alpha/protocol.md",
      "# ZEBRAFISH protocol\n\nThe ZEBRAFISH protocol is how alpha ships.\n"
    );
    bucket.seed("1-projects/alpha/notes.md", "# Alpha notes\n\nOrdinary PANGOLIN husbandry.\n");
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nBeta is unrelated to alpha.\n");
    bucket.seed(
      "1-projects/vault/secret.md",
      "# Vault\n\nZEBRAFISH-PRIVATE-MARKER is filed here and must never leave.\n"
    );
    bucket.seed("2-areas/handbook.md", "# Handbook\n\nHouse rules for everyone.\n");
    // Plumbing that must never reach the index, seeded beside the notes rather
    // than assumed absent.
    bucket.seed("scopes.yml", "legacy: true\n");
    bucket.seed(".obsidian/app.json", "{}");
    bucket.seed(".history/index.md.2020-01-01.md", "# Front page\n\nZEBRAFISH once lived here.\n");

    // (a) the first search builds the index and answers from it
    bucket.resetCounts();
    const firstOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const firstOps = bucket.ops;
    const builtManifest = storedManifest(bucket);
    const builtPaths = indexedPaths(bucket);
    check(
      "the first search builds a valid manifest and its shards, and answers from them",
      builtManifest !== null &&
        builtManifest.shardCount >= 1 &&
        builtPaths.length > 0 &&
        typeof firstOwner === "string" &&
        firstOwner.includes("1-projects/alpha/protocol.md")
    );
    check(
      "the index never holds a plumbing key, whatever is sitting beside the notes",
      builtPaths.every(
        (key) =>
          key.endsWith(".md") &&
          key !== "privacy.md" &&
          !key.split("/").some((segment) => segment.startsWith("."))
      )
    );
    check(
      "and the module's standalone note filter agrees with the gateway's plumbing rule",
      defaultIsIndexable("1-projects/alpha/protocol.md") &&
        !defaultIsIndexable("privacy.md") &&
        !defaultIsIndexable("scopes.yml") &&
        !defaultIsIndexable(".history/index.md.2020-01-01.md") &&
        !defaultIsIndexable("1-projects/.trash/old.md") &&
        !defaultIsIndexable("1-projects/alpha/diagram.png")
    );

    // (b) the second search re-uses the index: no O(N) body reads
    bucket.resetCounts();
    const secondOwner = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    const ownerHitCount = (secondOwner.match(/^1-projects\//gm) || []).length;
    check(
      "a second search re-uses the index rather than re-reading the bucket",
      bucket.counts.noteGets.length <= ownerHitCount &&
        bucket.counts.noteGets.length < builtPaths.length &&
        bucket.counts.put === 0
    );
    check(
      "and it still answers, so the reuse is not an empty answer",
      secondOwner.includes("1-projects/alpha/protocol.md") &&
        secondOwner.includes("1-projects/vault/secret.md")
    );

    // (d) THE PRIVACY LINE. The index was built by an owner-scope search above,
    // so it holds the private note's path, title, terms and vocabulary. A
    // team-scope search over the shared term must disclose none of it — not the
    // path, not a snippet, and not a count that counts it.
    bucket.resetCounts();
    const teamSearch = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    check(
      "a team search over an owner-built index surfaces only the team-visible note",
      typeof teamSearch === "string" &&
        teamSearch.includes("1-projects/alpha/protocol.md") &&
        !teamSearch.includes("1-projects/vault/secret.md") &&
        !teamSearch.includes("vault")
    );
    check(
      "no byte of the private note's text reaches a team connection",
      typeof teamSearch === "string" &&
        !teamSearch.includes("ZEBRAFISH-PRIVATE-MARKER") &&
        !teamSearch.includes("must never leave")
    );
    check(
      "the reported count is the count of visible matches, never of index matches",
      /^1 matching note$/m.test(teamSearch)
    );
    check(
      "and the same query at owner scope reports the larger count, so that is a filter and not a cap",
      /^2 matching notes$/m.test(secondOwner)
    );

    // (j) the prefix argument filters indexed results
    const prefixed = await searchText(env, OWNER_TOKEN, {
      query: "alpha",
      prefix: "1-projects/alpha",
    });
    check(
      "a prefix argument filters the indexed results to that subtree",
      prefixed.includes("1-projects/alpha/") &&
        !prefixed.includes("1-projects/beta/") &&
        !prefixed.includes("2-areas/")
    );

    // the ChatGPT dialect rides the same path and the same filter
    const teamDialect = JSON.parse(
      (await callTool(env, TEAM_TOKEN, "search", { query: "zebrafish" }))?.content?.[0]?.text
    );
    check(
      "the ChatGPT dialect shares the indexed path and its visibility filter",
      Array.isArray(teamDialect.results) &&
        teamDialect.results.length === 1 &&
        teamDialect.results[0].id === "1-projects/alpha/protocol.md" &&
        typeof teamDialect.results[0].title === "string" &&
        teamDialect.results[0].title.length > 0 &&
        !JSON.stringify(teamDialect).includes("ZEBRAFISH-PRIVATE-MARKER")
    );

    // (e) an edit is picked up by the etag diff; a deletion disappears
    bucket.seed(
      "1-projects/beta/plan.md",
      "# Beta plan\n\nBeta now mentions the OCTOPUS milestone.\n"
    );
    bucket.remove("1-projects/alpha/notes.md");
    const afterEdit = await searchText(env, OWNER_TOKEN, { query: "octopus" });
    check(
      "a note edited after indexing is re-indexed on the next search",
      afterEdit.includes("1-projects/beta/plan.md") && afterEdit.includes("OCTOPUS")
    );
    const afterDelete = await searchText(env, OWNER_TOKEN, { query: "pangolin" });
    check(
      "a deleted note disappears from results and from the index",
      afterDelete.includes("(no matches)") &&
        !indexedPaths(bucket).includes("1-projects/alpha/notes.md")
    );

    // (f) a corrupt manifest is a rebuild, never a throw and never a wrong
    // answer. The manifest is the diff surface, so garbage there is the whole
    // index gone as far as the next pass is concerned — v1's single object
    // wearing v2's shape.
    bucket.seed(MANIFEST_KEY, "{ this is not the manifest you are looking for");
    const afterCorrupt = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a corrupt manifest still answers correctly",
      afterCorrupt.includes("1-projects/alpha/protocol.md") &&
        afterCorrupt.includes("1-projects/vault/secret.md")
    );
    check(
      "and is replaced with a valid one, with the notes back in its shards",
      storedManifest(bucket) !== null && indexedPaths(bucket).length > 0
    );

    // (g) a conditional-put conflict is a skipped write, not a retry loop. The
    // manifest is v2's concurrency point — shards are written unconditionally
    // under it — so the race is run on the manifest and counted there.
    bucket.seed("1-projects/beta/plan.md", "# Beta plan\n\nA CUTTLEFISH joins the milestone.\n");
    bucket.resetCounts();
    let manifestPuts = 0;
    bucket.setBeforePut((key, options) => {
      // Somebody else's sync landed between our read and our write. Changing the
      // stored etag makes the real precondition fail, rather than simulating it.
      if (key !== MANIFEST_KEY) return;
      manifestPuts += 1;
      if (options?.onlyIf) {
        const stored = bucket.objects.get(key);
        if (stored) stored.etag = `${stored.etag}-raced`;
      }
    });
    const afterConflict = await searchText(env, OWNER_TOKEN, { query: "cuttlefish" });
    bucket.setBeforePut(null);
    check(
      "a lost conditional write still answers the query it was serving",
      afterConflict.includes("1-projects/beta/plan.md")
    );
    check(
      "and does not retry: one attempt, then on with the query",
      manifestPuts === 1 && bucket.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET
    );

    // The count's floor is read off what the caller can see, and this is the
    // channel that leaks by arithmetic rather than by content: a "+" on a team
    // connection's count over one visible hit would be one bit about every
    // private note that filled the list — the same subtraction the census is
    // owner-only to prevent.
    //
    // The fifty-five below no longer *can* fill a team connection's ranked
    // list: the shard collector gathers only the docs this caller can see, so
    // that list is scored over a corpus the private notes are not in — v1
    // narrowed the same corpus with `visibleIndex`, one whole index at a time,
    // and v2 does it one shard at a time, which is the only difference the
    // checks below can see. So this block now proves the arithmetic guard on
    // the owner's side and the emptiness of the channel on the team side,
    // which is why both checks stay. (An earlier version of this comment survived the fix that made it
    // false, in the same commit that corrected its twin ninety lines above —
    // caught by review, and the third time a retracted sentence has outlived
    // its own retraction here.)
    for (let n = 0; n < 55; n += 1) {
      bucket.seed(
        `1-projects/vault/bulk-${String(n).padStart(3, "0")}.md`,
        `# Vault bulk ${n}\n\nZEBRAFISH again, privately, number ${n}.\n`
      );
    }
    const bucketStore = new R2Store(bucket);
    await convergeV2(bucketStore);
    const teamAfterBulk = await searchText(env, TEAM_TOKEN, { query: "zebrafish" });
    const ownerAfterBulk = await searchText(env, OWNER_TOKEN, { query: "zebrafish" });
    check(
      "a bucket full of private matches puts no floor marker on a team connection's count",
      /^1 matching note$/m.test(teamAfterBulk) && !teamAfterBulk.includes("+ matching")
    );
    check(
      "while the connection that can see them is told its own count is a floor",
      /^50\+ matching notes/m.test(ownerAfterBulk)
    );

    // (d2) THE INFERENCE LINE. Everything above asks what index *data* reaches a
    // team connection. This asks the other question: does the SHAPE of a team
    // connection's own answer change when a note it cannot see changes? Both
    // channels below are the corpus statistics — `N`, `df`, `avglen` — which a
    // scorer reads over every doc it is handed, private ones included, unless
    // the step in front of it withholds them: `visibleIndex` in v1,
    // `collectShardCandidates` per shard in v2.
    //
    // CONTRACT.md § the index contains text drawn from private notes already
    // forbids this in its own words: "Nothing derived from a term's presence in
    // the vocabulary may reach a caller who could not read every note." It then
    // reasons that "fuzzy/prefix expansions are query rewrites, not output" —
    // which is the step that does not hold. A rewrite whose *trigger* is a
    // private note's contents is an output channel however it is spelled.

    // Channel one: whether an expansion fires at all. The scorer expands a
    // query term only when its df is zero, and df is counted over the whole
    // corpus it was given. So planting a word in a note the caller can see, and asking for a
    // prefix of it, turns the team connection's own answer into a test for
    // whether that exact prefix appears in some note it cannot see.
    bucket.seed(
      "1-projects/alpha/marsupials.md",
      "# Field notes\n\nThe QUOKKATRON survey ran all summer.\n"
    );
    await convergeV2(bucketStore);
    const teamBeforePlant = await searchText(env, TEAM_TOKEN, { query: "quokka" });
    bucket.seed(
      "1-projects/vault/expedition.md",
      "# Vault\n\nThe QUOKKA itself is filed privately and must never leave.\n"
    );
    await convergeV2(bucketStore);
    const teamAfterPlant = await searchText(env, TEAM_TOKEN, { query: "quokka" });
    check(
      "a private note appearing does not change what a team connection's own query answers",
      teamBeforePlant === teamAfterPlant
    );
    check(
      "and the answer it does not change is a real one, not two identical refusals",
      teamBeforePlant.includes("1-projects/alpha/marsupials.md")
    );
    check(
      "while the connection that can see the private note still finds it",
      (await searchText(env, OWNER_TOKEN, { query: "quokka" })).includes(
        "1-projects/vault/expedition.md"
      )
    );

    // Channel two: the order of results the caller *can* see. Two visible notes
    // match one query term each; their scores differ only by idf, which is a
    // function of N and of each term's df across the whole corpus. Private
    // notes carrying one of the two terms push that term's idf down and reorder
    // a list every path in which the caller may read.
    bucket.seed("2-areas/aa-wombat.md", "# Wombat census\n\nCounting burrows.\n");
    bucket.seed("2-areas/zz-numbat.md", "# Numbat census\n\nCounting termites.\n");
    await convergeV2(bucketStore);
    const orderOf = (text) =>
      (text.match(/^2-areas\/(?:aa-wombat|zz-numbat)\.md$/gm) || []).join(",");
    const teamOrderBefore = orderOf(await searchText(env, TEAM_TOKEN, { query: "wombat numbat" }));
    for (let n = 0; n < 8; n += 1) {
      bucket.seed(
        `1-projects/vault/wombat-${n}.md`,
        `# Vault wombat ${n}\n\nA private WOMBAT sighting, number ${n}.\n`
      );
    }
    await convergeV2(bucketStore);
    const teamOrderAfter = orderOf(await searchText(env, TEAM_TOKEN, { query: "wombat numbat" }));
    check(
      "and notes it cannot see do not reorder the ones it can",
      teamOrderBefore === teamOrderAfter
    );
    check(
      "with both of those visible notes actually in the ranking, so the order is an order",
      teamOrderBefore.split(",").length === 2
    );

    // Channel three: the same reordering through `rank` rather than `idf`. In
    // v1 this was the channel filtering could not close — PageRank is computed
    // once at index time over the whole link graph and stored on the doc — so it
    // had to be recomputed on the visible subgraph, and held by its own check.
    // v2 answers it by not having it: the link graph is global and a global
    // graph needs every shard in memory at maintenance time, which is the exact
    // blowup sharding exists to remove, so every doc carries a neutral rank
    // (CONTRACT.md § v2 "Query"). The check stays and is now about the property
    // rather than about the recomputation: whatever the ranking is built from,
    // a private note citing a visible one must not move it. The two notes below
    // carry one term between them, so idf is a common factor and nothing but the
    // link graph could separate them.
    bucket.seed("2-areas/aa-bilby.md", "# Bilby east\n\nEastern BILBY survey.\n");
    bucket.seed("2-areas/zz-bilby.md", "# Bilby west\n\nWestern BILBY survey.\n");
    await convergeV2(bucketStore);
    const bilbyOrder = (text) =>
      (text.match(/^2-areas\/(?:aa|zz)-bilby\.md$/gm) || []).join(",");
    const teamBilbyBefore = bilbyOrder(await searchText(env, TEAM_TOKEN, { query: "bilby" }));
    // Private notes carrying no query term at all, so the only thing they can
    // move is the graph.
    for (let n = 0; n < 6; n += 1) {
      bucket.seed(
        `1-projects/vault/citation-${n}.md`,
        `# Citation ${n}\n\nSee [the west](../../2-areas/zz-bilby.md) for the private workup.\n`
      );
    }
    await convergeV2(bucketStore);
    const teamBilbyAfter = bilbyOrder(await searchText(env, TEAM_TOKEN, { query: "bilby" }));
    check(
      "and private notes citing a visible one do not promote it for a team connection",
      teamBilbyBefore === teamBilbyAfter && teamBilbyBefore.split(",").length === 2
    );

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
    check(
      "a backfill that ran out of budget says so, in the floor language the census uses",
      bigFirst.includes("still catching up")
    );
    check(
      "and the floor carries no count, which would be a fact about notes the caller may not see",
      !/still catching up[^\]]*\d/.test(bigFirst)
    );

    big.resetCounts();
    const bigSecond = await searchText(env, BIG_TOKEN, { query: "widget" });
    check(
      "the second search on that context is bounded too, and continues the backfill",
      // Two writes rather than v1's one, and which two is the point: the shard
      // the backfill landed in, then the manifest over it. A pass that wrote
      // only the manifest would be vouching for docs no shard holds.
      big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET && big.counts.put === 2
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
    // from empty, grow again, forever. A brain whose capped index crosses the
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

    // -- the budget is a deployment setting, bounded ------------------------
    //
    // The default assumes the free tier's 50-subrequest ceiling; a paid-plan
    // worker gets 1000, and holding it to 40 there stretches a real brain's
    // first index across dozens of searches. `SEARCH_SUBREQUEST_BUDGET` in the
    // environment raises it; garbage must fall back to the default rather than
    // take search down.
    removeV2Index(big);
    big.resetCounts();
    const bigBudget = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "200" },
      BIG_TOKEN,
      { query: "widget" }
    );
    // One *request*, not one interactive pass, and the difference is the point.
    // An interactive search spends `INTERACTIVE_BACKFILL_OPS` note reads and no
    // more, because the raised budget authorizes ~580 of them and that is 40-60
    // seconds of somebody waiting; the rest of the budget is spent on the same
    // sync after the response has gone out. So the answer this call returns is
    // honest about being drawn from a partial index, and the index is whole by
    // the time the invocation ends — which the next search reads.
    check(
      "a raised deployment budget indexes a 65-note context in one request",
      typeof bigBudget === "string" &&
        bigBudget.includes("still catching up") &&
        big.ops > SEARCH_SUBREQUEST_BUDGET
    );
    const bigSettled = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "200" },
      BIG_TOKEN,
      { query: "widget" }
    );
    check(
      "and the next search over it says nothing about catching up",
      typeof bigSettled === "string" && !bigSettled.includes("still catching up")
    );
    removeV2Index(big);
    big.resetCounts();
    const bigGarbage = await searchText(
      { ...env, SEARCH_SUBREQUEST_BUDGET: "not-a-number" },
      BIG_TOKEN,
      { query: "widget" }
    );
    check(
      "an unparseable budget var is the default, never a throw and never unbounded",
      typeof bigGarbage === "string" &&
        bigGarbage.includes("still catching up") &&
        big.ops - PRIVACY_MANIFEST_READ <= SEARCH_SUBREQUEST_BUDGET
    );

    // A backend whose listings carry no etag at all — Dropbox lists
    // `server_modified` and `size` and nothing else. The diff has to converge
    // on those two or the index is rebuilt from scratch on every single search,
    // which is the failure this whole module exists to remove wearing a
    // different hat.
    const dropboxish = createBucket();
    dropboxish.listEtags = false;
    dropboxish.seed("privacy.md", PRIVACY_MANIFEST);
    dropboxish.seed("1-projects/one.md", "# One\n\nA NARWHAL swims past.\n");
    dropboxish.seed("1-projects/two.md", "# Two\n\nAnother NARWHAL entirely.\n");
    const dropboxStore = new R2Store(dropboxish);
    const firstPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    dropboxish.resetCounts();
    const secondPass = await syncIndex(dropboxStore, { budget: createSearchBudget(50) });
    check(
      "a listing with no etag still converges, on the timestamp and size it does report",
      firstPass.index.docs.size === 2 &&
        secondPass.pending === 0 &&
        dropboxish.counts.noteGets.length === 0 &&
        dropboxish.counts.put === 0 &&
        searchIndex(secondPass.index, "narwhal").length === 2
    );

    // -- (i) the index path fails outright, and the scan catches the call ----
    broken.seed("privacy.md", PRIVACY_MANIFEST);
    for (let n = 0; n < 40; n += 1) {
      broken.seed(
        `1-projects/fallback/note-${String(n).padStart(3, "0")}.md`,
        `# Fallback ${n}\n\nThis one mentions the LIGHTHOUSE marker.\n`
      );
    }
    // The manifest is unreadable: a storage error on the very first call of the
    // sync — which is what a revoked key or a 500 looks like here, and it is the
    // *first* op v2 spends, so nothing downstream of it gets a chance to paper
    // over the failure.
    broken.failGetKeys.add(MANIFEST_KEY);
    broken.resetCounts();
    const fallback = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a search whose index is unreachable answers from the capped scan instead of throwing",
      typeof fallback === "string" && fallback.includes("1-projects/fallback/note-")
    );
    check(
      "the capped scan says what it scanned rather than implying it saw everything",
      /scanned \d+ of \d+\+? notes/.test(fallback)
    );
    check(
      "and the recovery path is bounded too — this is where the original bug lived",
      broken.ops < SUBREQUEST_LIMIT
    );

    // A wide bucket, not just a deep one. The scan's listing walks every
    // top-level folder, and listings are store ops like any other: enough
    // folders is enough subrequests before the first note is read, so an
    // un-counted listing re-creates the original failure through the recovery
    // route. The budget has to cut the walk, and the cut has to surface as a
    // floor, not as a precise-looking total.
    for (let n = 0; n < 45; n += 1) {
      broken.seed(`area-${String(n).padStart(2, "0")}/note.md`, "# Wide\n\nLIGHTHOUSE here too.\n");
    }
    broken.resetCounts();
    const wide = await searchText(env, BROKEN_TOKEN, { query: "lighthouse" });
    check(
      "a wide bucket cannot spend the recovery path past the budget on listings alone",
      typeof wide === "string" && broken.ops < SUBREQUEST_LIMIT
    );
    check(
      "and a budget-cut walk reports its total as a floor",
      /of \d+\+ notes/.test(wide)
    );
    broken.failGetKeys.delete(SEARCH_INDEX_KEY);
  } finally {
    restore?.();
  }
}
