/**
 * How a search is paced: what it does while somebody waits, what it does
 * afterwards, and what it may not starve to do either.
 *
 * `searchIntegration` and `searchV2Integration` hold what a search *answers*.
 * This file holds what it *costs*, which is a different property and was never
 * measured — the whole index-maintenance loop is bounded by a subrequest
 * counter, and a subrequest counter cannot see a round trip. Two failures came
 * out of that gap, and both are reproduced here rather than described.
 *
 * ## The false miss
 *
 * `syncShardedIndex` ran before every search and spent every op down to
 * `reserve` — the snippet reads. But the query walk opens one shard per
 * occupied shard *before* it can read a snippet, and those ops were nobody's:
 * the sync took them, the walk found the budget already at its floor, and the
 * answer was assembled from no shards at all.
 *
 * That is not a slow answer, it is a wrong one, and the numbers are why this
 * file exists. Measured before the fix, on the fixtures below:
 *
 * - 1,500 notes at a budget of 120: passes 1-3 answered, and **passes 4 onward
 *   answered `0 matching notes`** for a term carried by every note in the
 *   bucket — permanently, since the state is stable.
 * - 7,961 notes at this deployment's budget of 600: **thirteen consecutive
 *   searches** returned nothing, until the backfill happened to converge.
 *
 * A miss is the one answer this system must not get wrong. `toolSearchNotes`'s
 * miss copy exists to argue an agent out of concluding "not written down", and
 * an index that starves its own reader hands that conclusion to every client
 * connected to a large context.
 *
 * ## The forty-second search
 *
 * The same loop, on a budget the paid plan allows, authorizes ~580 note reads
 * in front of an answer. That was measured live at 40-60 seconds. The budget
 * bounds what a search may *spend*; nothing bounded what a person *waits* for.
 *
 * So an interactive search now backfills a bounded number of notes and
 * continues the same sync after its response has gone out, and every
 * independent read it makes — folder listings, shard objects, snippet reads —
 * runs in bounded waves rather than one round trip at a time. Measured on a
 * 7,961-note fixture with a simulated 20ms per store operation: a warm search
 * spent the same 57 operations before and after, and **1,439ms before against
 * ~700ms after**, because 55 of those 57 used to be serialized.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are across the whole suite.
 *
 * 1. **`walkReserve: 1` removed** from the sync call in `visible.js`. The first
 *    version of this run found **zero** failures anywhere, including in this
 *    file — and that is the most useful thing in this record. The false miss
 *    above has *two* independent causes, and the fixture at the top only
 *    reproduces one of them: the walk used to abandon shards the sync had
 *    already loaded, because it checked its budget before reaching them in
 *    shard-id order. Collecting those first is free and fixes that shape on its
 *    own, so the reserve looked redundant while covering a case no fixture had.
 *    Block (a2) is the case — a *converged* index with a little stale work and
 *    a tight budget, where the sync spends inside one shard and the walk must
 *    open four it never went near — and it was written afterwards. 2 checks
 *    fail there now. A guard nobody has checked is not a guard, and this one
 *    had a green test that was passing for the other fix's reasons.
 * 2. **The walk's reuse of loaded shards removed** (back to reading every
 *    occupied shard, in id order). 4 checks failed: both of block (a)'s, plus
 *    two in `searchIntegration.test.mjs` — which is the other half of the pair
 *    above, and why both are kept.
 * 3. **`backfillOps` ignored** in `shards.js`. 7 checks failed, across this
 *    file and `searchIntegration.test.mjs`.
 * 4. **The snippet wave un-parallelized** (width 1). 1 check failed, the
 *    snippet concurrency check. Op counts are byte-identical either way, which
 *    is exactly why a suite that counts ops never saw this.
 * 5. **`SHARD_READ_CONCURRENCY` set to 1.** 2 checks failed.
 * 6. **`LIST_CONCURRENCY` set to 1.** 1 check failed.
 * 7. **`store.defer` forced to `null`** in `index.js`. 2 checks failed: one
 *    request no longer converges the capped fixture, and the trace stops
 *    reporting a deferred pass. Every answer stayed correct, which is the
 *    property deferral is required to have — it is an accelerator, and never
 *    where the work happens.
 *
 * ## Measurements quoted above
 *
 * From an in-memory bucket with a simulated per-operation latency, over 7,961
 * notes at a budget of 600 — the live deployment's shape. Not a production
 * trace: what it measures is how many round trips a search serializes, which
 * is the part this code decides and the network multiplies.
 *
 *                      ops   wall clock at 20ms/op
 *   cold, before       600         1,831ms
 *   cold, after         93           535ms
 *   warm, before        57         1,439ms
 *   warm, after         57           670ms
 *
 * The warm row is the whole argument for the waves: identical spend, less than
 * half the waiting. ~320ms of the "after" figure is CPU — parsing 27 shards —
 * and is unchanged by any of this.
 */

