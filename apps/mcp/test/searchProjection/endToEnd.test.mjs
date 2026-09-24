/**
 * The gateway, wired: a real search over a real bucket, copying into a real
 * database, through the worker's own deferred maintenance — a whole cold
 * context converging over several backfill passes.
 *
 * Split out of searchProjection.test.mjs — see that file for the full module
 * overview and sabotage-testing record, and fixtures.mjs for the shared D1
 * backend stub and constants.
 */

import {
  ACCOUNT_ID,
  API_TOKEN,
  CONTROL_PLANE_ORIGIN,
  DATABASE_ID,
  DESCRIPTOR,
  GATEWAY_SECRET,
  PRIVACY_MANIFEST,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createS3Backend,
  createWorkerCtx,
  longNote,
  s3Binding,
  worker,
} from "./fixtures.mjs";

const TOKEN = `cat_projection_${"0".repeat(24)}`;
const WS = "ws_projection";

/**
 * A whole cold context, converging.
 *
 * The budget is left at the deployment default rather than raised, so the R2
 * index takes several passes to build and the projection rides each of them —
 * which is the shape a real bucket has and the only shape in which "does the
 * backfill resume" means anything end to end.
 *
 * The failure case is exercised **first**, while the index is still behind,
 * and that ordering is a fact about the system rather than test convenience: a
 * pass runs only when the index says it is behind or its listing has aged past
 * `INDEX_RECONCILE_INTERVAL_MS`, so on a converged context inside that minute
 * there is no pass for a failure to happen in. The projection's freshness is
 * the R2 index's freshness, deliberately — one trigger, one listing, one diff.
 */
