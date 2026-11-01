/**
 * The pacing checks that run with the control-plane stub installed: a search through
 * the worker, its deferral, its budget and the log line it writes. The rest of the
 * pacing checks are in searchPacing.test.mjs.
 */

import { MANIFEST_KEY, parseManifest, shardKey } from "../src/search/shards.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub.mjs";
import {
  INTERACTIVE_BACKFILL_OPS,
  PRIVACY_MANIFEST_READ,
  PACING_TOKEN,
  PRIVACY_MANIFEST,
  createBucket,
  seedNotes,
  search,
  callTool,
  captureLogs,
} from "./searchPacingFixtures.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

export async function runSearchPacingControlPlaneChecks(check) {
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
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
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
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "PACING_BUCKET",
      PACING_BUCKET: bucket,
      SEARCH_SUBREQUEST_BUDGET: "300",
    };
    // The census is the tree's names, never the bucket's listing (`search/shards/listing.js`).
    controlPlane.serveTreesFrom(env);

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
        // The first search over a bucket with no index answers from the scan,
        // so what it reports is the scan's own counts. The `index` block
        // belongs to an indexed answer and is asserted on the warm one below.
        typeof traced[0]?.scannedCount === "number"
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
      "maintain", "scannedCount", "totalCount", "ms",
      // The fast path's four, and every one is a boolean or a count.
      // `fastCandidates` counts rows the projection returned *before* the
      // privacy filter and `fastVisible` after it, so their difference is how
      // many matches this caller may not read — which is the signal an
      // operator needs to tell "the projection is empty" from "the projection
      // matched and privacy filtered all of it", and is exactly the
      // subtraction that must never be RENDERED. `index.docs` is already in
      // this trace on the same terms (`visible.js`: "Never rendered").
      "fast", "fastCandidates", "fastVisible", "fastError",
    ]);
    const INDEX_KEYS = new Set([
      "shardCount", "occupiedShards", "shardsRead", "routed", "docs", "pending",
      "listedAt", "shardsUnread", "listingTruncated",
    ]);
    // `ms` is a third level and was missed on the first pass, which is the
    // same mistake one layer down: `trace.span(name)` writes into it, so its
    // keys are as unbounded as the top level's were. Measured — a field
    // planted inside `ms` passed the whole suite while the two sets below
    // were being called "both levels".
    const MS_KEYS = new Set(["answer", "scan", "fast", "total"]);
    const strayTop = Object.keys(traced[0]).filter((key) => !TRACE_KEYS.has(key));
    const strayIndex = Object.keys(traced[0].index ?? {}).filter((key) => !INDEX_KEYS.has(key));
    const strayMs = Object.keys(traced[0].ms ?? {}).filter((key) => !MS_KEYS.has(key));
    check(
      "and carries no field beyond the ones enumerated here",
      strayTop.length === 0 && strayIndex.length === 0 && strayMs.length === 0
    );
    check(
      "the whole of the indexing happened behind the response",
      bucket.noteGets() > 0 && traced[0]?.maintain === "deferred"
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
      "a converged bucket, freshly listed, starts no pass at all",
      warmTrace?.maintain === "none" &&
        warmTrace?.index?.pending === 0 &&
        typeof warmTrace?.index?.shardCount === "number"
    );

    // And a host that offers no `waitUntil` still gets a correct answer. The
    // deferred pass is an accelerator; it is never where the work happens.
    const bare = createBucket();
    bare.seed("privacy.md", PRIVACY_MANIFEST);
    seedNotes(bare, 150, "wildebeest", 5);
    controlPlane.addWorkspace("ws_pacing_bare", "pacingbare", {
      provider: "r2-binding",
      bindingName: "BARE_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
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
    controlPlane.serveTreesFrom(bareEnv);
    const bareText = await callTool(
      bareEnv,
      bareToken,
      "search_notes",
      { query: "wildebeest" },
      { defer: false }
    );
    check(
      "a host with no waitUntil still answers, and still builds the index",
      typeof bareText === "string" &&
        /^\S+\/note-\d+\.md$/m.test(bareText) &&
        bare.objects.has(MANIFEST_KEY)
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
        [...bucket.objects.keys()].some((key) => key.startsWith(".context/search/v2/shard-"))
    );
  } finally {
    restore();
  }
}