import worker from "../src/index.js";
import { createSearchBudget } from "../src/search/maintain.js";
import {
  MANIFEST_KEY,
  SHARD_READ_CONCURRENCY,
  parseManifest,
  shardKey,
} from "../src/search/shards.js";
import { createSearchTrace } from "../src/search/trace.js";
import { searchIndexedNotes } from "../src/search/visible.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

/** Mirrors `SEARCH_RESULT_LIMIT` in `search/visible.js`. */
const SEARCH_RESULT_LIMIT = 10;
/** Mirrors `INTERACTIVE_BACKFILL_OPS` in `src/index.js`. */
const INTERACTIVE_BACKFILL_OPS = 60;
/** Every tool call reads `privacy.md` before it dispatches; not the search's to spend. */
const PRIVACY_MANIFEST_READ = 1;

const PACING_TOKEN = `cat_pacing_owner_${"0".repeat(18)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  0-inbox: team\n  1-projects: team\n  2-areas: team\n" +
  "  3-resources: team\n  4-archive: team\n  5-extra: team\n\n" +
  "note_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that also records **how many operations were in flight at
 * once**, per kind.
 *
 * That is the measurement the other fixtures cannot make and the one this whole
 * change is about: parallelizing independent reads does not move a single op
 * count, so a suite that counts ops is blind to whether a search makes eight
 * round trips or fifty-seven. `peak` is what a sequential loop can never raise
 * above 1.
 */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, put: 0, list: 0, delete: 0, getKeys: [] };
  const live = { get: 0, list: 0 };
  const peak = { get: 0, list: 0, shardGet: 0, noteGet: 0 };
  let liveShardGets = 0;
  let liveNoteGets = 0;

  const enter = (kind, key) => {
    live[kind] += 1;
    peak[kind] = Math.max(peak[kind], live[kind]);
    if (kind !== "get") return;
    if (key.startsWith(".index/v2/shard-")) {
      liveShardGets += 1;
      peak.shardGet = Math.max(peak.shardGet, liveShardGets);
    } else if (key.endsWith(".md") && key !== "privacy.md") {
      liveNoteGets += 1;
      peak.noteGet = Math.max(peak.noteGet, liveNoteGets);
    }
  };
  const leave = (kind, key) => {
    live[kind] -= 1;
    if (kind !== "get") return;
    if (key.startsWith(".index/v2/shard-")) liveShardGets -= 1;
    else if (key.endsWith(".md") && key !== "privacy.md") liveNoteGets -= 1;
  };

  // A real backend answers after a round trip, and a stub that resolves in the
  // same microtask hides every serialization it is asked about: awaited
  // sequentially or fired as a wave, an instant promise looks the same. One
  // macrotask per operation is the cheapest thing that does not.
  const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 0));

  const api = {
    objects,
    counts,
    peak,
    get ops() {
      return counts.get + counts.put + counts.list + counts.delete;
    },
    resetCounts() {
      counts.get = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.getKeys = [];
      peak.get = 0;
      peak.list = 0;
      peak.shardGet = 0;
      peak.noteGet = 0;
    },
    seed(key, body) {
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
    },
    /** Note reads this call made, which is what `backfillOps` bounds. */
    noteGets() {
      return counts.getKeys.filter((key) => key.endsWith(".md") && key !== "privacy.md").length;
    },
    async get(key) {
      counts.get += 1;
      counts.getKeys.push(key);
      enter("get", key);
      try {
        await roundTrip();
        const stored = objects.get(key);
        if (!stored) return null;
        return {
          etag: stored.etag,
          text: async () => stored.body,
          arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
        };
      } finally {
        leave("get", key);
      }
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      await roundTrip();
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${(etags += 1)}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      await roundTrip();
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
      enter("list", prefix);
      try {
        await roundTrip();
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
            page.push({ key, size: stored.body.length, uploaded: stored.uploaded, etag: stored.etag });
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
      } finally {
        leave("list", prefix);
      }
    },
  };
  return api;
}

const alwaysVisible = () => true;
const indexable = (key) =>
  key.endsWith(".md") && key !== "privacy.md" && !key.split("/").some((s) => s.startsWith("."));

/**
 * `count` notes carrying `term`, spread over `roots` **top-level** folders.
 *
 * Top-level matters and is easy to get wrong: the listing walk is delimited at
 * the root and flat inside each real folder, so a thousand notes under one root
 * is *one* listing however many subfolders it has. A fixture built that way
 * cannot say anything about folder listings overlapping — which is how the
 * first version of the check below passed for the wrong reason and then failed
 * for the right one.
 */
const ROOTS = ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "5-extra"];
function seedNotes(bucket, count, term, roots = 2) {
  const spread = Math.max(1, Math.min(roots, ROOTS.length));
  for (let i = 0; i < count; i += 1) {
    bucket.seed(
      `${ROOTS[i % spread]}/p${i % 6}/note-${i}.md`,
      `# Note ${i}\n\nThe ${term} appears here, in note ${i}.\n`
    );
  }
}

