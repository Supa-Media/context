/**
 * THE COPY: NOTES REACHING A CONTEXT'S OWN SEARCH DATABASE.
 *
 * The wire (what the gateway sends, and refuses to repeat back) and tenancy
 * (one workspace's query never reaches another's database).
 *
 * Split out of searchProjection.test.mjs — see that file for the full module
 * overview and sabotage-testing record, and fixtures.mjs for the shared D1
 * backend stub and constants.
 */

import {
  ACCOUNT_ID,
  API_TOKEN,
  CLOUDFLARE_API_BASE,
  CURSOR_KEY,
  D1Error,
  DATABASE_ID,
  DESCRIPTOR,
  DatabaseSync,
  createD1Backend,
  createD1Client,
  createSearchBudget,
  noteStore,
  projectPass,
  readSearchIndexBinding,
} from "./fixtures.mjs";

export async function runSearchProjectionWireAndTenancyChecks(check) {
  if (!DatabaseSync) {
    check(
      "node:sqlite is available, so the projection can be checked against real SQL",
      false,
    );
    return;
  }

  // ======================================================================
  // 1. The wire: what the gateway sends, and what it refuses to repeat back
  // ======================================================================

  {
    const sent = [];
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async (url, init) => {
        sent.push({ url, init });
        return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), {
          status: 200,
        });
      },
    });
    await client.query("SELECT 1", []);
    check(
      "a statement goes to this database's query endpoint",
      sent[0].url ===
        `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT_ID}/d1/database/${DATABASE_ID}/query`,
    );
    check(
      "carrying the token as a bearer credential and nowhere else",
      sent[0].init.headers.Authorization === `Bearer ${API_TOKEN}` &&
        !sent[0].url.includes(API_TOKEN),
    );
    check(
      "and never following a redirect it did not choose",
      sent[0].init.redirect === "manual",
    );
    check(
      "params are bound, never interpolated",
      JSON.parse(sent[0].init.body).sql === "SELECT 1",
    );
  }

  {
    // Our codes, from a closed set. The provider's message can name an account
    // or a database, so none of it may survive the boundary.
    const cases = [
      [401, "UNAUTHORIZED"],
      [403, "UNAUTHORIZED"],
      [404, "NOT_FOUND"],
      [429, "RATE_LIMITED"],
      [500, "UNAVAILABLE"],
      [400, "REFUSED"],
    ];
    let classified = 0;
    let leaked = 0;
    for (const [status, code] of cases) {
      const client = createD1Client(DESCRIPTOR, {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ message: `account ${ACCOUNT_ID} database ${DATABASE_ID} refused` }],
            }),
            { status },
          ),
      });
      try {
        await client.query("SELECT 1", []);
      } catch (error) {
        if (error instanceof D1Error && error.code === code) classified += 1;
        const text = `${error?.message} ${error?.stack ?? ""}`;
        if (text.includes(ACCOUNT_ID) || text.includes(DATABASE_ID) || text.includes(API_TOKEN)) {
          leaked += 1;
        }
      }
    }
    check("every provider status becomes one of our codes", classified === cases.length);
    check(
      "and the error carries no account, database or token",
      leaked === 0,
    );
  }

  {
    // Cloudflare answers a refused statement 200 with `success: false`, so the
    // status alone is not the check.
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ success: false, errors: [{ message: "no" }] }), {
          status: 200,
        }),
    });
    let code = null;
    try {
      await client.query("SELECT 1", []);
    } catch (error) {
      code = error.code;
    }
    check("a 200 that says success:false is still a failure", code === "REFUSED");
  }

  {
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () => {
        // The kind of error a runtime throws, quoting the request it was
        // making — `Authorization` header included.
        throw new Error(`fetch failed: POST with Bearer ${API_TOKEN}`);
      },
    });
    let message = "";
    let code = null;
    try {
      await client.query("SELECT 1", []);
    } catch (error) {
      code = error.code;
      message = `${error.message} ${error.stack ?? ""}`;
    }
    check("an unreachable provider is UNAVAILABLE", code === "UNAVAILABLE");
    check(
      "and the thrown error that quoted the token is dropped, not wrapped",
      !message.includes(API_TOKEN),
    );
  }

  {
    check("an absent searchIndex is not an error, it is off", readSearchIndexBinding({}) === null);
    check(
      "a descriptor missing its token is off too, not half-configured",
      readSearchIndexBinding({
        searchIndex: { databaseId: DATABASE_ID, accountId: ACCOUNT_ID },
      }) === null,
    );
    check(
      "a complete descriptor is read whole",
      readSearchIndexBinding({ searchIndex: DESCRIPTOR })?.databaseId === DATABASE_ID,
    );
    let threw = null;
    try {
      createD1Client({ databaseId: DATABASE_ID });
    } catch (error) {
      threw = error.code;
    }
    check("and a client cannot be built from half a descriptor", threw === "NOT_CONFIGURED");
  }

  {
    // The budget is peeked before the first statement is charged, so a group is
    // never half-applied for want of an op.
    let sent = 0;
    const client = createD1Client(DESCRIPTOR, {
      fetchImpl: async () => {
        sent += 1;
        return new Response(JSON.stringify({ success: true, result: [{ results: [] }] }), {
          status: 200,
        });
      },
    });
    const budget = createSearchBudget(3);
    const outcome = await client.runAll(
      [{ sql: "A" }, { sql: "B" }, { sql: "C" }, { sql: "D" }],
      { budget },
    );
    check("a statement group that does not fit is not started", outcome.skipped && sent === 0);
    check("and the budget it could not afford is untouched", budget.remaining === 3);
  }

  // ======================================================================
  // 2. The pass: which table, resuming, and never guessing
  // ======================================================================

  const NOTES = {
    "1-projects/alpha.md": "# Alpha\n\nThe quokka roster for the alpha project.\n",
    "2-areas/health/private-note.md": "# Vitals\n\nA private diagnosis nobody else may read.\n",
    "3-resources/beta.md": "# Beta\n\nMore quokka notes, shared with the team.\n",
  };
  const PRIVATE_PATH = "2-areas/health/private-note.md";
  const census = new Map(Object.keys(NOTES).map((path) => [path, `v-${path}`]));
  const visibilityOf = (path) => (path === PRIVATE_PATH ? "private" : "team");

  {
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);
    const progress = [];
    const result = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      reportProgress: (p) => progress.push(p),
    });

    check("a first pass copies every note", result.projected === 3);
    check(
      "and the projection holds one row per note",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 3,
    );

    // THE ONE THAT MATTERS.
    const teamRows = backend.rows("SELECT path FROM notes_team_fts");
    const privateRows = backend.rows("SELECT path FROM notes_private_fts");
    check(
      "a private note never lands in the team table",
      teamRows.every((row) => row.path !== PRIVATE_PATH),
    );
    check(
      "it lands in the private one instead",
      privateRows.length > 0 && privateRows.every((row) => row.path === PRIVATE_PATH),
    );
    check(
      "and its text is not in the team corpus at all",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 0,
    );
    check(
      "while a team note is findable in the team corpus",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"quokka"'])
        .length === 2,
    );
    check(
      "the visibility recorded on the note row agrees",
      backend.rows("SELECT visibility FROM notes WHERE path = ?", [PRIVATE_PATH])[0]
        .visibility === "private",
    );

    check(
      "progress is reported once the pass has moved something",
      progress.length === 1 && progress[0].notesIndexed === 3,
    );
    check(
      "with counts that match what was actually written",
      progress[0].notesIndexed === backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n,
    );
    check("and nothing left pending", progress[0].notesPending === 0);
    check("so the control plane is told the projection is ready", progress[0].state === "ready");

    // -- the tier moves when the visibility does --------------------------
    const flipped = await projectPass(store, client, {
      census,
      touched: [PRIVATE_PATH],
      visibilityOf: () => "team",
      budget: createSearchBudget(200),
    });
    check("re-projecting a note whose visibility changed does work", flipped.projected >= 1);
    check(
      "the note moves tiers rather than accumulating in both",
      backend.rows("SELECT path FROM notes_private_fts").length === 0,
    );
    check(
      "and its terms are now in the corpus the team is scored against",
      backend
        .rows(`SELECT path FROM notes_team_fts WHERE notes_team_fts MATCH ?`, ['"diagnosis"'])
        .length === 1,
    );
    check(
      "with exactly one note row, not two",
      backend.rows("SELECT COUNT(*) AS n FROM notes WHERE path = ?", [PRIVATE_PATH])[0].n === 1,
    );
    backend.close();
  }

  {
    // A visibility this build does not recognise is not guessed at: the safe
    // guess and the useful guess differ, and the useful one publishes a
    // private note's vocabulary to every member of the context.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf: () => "public",
      budget: createSearchBudget(200),
    });
    check(
      "an unrecognised visibility copies the note nowhere",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_team_fts")[0].n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_private_fts")[0].n === 0,
    );
    backend.close();
  }

  {
    // Resuming. A pass capped at one note must start the next one after the
    // note it finished, not at the beginning.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);

    const first = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("a capped pass projects its share and stops", first.projected === 1);
    const cursor = backend.rows("SELECT value FROM index_state WHERE key = ?", [CURSOR_KEY]);
    check("recording where it got to, in the projection's own state table", cursor.length === 1);

    const readsBefore = store.reads.length;
    const second = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("the next pass projects the next note", second.projected === 1);
    check(
      "and never re-reads the one already done",
      store.reads.slice(readsBefore).every((path) => path !== store.reads[0]),
    );
    check(
      "so two capped passes have copied two distinct notes",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 2,
    );

    const third = await projectPass(store, client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      noteCap: 1,
    });
    check("a third finishes the sweep", third.projected === 1 && third.sweepComplete);
    check(
      "which parks the cursor back at the start, so the next sweep re-verifies",
      backend.rows("SELECT value FROM index_state WHERE key = ?", [CURSOR_KEY])[0].value === "",
    );

    // Converged: nothing to do, and it costs a handful of ops rather than a
    // re-projection of the whole context.
    const budget = createSearchBudget(200);
    const readsBeforeConverged = store.reads.length;
    const converged = await projectPass(store, client, {
      census,
      visibilityOf,
      budget,
      noteCap: 20,
    });
    check("a converged pass copies nothing", converged.projected === 0);
    check("and reads no note to discover that", store.reads.length === readsBeforeConverged);
    check("at a cost of a few operations, not one per note", budget.spent <= 4);
    backend.close();
  }

  {
    // What `touched` buys, which is not coverage but *order*. A note edited now
    // is projected on the next pass rather than when a sweep in path order
    // happens to reach it — on a context of any size those are wildly
    // different waits, and the sweep alone cannot tell them apart because it
    // finds the same note either way, eventually.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const store = noteStore(NOTES);
    await projectPass(store, client, { census, visibilityOf, budget: createSearchBudget(200) });

    // Two notes change; only one of them is the one the sync just re-indexed,
    // and the other sorts FIRST — so a pass that walks in sweep order alone
    // picks the wrong one. Without both edits the check proves nothing: the
    // sweep would have reached the single stale note anyway.
    const LAST = "3-resources/beta.md";
    const FIRST = "1-projects/alpha.md";
    const edited = new Map(census);
    edited.set(LAST, "v2-edited");
    edited.set(FIRST, "v2-edited-too");
    const before = store.reads.length;
    await projectPass(store, client, {
      census: edited,
      touched: [LAST],
      visibilityOf,
      budget: createSearchBudget(200),
      // Room for exactly one note, so which one is projected is the assertion.
      noteCap: 1,
    });
    check(
      "the note the sync just re-indexed is the one this pass projects",
      store.reads.slice(before).join(",") === LAST,
    );
    check(
      "and the projection now holds the edited version",
      backend.rows("SELECT version FROM notes WHERE path = ?", [LAST])[0].version ===
        "v2-edited",
    );
    backend.close();
  }

  {
    // A note that has gone from the bucket goes from the projection. Otherwise
    // a search returns a path whose snippet read 404s, forever.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
    });
    const smaller = new Map(census);
    smaller.delete("3-resources/beta.md");
    const removed = await projectPass(noteStore(NOTES), client, {
      census: smaller,
      removed: ["3-resources/beta.md"],
      visibilityOf,
      budget: createSearchBudget(200),
    });
    check("a removal is applied", removed.deleted === 1);
    check(
      "and the note is gone from every table it was in",
      backend.rows("SELECT COUNT(*) AS n FROM notes WHERE path = ?", ["3-resources/beta.md"])[0]
        .n === 0 &&
        backend.rows("SELECT COUNT(*) AS n FROM notes_team_fts WHERE path = ?", [
          "3-resources/beta.md",
        ])[0].n === 0,
    );
    backend.close();
  }

  {
    // The budget bounds the pass, and running out of it is the ordinary end of
    // a pass rather than a failure to report.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const budget = createSearchBudget(14);
    const progress = [];
    const result = await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget,
      reserve: 4,
      reportProgress: (p) => progress.push(p),
    });
    check("a small budget still lands something", result.projected >= 1);
    check("without spending the reserve its caller was promised", budget.remaining >= 4);
    check("and running out is not reported as a failure", result.failure === null);
    check(
      "the projection is honest that it is not finished",
      progress.length === 1 && progress[0].state === undefined && progress[0].notesPending > 0,
    );
    backend.close();
  }

  {
    // A pass with no room at all lands nothing, reports nothing, and does not
    // pretend a failure happened.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    const result = await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(1),
      reportProgress: (p) => progress.push(p),
    });
    check(
      "a pass with no budget is a quiet no-op, not an error",
      result.projected === 0 && result.failure === null && progress.length === 0,
    );
    check("and it sent nothing at all", backend.requests.length === 0);
    backend.close();
  }

  {
    // An R2 index that has not finished listing means the census is a floor,
    // so the projection may not call itself ready over it.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    await projectPass(noteStore(NOTES), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
      indexPending: 40,
      reportProgress: (p) => progress.push(p),
    });
    check(
      "notes the R2 index has not reached are pending here too",
      progress[0].notesPending === 40,
    );
    check("so the projection does not claim to be ready", progress[0].state === undefined);
    backend.close();
  }

  {
    // A refused database. The pass reports the code and returns; the caller —
    // the search — is untouched, which the end-to-end section proves.
    const backend = createD1Backend();
    backend.state.fail = 401;
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const progress = [];
    let threw = false;
    let result = null;
    try {
      result = await projectPass(noteStore(NOTES), client, {
        census,
        visibilityOf,
        budget: createSearchBudget(200),
        reportProgress: (p) => progress.push(p),
      });
    } catch {
      threw = true;
    }
    check("a refused database does not throw out of the pass", !threw);
    check("it is classified", result.failure === "UNAUTHORIZED");
    check(
      "and reported, so a workspace does not sit at Preparing forever",
      progress.length === 1 && progress[0].errorCode === "UNAUTHORIZED",
    );
    check(
      "the report carries our code and none of the provider's text",
      !JSON.stringify(progress).includes(ACCOUNT_ID) &&
        !JSON.stringify(progress).includes("not authorized"),
    );
    backend.close();
  }

  {
    // A control plane that is down cannot break the pass either.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    let threw = false;
    let result = null;
    try {
      result = await projectPass(noteStore(NOTES), client, {
        census,
        visibilityOf,
        budget: createSearchBudget(200),
        reportProgress: () => {
          throw new Error("control plane down");
        },
      });
    } catch {
      threw = true;
    }
    check("a report that fails does not fail the pass", !threw && result.projected === 3);
    check(
      "and the notes are copied regardless",
      backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n === 3,
    );
    backend.close();
  }

  {
    // An unreadable note costs itself and nothing else.
    const backend = createD1Backend();
    const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });
    const broken = { ...NOTES, "1-projects/alpha.md": null };
    const result = await projectPass(noteStore(broken), client, {
      census,
      visibilityOf,
      budget: createSearchBudget(200),
    });
    check("one unreadable note does not stop the pass", result.projected === 2);
    backend.close();
  }
}