export async function runEndToEndChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();

  // Three installers over one global. Each hands anything it does not own to
  // the previous handler, so the order here is composition and not a race.
  const restoreS3 = s3.install();
  const restoreD1 = d1.install();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace(WS, "projection", s3Binding("projection-bucket", DESCRIPTOR));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_projection",
    userId: "user_projection",
  });

  const bucket = s3.bucketFor("projection-bucket");
  // The S3 stub holds `{body, etag}` per key — a bare string reads back as an
  // empty object, which is a fixture that silently tests nothing.
  const seed = (path, body, etag) => bucket.set(path, { body, etag });
  seed("privacy.md", PRIVACY_MANIFEST, "p0");
  /*
   * Two dozen notes rather than a handful, and that is the fixture doing real
   * work: with the deployment's default budget an index over six notes
   * converges on the first pass, so there is no window in which a bucket is
   * still being listed — which is exactly the window a note arriving mid-
   * backfill has to survive. At this size the R2 index takes several passes
   * and the projection rides each of them.
   */
  seed("index.md", "# Projection\n\nThe front page, private by default.\n", "p-index");
  const TEAM_NOTES = 10;
  const PRIVATE_NOTES = 14;
  for (let n = 0; n < TEAM_NOTES; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`1-projects/p${id}.md`, `# Project ${id}\n\nA quokka roster, part ${id}.\n`, `t${id}`);
  }
  for (let n = 0; n < PRIVATE_NOTES; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`2-areas/a${id}.md`, `# Area ${id}\n\nPrivate working notes, part ${id}.\n`, `a${id}`);
  }
  seed(
    "2-areas/health/vitals.md",
    "# Vitals\n\nA private diagnosis that only the owner may read.\n",
    "v0",
  );
  // index.md + the private folders + vitals, against the team folder.
  const SEEDED_NOTES = 1 + TEAM_NOTES + PRIVATE_NOTES + 1;

  // Recorded **and passed through**: `check` itself logs, so a recorder that
  // swallowed the stream would silence every assertion below and print a green
  // run that asserted nothing.
  const logs = [];
  const realLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((value) => String(value)).join(" "));
    realLog(...args);
  };

  async function search(query, budget) {
    const harness = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_notes", arguments: { query } },
        }),
      }),
      {
        CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
        GATEWAY_SECRET,
        ...(budget ? { SEARCH_SUBREQUEST_BUDGET: String(budget) } : {}),
      },
      harness.ctx,
    );
    const body = await response.json();
    await harness.settle();
    return { response, body };
  }

  async function write(path, content) {
    const harness = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "write_note",
            arguments: {
              path,
              content,
              visibility: "team",
              confirm_team_publish: true,
            },
          },
        }),
      }),
      {
        CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
        GATEWAY_SECRET,
      },
      harness.ctx,
    );
    const body = await response.json();
    await harness.settle();
    return { response, body };
  }

  async function collaborate(path, content) {
    const readHarness = createWorkerCtx();
    const read = await worker.fetch(
      new Request("https://gateway.test/collaboration", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      }),
      { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
      readHarness.ctx,
    );
    const base = await read.json();
    await readHarness.settle();
    const writeHarness = createWorkerCtx();
    const response = await worker.fetch(
      new Request("https://gateway.test/collaboration", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path, replacement: { expectedEtag: base.etag, text: content } }),
      }),
      { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET },
      writeHarness.ctx,
    );
    const body = await response.json();
    await writeHarness.settle();
    return { response, body };
  }

  const projectedCount = () => d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n;
  const progressReports = () =>
    controlPlane.calls.filter((call) => call.path === "/gateway/search-index/progress");

  try {
    // -- a database that refuses everything, on a context that has no index --
    d1.state.fail = 403;
    controlPlane.calls.length = 0;
    // Three, not one. The first search over a context with no index at all
    // spends its budget on the literal scan and the index's first pass, and a
    // projection pass with nothing left is a quiet no-op by design — so a
    // single search would be asserting the budget rather than the failure.
    let degraded = null;
    for (let round = 0; round < 3; round += 1) {
      // A note written while the index is still being built and the projection
      // is failing. What is asserted at the end is therefore not only a
      // backfill of a static bucket but one that moved underneath it.
      if (round === 1) seed("1-projects/gamma.md", "# Gamma\n\nA later quokka note.\n", "g0");
      degraded = await search("quokka");
    }
    check(
      "a refused search database does not fail the search",
      degraded.response.status === 200 && !degraded.body.result?.isError,
    );
    check(
      "the answer still comes back, from the R2 side",
      JSON.stringify(degraded.body).includes("1-projects/"),
    );
    check("and nothing was copied", projectedCount() === 0);
    const failures = progressReports()
      .map((call) => call.body.errorCode)
      .filter(Boolean);
    check("the failure is reported rather than swallowed", failures.includes("UNAUTHORIZED"));
    check(
      "as our code, never the provider's sentence",
      !JSON.stringify(controlPlane.calls).includes("not authorized") &&
        !JSON.stringify(controlPlane.calls).includes(ACCOUNT_ID),
    );
    d1.state.fail = null;

    // -- and then it converges ---------------------------------------------
    // -- one search, on a paid-plan budget, converges the whole backfill ----
    //
    // The point of the chain. A pass copies `D1_PASS_NOTE_CAP` notes at most,
    // so without it this single search would leave twenty-odd notes behind and
    // the owner would watch a counter creep one search at a time. The R2 index
    // is already converged here, so there is no sync in front of this: the
    // projection buys its own census and keeps going on its own.
    controlPlane.calls.length = 0;
    const projectionRequestsBefore = d1.requests.length;
    await search("quokka", 600);
    check(
      "one search converges a backfill no single pass could",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === SEEDED_NOTES + 1,
    );
    check(
      "which took more than one pass, chained inside the one invocation",
      d1.requests.length - projectionRequestsBefore > 0 &&
        SEEDED_NOTES + 1 > 20,
    );
    check(
      "and reported once at the end rather than once per link",
      progressReports().length === 1,
    );
    const reportsFromConvergence = progressReports().slice();

    // The control plane does its half: the row is `ready`, so the next binding
    // says so. That is what stops the projection re-asserting a fact nobody
    // asked about, and what stops it buying a census on every search.
    controlPlane.bindings.set(
      WS,
      s3Binding("projection-bucket", { ...DESCRIPTOR, state: "ready" }),
    );
    controlPlane.calls.length = 0;
    const settledRequests = d1.requests.length;
    const since = (from) => d1.requests.slice(from);
    const writes = (from) =>
      since(from).filter((request) => /^\s*(INSERT|DELETE|UPDATE|REPLACE)/i.test(request.sql));
    const reads = (from) =>
      since(from).filter((request) => /FROM notes_(private|team)_fts/i.test(request.sql));
    for (let round = 0; round < 4; round += 1) await search("quokka");
    check(
      "a converged projection copies nothing further",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === SEEDED_NOTES + 1,
    );
    /*
     * This check used to read `d1.requests.length === settledRequests` — "once
     * the control plane calls it ready, costs nothing at all" — and it was
     * true, for the worst possible reason: the projection was a write path
     * with no reader. Every note in the context had been copied into a
     * database that no search ever opened, and the suite asserted the silence
     * as if it were the feature.
     *
     * So it is split in two. The backfill really must go quiet once the row is
     * ready, and that is the first half. The second is that a search now
     * *asks*: a personal connection reads both tiers, so four searches make
     * eight reads and not one write.
     */
    check(
      "and the backfill stops writing entirely",
      writes(settledRequests).length === 0,
    );
    check(
      "while a search now actually asks the projection it filled",
      reads(settledRequests).length === 8,
    );
    check(
      "and asks it nothing else — no census, no cursor, no listing",
      since(settledRequests).length === reads(settledRequests).length,
    );
    check("and says nothing it has already said", progressReports().length === 0);

    // A note written after the projection becomes ready must be searchable
    // without waiting for the listing reconciliation clock or forcing a full
    // rebuild. This is the production failure that used to require turning
    // Fast Search off and on again: write_note changed the canonical bucket,
    // but no request told the ready projection about the new version.
    const liveWrite = await write(
      "1-projects/live-echidna.md",
      "# Live update\n\nThe echidna arrived after Fast Search was ready.\n",
    );
    check(
      "a post-activation note write succeeds",
      liveWrite.response.status === 200 && !liveWrite.body.result?.isError,
    );
    check(
      "and is written through to the ready projection",
      d1.rows("SELECT path FROM notes WHERE path = ?", ["1-projects/live-echidna.md"])
        .length === 1,
    );
    const liveAnswer = await search("echidna");
    check(
      "so the next Fast Search finds it without a rebuild",
      JSON.stringify(liveAnswer.body).includes("1-projects/live-echidna.md"),
    );

    const projected = d1.rows("SELECT path, visibility FROM notes ORDER BY path");
    check(
      "repeated searches copy the whole context into its own database",
      projected.length === SEEDED_NOTES + 2,
    );
    check(
      "including the note that arrived while the backfill was running",
      projected.some((row) => row.path === "1-projects/gamma.md"),
    );
    check(
      "privacy.md is plumbing and is not copied anywhere",
      projected.every((row) => row.path !== "privacy.md"),
    );

    // THE ONE THAT MATTERS, end to end: the engine that decides what a caller
    // may see is the engine that decided which table each note went in.
    check(
      "every private note is projected at the private tier",
      projected
        .filter((row) => !row.path.startsWith("1-projects/"))
        .every((row) => row.visibility === "private"),
    );
    check(
      "and every team note at the team tier",
      projected
        .filter((row) => row.path.startsWith("1-projects/"))
        .every((row) => row.visibility === "team"),
    );
    check(
      "a private note's text is nowhere in the team corpus",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 0,
    );
    check(
      "and no private path has a row in the team table at all",
      d1
        .rows("SELECT DISTINCT path FROM notes_team_fts")
        .every((row) => row.path.startsWith("1-projects/")),
    );
    check(
      "while the team notes are findable in the corpus they belong to",
      d1.rows(`SELECT DISTINCT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, [
        '"quokka"',
      ]).length === TEAM_NOTES + 1,
    );
    check(
      "the private ones are findable in theirs",
      d1.rows(`SELECT path FROM notes_private_fts WHERE notes_private_fts MATCH ?`, ['"private"'])
        .length > 0,
    );

    const reports = reportsFromConvergence.concat(progressReports());
    check("progress reaches the control plane", reports.length > 0);
    const last = reports[reports.length - 1].body;
    check(
      "with counts that match the rows in the database",
      last.notesIndexed === projectedCount(),
    );
    check("against the workspace the search ran in", last.workspaceId === WS);
    check("and it ends by saying the projection is ready", last.state === "ready");
    check("with nothing pending", last.notesPending === 0);

    const collaborativeWrite = await collaborate(
      "1-projects/p00.md",
      "# Project 00\n\nAn axolotl replaced the old roster through collaboration.\n",
    );
    const collaborativeSearch = await search("axolotl");
    check(
      "an accepted collaboration edit updates the ready search projection",
      collaborativeWrite.response.status === 200 &&
        collaborativeWrite.body.text.includes("axolotl") &&
        JSON.stringify(collaborativeSearch.body).includes("1-projects/p00.md"),
    );
    const bodies = JSON.stringify(reports.map((call) => call.body));
    check(
      "a progress report carries counts, never a path or a query",
      !bodies.includes("vitals") && !bodies.includes("quokka") && !bodies.includes("diagnosis"),
    );
    check(
      "and never a credential",
      !bodies.includes(API_TOKEN) && !bodies.includes(ACCOUNT_ID),
    );

    // D1 is a disposable derivative. Even three consecutive provider
    // refusals must not turn a successful canonical bucket write into a
    // failed write, and retrying must not leak provider details to the caller.
    d1.state.fail = 503;
    const requestsBeforeFailedWrite = d1.requests.length;
    const writeDuringOutage = await write(
      "1-projects/durable-platypus.md",
      "# Durable write\n\nThe platypus survives a projection outage.\n",
    );
    d1.state.fail = null;
    check(
      "a projection outage does not fail the canonical note write",
      writeDuringOutage.response.status === 200 && !writeDuringOutage.body.result?.isError,
    );
    check(
      "and the note remains safe in the bucket",
      bucket.get("1-projects/durable-platypus.md")?.body.includes("survives a projection outage"),
    );
    check(
      "the ready projection retries a transient refusal three times",
      d1.requests.length - requestsBeforeFailedWrite === 3,
    );
    check(
      "without returning provider or credential details",
      !JSON.stringify(writeDuringOutage.body).includes(API_TOKEN) &&
        !JSON.stringify(writeDuringOutage.body).includes(ACCOUNT_ID) &&
        !JSON.stringify(writeDuringOutage.body).includes(DATABASE_ID),
    );

    // -- the token never escapes -------------------------------------------
    const everything = logs.join("\n");
    check("the write token is in no log line", !everything.includes(API_TOKEN));
    check("nor is the account or database id", !everything.includes(ACCOUNT_ID));
    check(
      "the projection logs a line an operator can read",
      logs.some((line) => line.includes("search-projection")),
    );
    check(
      "and that line carries no note path",
      logs
        .filter((line) => line.includes("search-projection"))
        .every((line) => !line.includes("vitals") && !line.includes("1-projects")),
    );
    const answer = await search("quokka");
    check(
      "the token is in no tool response either",
      !JSON.stringify(answer.body).includes(API_TOKEN),
    );

    // -- a search never waits on the projection ----------------------------
    // Every request above ran with a real `waitUntil`, and `settle()` is what
    // waited for the deferred half. The response was already assembled before
    // any of it: the check that says so is that the answer came back at all
    // while the database was refusing every statement, above.
    check(
      "the search answered before the projection did any of its work",
      logs.findIndex((line) => line.includes('"event":"search"')) <
        logs.findIndex((line) => line.includes("search-projection")),
    );

    // -- fast search off is the normal case, and costs nothing -------------
    controlPlane.bindings.set(WS, s3Binding("projection-bucket", null));
    const before = d1.requests.length;
    seed("1-projects/epsilon.md", "# Epsilon\n\nA note about bilbies.\n", "p8");
    for (let round = 0; round < 3; round += 1) await search("bilbies");
    check("a binding with no searchIndex projects nothing at all", d1.requests.length === before);
    check(
      "and the search works exactly as it did before",
      JSON.stringify((await search("bilbies")).body).includes("epsilon.md"),
    );
  } finally {
    console.log = realLog;
    restoreControlPlane();
    restoreD1();
    restoreS3();
    d1.close();
  }
}