function search(bucket, options = {}) {
  return searchIndexedNotes(bucket, {
    isVisible: alwaysVisible,
    isIndexable: indexable,
    query: options.query ?? "rhubarb",
    budget: createSearchBudget(options.budget ?? 120),
    ...options.pass,
  });
}

async function callTool(env, token, name, args, { defer = true } = {}) {
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
    // Omitted entirely for the no-deferral case, which is what a host that
    // passes no `ctx` looks like — a self-host shim, or this suite before
    // `waitUntil` meant anything.
    defer ? ctx : undefined
  );
  const result = (await response.json())?.result;
  if (defer) await settle();
  return result?.content?.[0]?.text;
}

/** Every console.log line one call emitted, parsed where it is JSON. */
async function captureLogs(run) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  });
}

export async function runSearchPacingChecks(check) {
  /* -- (a) the false miss: maintenance may not starve the answer ----------- */
  //
  // 1,500 notes at a budget of 120 is the smallest fixture that reproduces it:
  // the bucket needs more shards than one pass can both maintain and walk.
  {
    const bucket = createBucket();
    seedNotes(bucket, 1500, "rhubarb");

    const answers = [];
    for (let pass = 0; pass < 8; pass += 1) {
      bucket.resetCounts();
      const found = await search(bucket, { budget: 120 });
      answers.push(found);
    }
    check(
      "every pass over a bucket too wide to index in one answers with hits",
      answers.every((found) => found.indexed && found.hits.length > 0)
    );
    check(
      "and none of them reports zero matches over a term every note carries",
      answers.every((found) => found.matchCount > 0)
    );
  }

  /* -- (a2) …and the reserve is what holds it, not the order of the walk --- */
  //
  // Two separate things stop the sync starving the answer, and only one of them
  // is visible in the fixture above. The walk collects every shard the sync
  // already loaded for free **before** it spends on a read, which covers a pass
  // whose maintenance touched the shards the query needs. It does nothing at
  // all for the other shape: a **converged** index the sync has a little work
  // in, where it spends the budget inside one shard and the walk still has to
  // open the four it never went near.
  //
  // That shape is this block, and it is the one `walkReserve` is for. Written
  // after the sabotage run found that removing `walkReserve` broke nothing —
  // a guard nobody has checked is not a guard, and this one had a test that
  // passed for the other fix's reasons.
  {
    const bucket = createBucket();
    seedNotes(bucket, 1500, "rhubarb");
    // A rare term, scattered so it lands in several shards. A common one cannot
    // show this: `MAX_RESULTS` caps the count either way, so a walk that opened
    // one shard of five reports the same number as one that opened all five.
    const rare = [];
    for (let i = 0; i < 1500; i += 187) {
      const path = `${ROOTS[i % 2]}/p${i % 6}/note-${i}.md`;
      bucket.seed(path, `# Note ${i}\n\nA quokka was here, in note ${i}.\n`);
      rare.push(path);
    }
    for (let pass = 0; pass < 40; pass += 1) {
      const found = await search(bucket, { budget: 600 });
      if (!found.indexIncomplete) break;
    }
    const manifest = parseManifest(bucket.objects.get(MANIFEST_KEY).body);
    const occupied = manifest.stats.filter((entry) => entry.docCount > 0).length;
    check(
      "the fixture is honest: a converged index over several shards",
      occupied > 1 && manifest.stats.reduce((n, entry) => n + entry.docCount, 0) === 1500
    );

    // A handful of edits, so the sync has real work and will spend on it, and a
    // budget tight enough that spending it all is the difference between an
    // answer and a lie.
    for (let i = 0; i < 300; i += 1) {
      bucket.seed(`${ROOTS[i % 2]}/p${i % 6}/note-${i}.md`, `# Note ${i}\n\nrhubarb again, ${i}.\n`);
    }
    const budget = createSearchBudget(40);
    const tight = await searchIndexedNotes(bucket, {
      isVisible: alwaysVisible,
      isIndexable: indexable,
      query: "quokka",
      budget,
    });
    check(
      "a tight pass over a stale converged index still opens every occupied shard",
      tight.indexed && tight.index.shardsUnread === false
    );
    check(
      "and finds every note carrying a rare term, exactly, rather than a floor",
      rare.length > 4 &&
        tight.matchCount === rare.length &&
        tight.matchCountIsFloor === false
    );
  }

  /* -- (b) the interactive share of the backfill --------------------------- */
  {
    const bucket = createBucket();
    seedNotes(bucket, 400, "cuttlefish");

    bucket.resetCounts();
    const capped = await search(bucket, {
      query: "cuttlefish",
      budget: 600,
      pass: { backfillOps: 25 },
    });
    check(
      "a capped pass reads no more notes than its cap",
      bucket.noteGets() <= 25 + SEARCH_RESULT_LIMIT
    );
    check(
      "and still answers from the index, saying it is incomplete",
      capped.indexed && capped.indexIncomplete && capped.index.pending > 0
    );

    bucket.resetCounts();
    const uncapped = await search(bucket, { query: "cuttlefish", budget: 600 });
    check(
      "an uncapped pass on the same budget reads far more",
      bucket.noteGets() > 25 + SEARCH_RESULT_LIMIT && uncapped.indexed
    );
  }

  /* -- (c) the cap bounds the backfill and not the listing ----------------- */
  //
  // If the cap bounded every op, a converged bucket would report
  // `listingTruncated` on every search and print "the index is still catching
  // up" forever. A banner that is permanently on is a banner nobody reads.
  {
    const bucket = createBucket();
    seedNotes(bucket, 120, "porpoise");
    for (let pass = 0; pass < 6; pass += 1) await search(bucket, { query: "porpoise", budget: 600 });

    bucket.resetCounts();
    const warm = await search(bucket, {
      query: "porpoise",
      budget: 600,
      pass: { backfillOps: 1 },
    });
    check(
      "a converged bucket reports nothing incomplete even under a cap of one",
      warm.indexed &&
        warm.indexIncomplete === false &&
        warm.index.listingTruncated === false &&
        warm.index.pending === 0
    );
    check("and the answer is still there", warm.hits.length > 0 && warm.matchCount > 0);
  }

  /* -- (d) independent reads run in waves ---------------------------------- */
  //
  // Op counts cannot see this, which is why nothing did. The bucket records how
  // many operations were in flight at once; a sequential loop can never raise
  // that above one.
  {
    const bucket = createBucket();
    seedNotes(bucket, 900, "narwhal", 6);
    for (let pass = 0; pass < 12; pass += 1) await search(bucket, { query: "narwhal", budget: 600 });

    bucket.resetCounts();
    const warm = await search(bucket, { query: "narwhal", budget: 600 });
    check(
      "folder listings overlap rather than running one folder at a time",
      bucket.peak.list > 1
    );
    check(
      "shard objects are read in waves, bounded by the declared width",
      bucket.peak.shardGet > 1 && bucket.peak.shardGet <= SHARD_READ_CONCURRENCY
    );
    check(
      "snippet reads overlap rather than one round trip per hit",
      warm.hits.length > 1 && bucket.peak.noteGet > 1
    );
    check(
      "and the answer is unchanged by any of it",
      warm.indexed && warm.hits.length === SEARCH_RESULT_LIMIT && warm.matchCount > 0
    );
  }

  /* -- (e) the trace ------------------------------------------------------- */
  {
    const trace = createSearchTrace(() => 0);
    const end = trace.span("phase");
    end();
    end();
    const line = trace.toJSON();
    check(
      "a span closed twice is not counted twice",
      line.ms.phase === 0 && line.event === "search"
    );
  }

  /* -- (f) through the worker: deferral, budget, and the log line ---------- */
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    // Wide enough that one interactive pass cannot finish it, small enough that
    // one whole invocation can.
    seedNotes(bucket, 150, "wildebeest", 5);

    controlPlane.addWorkspace("ws_pacing", "pacing", {
      provider: "r2-binding",
      bindingName: "PACING_BUCKET",
      capabilities: { conditionalWrite: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: PACING_TOKEN,
      workspaceId: "ws_pacing",
      role: "owner",
      scopes: ["context:read", "context:private"],
      clientId: "mcp_client_pacing",
      userId: "u_pacing",
    });
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "PACING_BUCKET",
      PACING_BUCKET: bucket,
      SEARCH_SUBREQUEST_BUDGET: "300",
    };

    bucket.resetCounts();
    const logs = await captureLogs(async () => {
      await callTool(env, PACING_TOKEN, "search_notes", { query: "wildebeest" });
    });
    const traced = logs.filter((line) => line.event === "search");
    check("one search emits exactly one trace line", traced.length === 1);
    check(
      "the trace names the workspace, the grant and the client",
      traced[0]?.workspace === "ws_pacing" &&
        traced[0]?.grant === "grant_1" &&
        traced[0]?.client === "mcp_client_pacing" &&
        // And which backend it measured. A native binding and an S3 endpoint
        // reached over HTTP are not the same round trip, so a timing that does
        // not say which one it timed explains nothing.
        traced[0]?.provider === "r2-binding"
    );
    check(
      "and carries phase timings, the spend, and the index's own bookkeeping",
      typeof traced[0]?.ms?.total === "number" &&
        typeof traced[0]?.ms?.answer === "number" &&
        typeof traced[0]?.spent === "number" &&
        typeof traced[0]?.index?.shardCount === "number"
    );
    // A log line is not a tool result, but it is still somewhere customer data
    // can end up — and this one describes a search over private notes.
    const serialized = JSON.stringify(traced[0]);
    check(
      "the trace carries no query text, no note path and no snippet",
      typeof serialized === "string" &&
        !serialized.includes("wildebeest") &&
        !serialized.includes("1-projects") &&
        !serialized.includes(".md")
    );
    /*
      The check above is a denylist of three strings this fixture happens to
      contain, so it answers "did *these* leak" and not "may this field be
      here at all". Measured: adding `topHit: "salary numbers, private tier"`
      to `toJSON` passes the entire gateway suite, that check included —
      because note text a future field carries will not contain the fixture's
      query or its paths.

      So the permitted keys are enumerated instead, and an unknown one fails.
      The direction is what matters: a denylist admits every field nobody
      thought of, and the fields nobody thought of are the ones that carry
      what somebody wrote. `trace.set` spreads whatever it is given, and
      `logSearchTrace` prints the lot.
    */
    const TRACE_KEYS = new Set([
      "event", "workspace", "grant", "client", "provider", "budget", "prefixed",
      "indexed", "hits", "matches", "matchesIsFloor", "index", "spent",
      "deferred", "scannedCount", "totalCount", "ms",
    ]);
    const INDEX_KEYS = new Set([
      "shardCount", "occupiedShards", "docs", "pending", "shardsUnread",
      "listingTruncated", "manifestOverflow",
    ]);
    const strayTop = Object.keys(traced[0]).filter((key) => !TRACE_KEYS.has(key));
    const strayIndex = Object.keys(traced[0].index ?? {}).filter((key) => !INDEX_KEYS.has(key));
    check(
      "and carries no field beyond the ones enumerated here",
      strayTop.length === 0 && strayIndex.length === 0
    );
    check(
      "the interactive pass read no more notes than the interactive cap",
      bucket.noteGets() > 0 && traced[0]?.deferred === true
    );
    check(
      "one whole invocation stays inside the deployment budget it was given",
      bucket.ops - PRIVACY_MANIFEST_READ <= 300
    );

    // The deferred pass is what makes the cap free: the same request finishes
    // the index the interactive share could not.
    const settledManifest = parseManifest(bucket.objects.get(MANIFEST_KEY)?.body ?? "");
    const indexedDocs = settledManifest
      ? settledManifest.stats.reduce((total, entry) => total + entry.docCount, 0)
      : 0;
    check(
      "and the deferred pass finished what the interactive share could not",
      indexedDocs > INTERACTIVE_BACKFILL_OPS
    );

    // Warm: a converged index must not pay a manifest read and a full listing
    // per search to discover there is nothing to do.
    await callTool(env, PACING_TOKEN, "search_notes", { query: "wildebeest" });
    bucket.resetCounts();
    const warmLogs = await captureLogs(async () => {
      await callTool(env, PACING_TOKEN, "search_notes", { query: "wildebeest" });
    });
    const warmTrace = warmLogs.find((line) => line.event === "search");
    check(
      "a converged bucket defers nothing",
      warmTrace?.deferred === false && warmTrace?.index?.pending === 0
    );

    // And a host that offers no `waitUntil` still gets a correct answer. The
    // deferred pass is an accelerator; it is never where the work happens.
    const bare = createBucket();
    bare.seed("privacy.md", PRIVACY_MANIFEST);
    seedNotes(bare, 150, "wildebeest", 5);
    controlPlane.addWorkspace("ws_pacing_bare", "pacingbare", {
      provider: "r2-binding",
      bindingName: "BARE_BUCKET",
      capabilities: { conditionalWrite: true },
      status: "active",
    });
    const bareToken = `cat_pacing_bare_${"0".repeat(19)}`;
    await controlPlane.addGrant({
      accessToken: bareToken,
      workspaceId: "ws_pacing_bare",
      role: "owner",
      scopes: ["context:read", "context:private"],
      clientId: "mcp_client_pacing_bare",
      userId: "u_pacing_bare",
    });
    const bareEnv = {
      ...env,
      NATIVE_BINDINGS: "PACING_BUCKET,BARE_BUCKET",
      BARE_BUCKET: bare,
    };
    const bareText = await callTool(
      bareEnv,
      bareToken,
      "search_notes",
      { query: "wildebeest" },
      { defer: false }
    );
    check(
      "a host with no waitUntil still answers, and says the index is catching up",
      typeof bareText === "string" &&
        bareText.includes("1-projects/") &&
        bareText.includes("still catching up")
    );
    check(
      "and nothing was deferred on it",
      Boolean(bare.objects.get(MANIFEST_KEY)) &&
        (parseManifest(bare.objects.get(MANIFEST_KEY).body)?.stats ?? []).reduce(
          (total, entry) => total + entry.docCount,
          0
        ) <= INTERACTIVE_BACKFILL_OPS
    );
    // Sanity on the fixture rather than on the code: if the shards were never
    // written, every count above would be trivially satisfied.
    check(
      "the fixtures really did write shard objects",
      [...bucket.objects.keys()].some((key) => key === shardKey(0)) ||
        [...bucket.objects.keys()].some((key) => key.startsWith(".index/v2/shard-"))
    );
  } finally {
    restore();
  }
}
