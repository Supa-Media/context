/**
 * THE READ: a search actually answered out of the projection.
 *
 * Split out of searchProjection.test.mjs — see that file for the full module
 * overview and sabotage-testing record, and fixtures.mjs for the shared D1
 * backend stub and constants.
 */

import {
  API_TOKEN,
  CONTROL_PLANE_ORIGIN,
  DESCRIPTOR,
  GATEWAY_SECRET,
  MAX_RESULTS,
  PRIVACY_MANIFEST,
  S3_ENDPOINT,
  answerFromProjection,
  createControlPlaneStub,
  createD1Backend,
  createD1Client,
  createS3Backend,
  createWorkerCtx,
  longNote,
  projectPass,
  s3Binding,
  searchProjection,
  worker,
} from "./fixtures.mjs";


/* ========================================================================
 * THE READ: a search actually answered out of the projection.
 *
 * Everything above proves notes reach the database. Until this section existed
 * nothing proved anybody ever read one back — `search/d1/query.js` was
 * imported by its own test and by nothing in `src/`, so every search in
 * production was answered by the R2 shard index while the projection filled
 * beside it and was never opened. "Fast search" was a write path.
 *
 * Six questions, and the middle two are the ones that would be a breach:
 *
 *  1. Does the fast path answer without touching the bucket? That is the
 *     latency claim: no shard walk, no note read per hit.
 *  2. Does it find what the R2 index provably cannot — a term past
 *     `NOTE_INDEX_CHAR_CAP`? That is the recall claim, and it is the reason
 *     the projection is worth its cost at all.
 *  3. **Can a team connection read a private note out of it?** The projection
 *     holds every note in the context at both tiers. One wrong table in
 *     `tablesForTier`, or a filter applied to the wrong list, and a team
 *     member's search returns the owner's private notes.
 *  4. **Does live `privacy.md` beat the tier a row was stored at?** A note
 *     made private a minute ago still has team-tier rows until the next
 *     backfill pass moves them. The table split does not close that window;
 *     `canSee` does, on every path that leaves.
 *  5. Does a refused database still leave a working search? It is the reader
 *     now as well as the writer, so there are two ways to fail a search that
 *     did not exist before.
 *  6. Does a miss fall through rather than answering "(no matches)"? A
 *     projection is a derivative and can be behind; an empty answer from it
 *     must never be reported as an empty context.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts as measured.
 *
 *   `indexIsBehind` always answering "no"                                12
 *   `tablesForTier("team")` also returning the private table              5
 *   the fast path never consulted at all                                  7
 *   `fastSearchAnswer` skipping the `canSee` filter                       2
 *   `fastSearchAnswer` counting candidates instead of visible notes       1
 *   `fastSearchAnswer` ignoring `state`, serving a filling projection     1
 *   `searchProjection` never setting `truncated` on a full page           1
 *   `searchProjection` counting the cap across tables, not per table      1
 *   a `D1Error` on the read path escaping into the response               1
 *   a miss answering "(no matches)" instead of falling through            1
 *   `mergeHits` sliced to the display limit before the privacy filter     1
 *   a snippet mark put back, either side                                  1
 *   the title dropped from the projected row, or from the SELECT          1
 *
 * Seven of those rows are covered by the six sentences below, because six of
 * them measured ZERO on the first run and the fixture had to be changed before
 * they measured anything:
 *
 *  - **`canSee` reddens two checks, and for one of them it always did.** A
 *    team caller never reaches `2-areas/vitals.md` even with the filter gone,
 *    because a private note's rows are not in the team table for the query to
 *    return — that is the split doing its job. What the filter is for is the
 *    stale-tier window, and both failures are in it: the path, and the count.
 *  - **The COUNT was the same attack through a different field, and it
 *    reddened nothing.** `serve.js` names the subtraction attack about the
 *    slice, and the slice was guarded; `matchCount` computed from
 *    `result.notes.length` instead of `visible.length` measured ZERO, because
 *    no query in the fixture matched both a note the caller may read and one
 *    they may not — so the two numbers were never different. A second team
 *    note in the stale-tier window is what made it observable, and what it
 *    prints is `2 matching notes — the 1 best shown`.
 *  - **The pre-filter slice reddened nothing** until twelve more notes were
 *    seeded. With two matching notes the display limit and the match count are
 *    the same number, so slicing before the filter was invisible.
 *  - **A snippet mark reddened nothing** until the check stopped looking for a
 *    phrase and started looking the quoted line up in the note it names: the
 *    mark lands on the matched term, so every phrase after it survives.
 *  - **Dropping the title reddened nothing** until a note with no body was
 *    seeded. The title is only rendered when the snippet is empty, so until
 *    one note had an empty body the column was carried for nobody.
 *
 * **And one is still not proved, said out loud rather than left as a zero.**
 * `matchCountIsFloor`'s `truncated` half is watched at its source — a full
 * page setting the flag — but not through `fastSearchAnswer`, which composes
 * it: dropping `result.truncated` from that expression reddens NOTHING,
 * because reaching it needs a query returning 200 chunk rows from one table
 * and no fixture here is that large. `truncated` is a one-bit pre-filter
 * signal in the same family as the count above, so it is worth a fixture; it
 * is not worth 200 notes today.
 *
 *  - **The two `searchProjection` rows reddened nothing either**, and theirs
 *    are the only numbers in this table that do NOT come from a search:
 *    tripping the cap needs a table to return 200 rows and the largest
 *    single-table return in this file is 14, so both are driven at
 *    `searchProjection` with a stub client and a small `chunkCap`. A red on
 *    either has not been near the gateway.
 *
 * A guard nobody has checked is not a guard, and six of these had not been.
 * ====================================================================== */

/**
 * A *read* of the projection, which a `DELETE FROM notes_team_fts` is not.
 *
 * The first draft of this matched `FROM notes_team_fts` and every backfill
 * delete matched it too, so "a filling projection is not read from" was
 * asserting that the backfill does not run — which it plainly does. A verb
 * this loose is how a check ends up green for the wrong reason.
 */
const PROJECTION_READ = /^\s*SELECT[\s\S]*FROM notes_(private|team)_fts/i;

const SERVE_TOKEN_OWNER = `cat_serve_own_${"0".repeat(20)}`;
const SERVE_TOKEN_TEAM = `cat_serve_team_${"0".repeat(19)}`;
const SERVE_WS = "ws_serve";
export async function runServeChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();

  const restoreS3 = s3.install();
  const restoreD1 = d1.install();
  const restoreControlPlane = controlPlane.install();
  // Last in, so it sees every request first and hands on what it does not
  // count. The S3 stub records nothing of its own, and "did the answer read a
  // note out of the bucket" is the whole latency claim.
  const noteReads = [];
  const indexReads = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(S3_ENDPOINT) && (init?.method ?? "GET").toUpperCase() === "GET") {
      const key = decodeURIComponent(new URL(url).pathname.split("/").slice(2).join("/"));
      // The manifest and the shards. Counted apart from notes because the
      // manifest is the one index object a fast hit used to read in front of
      // the caller, and the claim below is that it no longer does.
      if (key.startsWith(".context/search/")) indexReads.push(key);
      // `privacy.md` is the manifest the privacy engine is built from and is
      // read once per request whatever answers it — counting it would make
      // "the answer read no note" false for every search ever made, which is
      // exactly what it did on the first run of this check.
      if (key.endsWith(".md") && !key.startsWith(".") && key !== "privacy.md") {
        noteReads.push(key);
      }
    }
    return previousFetch(input, init);
  };

  controlPlane.addWorkspace(SERVE_WS, "serve", s3Binding("serve-bucket", DESCRIPTOR));
  await controlPlane.addGrant({
    accessToken: SERVE_TOKEN_OWNER,
    workspaceId: SERVE_WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_serve_owner",
    userId: "user_serve_owner",
  });
  // No `context:private`: a member of the same context, at the team tier. The
  // isolation question is not about two tenants here — it is about two tiers
  // of one, which is the boundary the projection's table split exists for.
  await controlPlane.addGrant({
    accessToken: SERVE_TOKEN_TEAM,
    workspaceId: SERVE_WS,
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_serve_team",
    userId: "user_serve_team",
  });

  const bucket = s3.bucketFor("serve-bucket");
  const seed = (path, body, etag) => bucket.set(path, { body, etag });
  seed("privacy.md", PRIVACY_MANIFEST, "sp0");
  seed("1-projects/roster.md", "# Roster\n\nThe numbat roster for this quarter.\n", "s1");
  seed("1-projects/plans.md", "# Plans\n\nMore numbat planning.\n", "s2");
  /*
   * Twelve more, so that "numbat" matches more notes than a page of results
   * shows. Without them the fast path's count and its display limit are the
   * same number, and `mergeHits` slicing to the display limit BEFORE the
   * privacy filter — which would make the number of results a caller sees
   * depend on how many notes they cannot see — is a mistake no check in this
   * file could observe. Measured: that sabotage reddened nothing until these
   * existed.
   */
  const NUMBAT_NOTES = 14;
  for (let n = 0; n < NUMBAT_NOTES - 2; n += 1) {
    const id = String(n).padStart(2, "0");
    seed(`1-projects/n${id}.md`, `# Numbat ${id}\n\nnumbat sightings, page ${id}.\n`, `sn${id}`);
  }
  seed("1-projects/log.md", longNote("pangolin"), "s3");
  seed("2-areas/vitals.md", "# Vitals\n\nA private wombat diagnosis.\n", "s4");
  /*
   * A note that is nothing but its heading. Its body chunk is empty, so
   * FTS5's `snippet()` over the body column has nothing to quote and the
   * answer falls back to the title — which is the only reason the projection
   * carries one. Without this note that fallback is unreachable: dropping the
   * title from `mergeHits` entirely reddened zero checks.
   */
  seed("1-projects/stub.md", "# Pademelon\n", "s7");

  async function search(query, token = SERVE_TOKEN_OWNER, budget = 600, prefix = undefined) {
    const harness = createWorkerCtx();
    const readsBefore = noteReads.length;
    const indexBefore = indexReads.length;
    const response = await worker.fetch(
      new Request("https://gateway.test/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_notes",
            arguments: prefix === undefined ? { query } : { query, prefix },
          },
        }),
      }),
      {
        CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
        GATEWAY_SECRET,
        SEARCH_SUBREQUEST_BUDGET: String(budget),
      },
      harness.ctx,
    );
    const body = await response.json();
    // Measured BEFORE `settle()`, and that is the whole point: the deferred
    // maintenance pass reads notes out of the bucket too, so a count taken
    // after it would say every search reads notes and the latency claim would
    // be untestable. This is what the caller waited for.
    const answerReads = noteReads.length - readsBefore;
    const answerIndexReads = indexReads.length - indexBefore;
    await harness.settle();
    // What the DEFERRED half read, which is the other side of the same claim:
    // moving the manifest off the critical path is only an improvement if it
    // is still read somewhere. A count over the whole fixture cannot say that
    // — earlier R2 searches read manifests too — so it is measured per call,
    // between the answer and the end of `settle()`.
    const deferredIndexReads = indexReads.length - indexBefore - answerIndexReads;
    return {
      response,
      body,
      text: JSON.stringify(body),
      answerReads,
      answerIndexReads,
      deferredIndexReads,
    };
  }

  const ready = (state) =>
    controlPlane.bindings.set(SERVE_WS, s3Binding("serve-bucket", { ...DESCRIPTOR, state }));

  try {
    // Converge both indexes while the row still says `backfilling`, which is
    // also the assertion that a filling projection is not served from.
    const duringBackfill = await search("numbat");
    check(
      "a projection that is still filling is not read from",
      d1.requests.every((request) => !PROJECTION_READ.test(request.sql)),
    );
    check(
      "and the search is answered by the R2 index meanwhile",
      duringBackfill.text.includes("1-projects/") && duringBackfill.answerReads > 0,
    );
    for (let round = 0; round < 3; round += 1) await search("numbat");
    check(
      "the whole context reaches the projection",
      d1.rows("SELECT COUNT(*) AS n FROM notes")[0].n === NUMBAT_NOTES + 3,
    );

    ready("ready");

    // -- 1. answered out of the database, without opening the bucket -------
    noteReads.length = 0;
    const fast = await search("numbat");
    check(
      "a ready projection answers the search",
      fast.text.includes("1-projects/") && !fast.body.result?.isError,
    );
    check(
      "without reading a single note out of the customer's bucket",
      fast.answerReads === 0,
    );
    /*
     * And without reading the index either. The manifest is still needed — the
     * reconcile clock reads `listedAt` off it, and without one
     * `indexNeedsAPass` says "no index at all" and re-lists the whole bucket
     * behind every fast search — but nothing the caller waits for needs it, so
     * it is resolved inside the deferred maintenance. That is the last object
     * GET on the critical path of a hit: what remains is `privacy.md`, which
     * every request reads to build the privacy engine, and the D1 queries
     * themselves.
     */
    check(
      "and without reading the index in front of the caller either",
      fast.answerIndexReads === 0,
    );

    /*
     * -- and `reducedRecall: false` here is a claim, not a default ---------
     *
     * `searchVisibleNotes` hardcodes it on this branch and argues it from the
     * projection's shape: `projectPass` reads each note's own object and
     * writes a chunk row per message, so there is no shard byte cap for a
     * mailbox to cross and nothing reaching D1 is ever reduced. The argument
     * is sound and it was worth nothing untested — measured, claiming the
     * opposite here reddened no check in this suite while the console's own
     * twin of it in `consoleSearch.test.ts` was pinned. So: mark the R2
     * manifest shed, which is exactly what makes the R2 path warn, and
     * confirm an answer served out of the database still does not.
     */
    const manifestObject = bucket.get(".context/search/v2/manifest.json");
    const shedManifest = JSON.parse(manifestObject.body);
    shedManifest.stats[0] = {
      ...shedManifest.stats[0],
      shed: 1,
      shedPaths: ["1-projects/roster.md"],
    };
    bucket.set(".context/search/v2/manifest.json", {
      ...manifestObject,
      body: JSON.stringify(shedManifest),
    });
    const overShed = await search("numbat");
    check(
      "the fast path never claims reduced recall, even over a manifest marked shed",
      !overShed.text.includes("more messages than the search index can keep in full"),
    );
    // Put it back: the checks below measure this fixture's index, and a
    // manifest this one edited is not the one they were written against.
    bucket.set(".context/search/v2/manifest.json", manifestObject);
    check(
      "the manifest is still read, behind that same response",
      fast.deferredIndexReads > 0,
    );
    check(
      "and it really was the projection that was asked",
      d1.requests.some((request) => PROJECTION_READ.test(request.sql)),
    );
    check(
      "counting every matching note, not just the page of them it shows",
      fast.text.includes(`${NUMBAT_NOTES} matching notes — the 10 best shown`),
    );
    /*
     * The snippet quotes the note verbatim. FTS5 wraps a hit in whatever
     * `SNIPPET_OPEN`/`SNIPPET_CLOSE` say, and they are deliberately empty so a
     * caller cannot tell which index answered — the R2 path prints whole lines
     * of the note unmarked. Nothing asserted that until this check: putting
     * the marks back reddened zero.
     */
    /*
     * Not `text.includes("some phrase")`, which was the first version and
     * caught nothing: setting `SNIPPET_OPEN` back to "<" left every phrase in
     * the fixture intact, because the mark lands on the matched TERM and the
     * words after it are unchanged. So the whole quoted line is taken from the
     * answer and looked up in the note it names — a mark anywhere in it, on
     * either side, makes it stop being a substring of what the person wrote.
     */
    const quoted = fast.body.result.content[0].text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const hitPath = quoted.find((line) => line.startsWith("1-projects/"));
    const hitSnippet = quoted[quoted.indexOf(hitPath) + 1].replace(/^…|…$/g, "").trim();
    check(
      "and quoting the note as written, with no markup the other path lacks",
      hitSnippet.length > 0 && bucket.get(hitPath).body.includes(hitSnippet),
    );

    const bodiless = await search("pademelon");
    check(
      "a note with nothing but a heading is found and named by its title",
      bodiless.text.includes("1-projects/stub.md") && bodiless.text.includes("Pademelon"),
    );

    // -- 2. the recall the R2 index cannot have ----------------------------
    const deep = await search("pangolin");
    check(
      "a term past the R2 index's per-note cap is found in the projection",
      deep.text.includes("1-projects/log.md"),
    );

    // A folder narrowing, through the tool rather than through the SQL that
    // `searchD1.test.mjs` exercises: the argument has to survive normalization
    // and reach the projection as the same string the R2 path would compare.
    const narrowed = await search("numbat", SERVE_TOKEN_OWNER, 600, "2-areas/");
    check(
      "a prefixed fast search narrows to the folder asked for",
      !narrowed.text.includes("1-projects/"),
    );

    // -- 3. the tier boundary ---------------------------------------------
    const beforeTeamSearch = d1.requests.length;
    const teamAsksForPrivate = await search("wombat", SERVE_TOKEN_TEAM);
    check(
      "a team connection cannot reach a private note through the projection",
      !teamAsksForPrivate.text.includes("2-areas/vitals.md"),
    );
    /*
     * Bounded to the requests THIS search made. The first version of this
     * filtered every request in the fixture — the owner's private-tier queries
     * included — and then asserted a tautology over them, which is a check
     * that cannot fail and was worse than no check at all.
     *
     * The property is not "the private note was filtered out", it is that a
     * team caller's query never names the private table: `bm25()` computes its
     * corpus statistics over the tables it is given, so a private note's terms
     * in a team caller's scoring move that caller's result ORDERING even when
     * every private path is filtered from the output. No `WHERE` closes that,
     * and no output check can see it.
     */
    const teamReads = d1.requests
      .slice(beforeTeamSearch)
      .filter((request) => PROJECTION_READ.test(request.sql));
    check(
      "asking exactly one table, the team one",
      teamReads.length === 1 &&
        teamReads[0].sql.includes("notes_team_fts") &&
        !teamReads[0].sql.includes("notes_private_fts"),
    );
    const owner = await search("wombat");
    check(
      "while the owner finds their own private note",
      owner.text.includes("2-areas/vitals.md"),
    );

    // -- 4. live privacy beats the tier the row was stored at --------------
    //
    // The note is published to team, projected at that tier, and then made
    // private again WITHOUT another backfill pass — so `notes_team_fts` still
    // holds its rows. This is the window `canSee` exists to close, and the
    // only check in this file that would go red if the filter were removed
    // while the table split stayed correct.
    seed("1-projects/secret.md", "# Secret\n\nA quoll arrangement.\n", "s5");
    // A second team note matching the same word, projected in the same pass.
    // It is what makes the count assertion below possible: after the flip a
    // team caller has one hit they may read and one they may not, which is the
    // only arrangement in which a pre-filter count is observable at all.
    seed("1-projects/roundup.md", "# Roundup\n\nAnother quoll arrangement.\n", "s8");
    ready("backfilling");
    for (let round = 0; round < 3; round += 1) await search("quoll");
    ready("ready");
    check(
      "a team note is projected into the team corpus",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quoll"']).length >
        0,
    );
    const beforeFlip = await search("quoll", SERVE_TOKEN_TEAM);
    check(
      "and a team connection can read it while it is a team note",
      beforeFlip.text.includes("1-projects/secret.md"),
    );
    seed(
      "privacy.md",
      PRIVACY_MANIFEST.replace(
        "note_overrides:\n  # none",
        "note_overrides:\n  1-projects/secret.md: private",
      ),
      "sp1",
    );
    const afterFlip = await search("quoll", SERVE_TOKEN_TEAM);
    check(
      "the row is still in the team corpus, so the split alone would leak it",
      d1.rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quoll"']).length >
        0,
    );
    check(
      "and the live privacy manifest is what actually stops the read",
      !afterFlip.text.includes("1-projects/secret.md"),
    );
    check(
      "while the note beside it, still team, is still returned",
      afterFlip.text.includes("1-projects/roundup.md"),
    );
    /*
      AND THE COUNT IS THE FILTERED ONE.

      `serve.js` names this attack about the *slice* — "slicing before the
      filter would make the number of results a team caller sees depend on how
      many private notes outranked them, which is a subtraction attack with
      extra steps" — and the slice is guarded. The COUNT is the same channel and
      was guarded by nothing: computing `matchCount` from `result.notes.length`
      instead of `visible.length` reddened **0 of 1,637**, because no fixture
      had a query matching both a visible note and a filtered one at once. It
      does now, and the leak it would print is not subtle: the caller reads
      "2 matching notes — the 1 best shown", which is a team connection being
      told how many notes it may not see match its word.

      Asserted on the rendered sentence rather than on a field, because the
      sentence is what the person reads and `toolSearchNotes` composes the
      count and the hit list separately.
    */
    check(
      "and the count a team caller is told is the filtered one",
      // Anchored, because `includes("1 matching note")` is also true of
      // `11 matching notes` — measured: `visible.length + 10` renders exactly
      // that and slipped past the substring form. A check named for a number
      // has to be about that number.
      /(^|[^0-9])1 matching note(?!s)/.test(afterFlip.text) &&
        !/(^|[^0-9])2 matching note/.test(afterFlip.text),
    );
    check(
      // The three checks above are all true of the R2 answer too — it renders
      // the same sentence for the same query — so without this they would keep
      // passing with the fast path switched off entirely, proving nothing
      // about the `matchCount` in `fastSearchAnswer`. `answerReads` is the
      // fixture's own idiom for that: the projection quotes itself and fetches
      // no notes. Measured: switching the fast path off reddens 7 with this
      // line and 6 without it.
      "and it was the projection that counted, not the index behind it",
      afterFlip.answerReads === 0,
    );

    /*
      `truncated` AT ITS SOURCE, DRIVEN DIRECTLY RATHER THAN THROUGH A SEARCH.

      It is the `+` on "12+ matching notes", and it is a one-bit pre-filter
      signal in the same family as the count above: for a team caller the page
      is filled from `notes_team_fts`, which in this very window holds chunks
      of a note they may not read. Never setting it reddened NOTHING through
      the fixture, because tripping it needs a table to return
      `CHUNK_FETCH_CAP` rows and no context here is that large — the biggest
      single-table return anywhere in this file is 14 against a cap of 200.

      So these three call `searchProjection` with a stub client and a small
      `chunkCap`, which is the parameter that exists for exactly this. **They
      are the only checks in this file that do not go through a search**, which
      is why the record above says so of both rows they cover: a red here has
      not been near the gateway, and a fixture of 200 notes would prove the same
      bit at fifty times the cost.

      The third is a separate guard rather than a third case of the first two.
      A team caller asks one table, so neither of them can tell a per-table cap
      from one accumulated across tables; the private tier asks two, and that
      one check is the whole of what refuses `rows.length + answered.length >=
      chunkCap`. Measured: it is the only red under that mutation.
    */
    const pageOf = (n) =>
      Array.from({ length: n }, (_, i) => ({
        path: `1-projects/p${i}.md`,
        title: `P${i}`,
        snippet: "s",
        score: -1 - i,
      }));
    const askWith = async (rows, tier = "team") =>
      // `?? {}` rather than a bare property read: a `searchProjection` that
      // returned `null` would otherwise throw out of the whole module and take
      // every suite after this one with it, instead of reddening by name.
      (await searchProjection(
        { query: async () => rows },
        { query: "quoll", tier, chunkCap: 2 },
      )) ?? {};
    check(
      "a page that fills its cap reports itself a floor",
      (await askWith(pageOf(2))).truncated === true,
    );
    check(
      "and one that does not fill it does not",
      (await askWith(pageOf(1))).truncated === false,
    );
    check(
      "and two short pages do not add up to a full one",
      (await askWith(pageOf(1), "private")).truncated === false,
    );

    /*
      HOW FAR DOWN THE RANKED LIST ONE ANSWER READS.

      `answerFromProjection` sliced at a constant ten until the console grew a
      dedicated search page, which pages through the blend and needs the second
      twenty as well as the first. `pageDepth` is the shared clamp and its
      ceiling is `MAX_RESULTS` — the rank `query.js` stops ranking at — so a
      caller that asked for more would be handed a short list and would
      reasonably read the shortfall as "there are no more matches".

      Driven directly for the same reason the three checks above are: a fixture
      with more than ten matching notes in it costs fifty times as much as a
      stub and proves the same arithmetic. `isVisible` is `() => true` here
      because this is about the slice; the filter above it has its own checks,
      and the ORDER of the two — filter, then slice — is what the count checks
      earlier in this section pin.
    */
    const atDepth = async (limit) =>
      await answerFromProjection(
        { query: async () => pageOf(60) },
        { query: "quoll", tier: "team", isVisible: () => true, limit, chunkCap: 200 },
      );
    check(
      "a caller that asks for nothing in particular still gets a palette's ten",
      (await atDepth(undefined)).hits.length === 10,
    );
    check(
      "a search page asking for a deeper page gets one",
      (await atDepth(40)).hits.length === 40,
    );
    check(
      "and nobody reads past the rank the ranker stops at",
      (await atDepth(500)).hits.length === MAX_RESULTS,
    );
    check(
      "a limit that is not a number is the default rather than an empty page",
      (await atDepth("40")).hits.length === 10 && (await atDepth(0)).hits.length === 10,
    );
    check(
      // The whole point of paging inside one merged list: the deeper slice is
      // the same ranking read further down, not a re-query. So the first ten of
      // a forty-deep read are byte-identical to a ten-deep read.
      "a deeper page is the same list read further down",
      JSON.stringify((await atDepth(40)).hits.slice(0, 10)) ===
        JSON.stringify((await atDepth(10)).hits),
    );

    // -- 5. a refused database is not a failed search ----------------------
    d1.state.fail = 500;
    const refused = await search("numbat");
    d1.state.fail = null;
    check(
      "a search database that refuses every read does not fail the search",
      refused.response.status === 200 && !refused.body.result?.isError,
    );
    /*
     * `answerReads > 0` rather than a path, and that is the check doing real
     * work: the R2 path fetches every note it quotes so it can cut a snippet
     * from live text, and the projection path fetches none. So a search that
     * read notes out of the bucket is a search the shard index answered, and
     * no assertion about which paths came back could tell the two apart —
     * both find the same notes, which is the point.
     */
    check(
      "the R2 index answers instead, exactly as it does with fast search off",
      refused.text.includes("1-projects/") && refused.answerReads > 0,
    );

    // -- 6. a miss falls through rather than answering "none" --------------
    //
    // A note that exists in the bucket and in the R2 index and is deliberately
    // NOT in the projection: the row is deleted underneath it, which is what a
    // projection that is behind, was rebuilt, or lost a row looks like.
    seed("1-projects/bilby.md", "# Bilby\n\nA bilby sighting.\n", "s6");
    ready("backfilling");
    for (let round = 0; round < 3; round += 1) await search("bilby");
    ready("ready");
    d1.db.exec(`DELETE FROM notes_team_fts WHERE path = '1-projects/bilby.md'`);
    const missed = await search("bilby");
    check(
      "a projection that has lost a row does not report the note as missing",
      missed.text.includes("1-projects/bilby.md"),
    );

    // -- the one thing the fast path is worse at ---------------------------
    //
    // Asserted rather than left to be discovered. A note deleted from the
    // bucket by something that is not this gateway — Obsidian, rclone — is
    // still in the projection until a maintenance pass removes it, and this
    // path quotes the projection instead of fetching the note, so it is still
    // an answer. The R2 path drops it only because its snippet read comes back
    // empty. If this check ever goes green the other way, the invalidation
    // named in `fastSearchAnswer` was built and this comment is the thing to
    // delete.
    bucket.delete("1-projects/stub.md");
    const stale = await search("pademelon");
    check(
      "a note deleted outside the gateway survives in the projection until a pass removes it",
      stale.text.includes("1-projects/stub.md"),
    );
    // The contrast, made by taking the projection away rather than by asking a
    // different question: same query, same index, and the R2 path drops the
    // note because the `GET` it makes to quote it comes back empty.
    d1.state.fail = 500;
    const viaR2 = await search("pademelon");
    d1.state.fail = null;
    check(
      "while the R2 path notices immediately, because it reads what it quotes",
      !viaR2.text.includes("1-projects/stub.md"),
    );

    /* -- 7. A NOTE HELD BACK BY NAME, AFTER IT WAS INDEXED -----------------
     *
     * The flip in section 4 makes a team note `private`, and `canSee` answers
     * that on an early branch: `if (visibility === "private") return false`.
     * A note pointed at a GROUP does not reach that branch — it falls through
     * to the last line, `grantedGroups !== undefined && grantedGroups.has(…)`,
     * which is a different expression with a different way of being wrong. So
     * the two are not the same check, and only one of them had one.
     *
     * The window is the same one: the note keeps its team-tier rows until a
     * backfill pass moves them, and nothing is reprojected here, so this is
     * the live manifest against a stale corpus — by name instead of by tier.
     */
    seed(
      "privacy.md",
      PRIVACY_MANIFEST.replace(
        "note_overrides:\n  # none",
        "note_overrides:\n  1-projects/secret.md: private\n  1-projects/roundup.md: @supa-owners",
      ),
      "sp2",
    );
    const heldByName = await search("quoll", SERVE_TOKEN_TEAM);
    check(
      "a note pointed at a group still has its team-tier rows",
      d1.rows(`SELECT path FROM notes_team_fts WHERE path = '1-projects/roundup.md'`).length > 0,
    );
    check(
      "and a note held back by NAME after indexing is gone from a team search at once",
      !heldByName.text.includes("1-projects/roundup.md"),
    );
    check(
      // Without this the check above is also true of a search that found
      // nothing because the row had been removed, or because the query broke.
      "while the owner still finds it, so the row really is still there",
      (await search("quoll")).text.includes("1-projects/roundup.md"),
    );

    /* -- 8. TWO CONTEXTS, TWO DATABASES ------------------------------------
     *
     * Every other check in this file is about two TIERS of one context, which
     * the file says out loud where the second grant is added. The tenancy
     * claim — one context's search cannot return, rank on, or count another's
     * rows — rested on reading `createD1Client` and finding that it builds its
     * endpoint out of the descriptor it was handed. Nothing drove it.
     *
     * It needed the fixture to be able to fail first: the D1 fake answered
     * every request out of one database whatever the URL named, so a query
     * sent to the wrong database would have come back correct. It now keys by
     * the id in the path, and these four checks are what that buys.
     *
     * Corpus statistics are the reason this matters more here than access
     * control does: `bm25()` computes `N`, `df` and `avglen` over the table it
     * is given, so two contexts sharing one would rank each other's searches
     * even with every path filtered. Separate databases is that claim, and it
     * is now measured rather than read.
     */
    const SERVE_WS_B = "ws_serve_b";
    const SERVE_TOKEN_B = `cat_serve_b_${"0".repeat(22)}`;
    const DATABASE_ID_B = "db-0000-0000-0000-00000000000b";
    /** Obviously fake, and deliberately not the other context's. */
    const API_TOKEN_B = "d1-write-token-not-a-real-one-000b";
    const descriptorB = (state) => ({
      ...DESCRIPTOR,
      databaseId: DATABASE_ID_B,
      apiToken: API_TOKEN_B,
      state,
    });
    controlPlane.addWorkspace(
      SERVE_WS_B,
      "serveb",
      s3Binding("serve-bucket-b", descriptorB("backfilling")),
    );
    await controlPlane.addGrant({
      accessToken: SERVE_TOKEN_B,
      workspaceId: SERVE_WS_B,
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_serve_b",
      userId: "user_serve_b",
    });
    const bucketB = s3.bucketFor("serve-bucket-b");
    bucketB.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "bp0" });
    bucketB.set("1-projects/field.md", {
      body: "# Field\n\nA quokka census for this quarter.\n",
      etag: "bs1",
    });
    for (let round = 0; round < 3; round += 1) await search("quokka", SERVE_TOKEN_B);
    controlPlane.bindings.set(SERVE_WS_B, s3Binding("serve-bucket-b", descriptorB("ready")));

    const beforeB = d1.requests.length;
    const ownOfB = await search("quokka", SERVE_TOKEN_B);
    const requestsOfB = d1.requests.slice(beforeB);
    check(
      // The non-vacuity half: the three checks below are all true of a search
      // that never reached a projection at all.
      "a second context's search is answered out of a projection",
      ownOfB.text.includes("1-projects/field.md") && ownOfB.answerReads === 0,
    );
    check(
      "...addressing its own database and no other",
      requestsOfB.length > 0 &&
        requestsOfB.every((request) => request.databaseId === DATABASE_ID_B),
    );
    check(
      "...carrying its own token, never the other context's",
      requestsOfB.every((request) => request.authorization === `Bearer ${API_TOKEN_B}`) &&
        !requestsOfB.some((request) => String(request.authorization).includes(API_TOKEN)),
    );
    /*
     * `pangolin`, not `numbat`, and the difference is the whole check.
     *
     * `numbat` matches fourteen of the other context's notes and an answer
     * shows ten, so "the two I named are absent" can be true of a leak that
     * simply ranked them eleventh. Measured: with a sabotage routing this
     * context's query at the other one's database, the `numbat` form of this
     * check stayed GREEN while the answer carried that context's notes.
     * `pangolin` is in exactly one note over there and in nothing here, so a
     * leak has nowhere to hide and an empty answer means an empty answer.
     */
    const beforeCross = d1.requests.length;
    const bAsksForA = await search("pangolin", SERVE_TOKEN_B);
    check(
      "a term that only the other context has matches nothing here",
      !bAsksForA.text.includes("1-projects/log.md") && !bAsksForA.text.includes("pangolin appears"),
    );
    check(
      "...and the other context's database was not asked about it",
      d1.requests
        .slice(beforeCross)
        .every((request) => request.databaseId === DATABASE_ID_B),
    );
    check(
      "nor can the first context see the second's note",
      !(await search("quokka")).text.includes("1-projects/field.md"),
    );
    check(
      // The corpus claim stated as data: `bm25()` ranks over the table it is
      // given, so two contexts can only rank across each other if their rows
      // are in one place. They are not.
      "the two corpora are separate databases, so neither ranks or counts over the other",
      d1.rowsIn(DATABASE_ID_B, `SELECT path FROM notes`).every((row) =>
        row.path.startsWith("1-projects/field"),
      ) && d1.rows(`SELECT path FROM notes WHERE path = '1-projects/field.md'`).length === 0,
    );

    // -- the credential, on the read path ----------------------------------
    check(
      "no read-path response carries the write token",
      [fast, deep, owner, refused, missed, ownOfB].every(
        (answer) => !answer.text.includes(API_TOKEN) && !answer.text.includes(API_TOKEN_B),
      ),
    );
  } finally {
    globalThis.fetch = previousFetch;
    restoreControlPlane();
    restoreD1();
    restoreS3();
    d1.close();
  }
}
