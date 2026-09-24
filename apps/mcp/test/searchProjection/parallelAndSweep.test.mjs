/**
 * Two tiers queried together rather than serially, and a sweep bigger than
 * one window that must not report `ready` early.
 *
 * Split out of searchProjection.test.mjs; see fixtures.mjs for the shared D1
 * backend stub and constants.
 */

import {
  DESCRIPTOR,
  createD1Backend,
  createD1Client,
  createSearchBudget,
  noteStore,
  projectPass,
  searchProjection,
  syncShardedIndex,
} from "./fixtures.mjs";


/**
 * The sync's `touched` and `removed`, produced rather than passed in.
 *
 * Every other check here hands `projectPass` a list and asserts what it does
 * with one. This is the other half: `syncShardedIndex` is what *builds* those
 * lists, and without a check on that end the projection is being tested
 * against a fixture rather than against the thing that feeds it. The gap is
 * invisible to everything else, because the sweep's version diff finds the
 * same notes eventually — so deleting the reporting entirely changes only how
 * long somebody waits, which no other assertion measures.
 */
/**
 * A CENSUS BIGGER THAN ONE WINDOW, AND THE `ready` IT MUST NOT SEND EARLY.
 *
 * `state: "ready"` is the one gate `fastSearchAnswer` trusts: below it the
 * projection is never asked, at it every search is answered from it. So a
 * `ready` sent over a partially copied context is not a cosmetic percentage,
 * it is the reader being switched on over a corpus that is missing notes —
 * and every one of those searches falls through to R2 having paid a D1 query
 * for nothing.
 *
 * A live context was reported as "100% indexed, 100 notes" while holding more
 * than 160, and 100 is exactly `VERSION_PROBE_CAP` — a specific, checkable
 * accusation. This walks a census of 250, two and a half windows, and it
 * **clears the cap**. Two sabotages say why, and the second is the useful one:
 *
 *   `windowReachedEnd` forced true, so a window that merely FILLED
 *     ended the sweep                                                    0
 *   `notesPending` forced to 0                                           3
 *   both together                                                        3
 *
 * So `sweepComplete` is not what withholds `ready` — `notesPending === 0` is,
 * and it is computed as `census size - COUNT(*)` plus whatever the R2 index
 * says it has not reached. A sweep that ends early therefore cannot produce a
 * false `ready`: the count would not match the census and the state would stay
 * `undefined`. The cap is exonerated.
 *
 * **Which relocates the question rather than answering it.** For a context to
 * honestly report "100 indexed, 0 pending", its CENSUS must hold 100 — and the
 * census is the R2 index's own docmap (`loadCensus`), not a listing this pass
 * makes. So a context whose bucket holds 160 notes and whose projection calls
 * itself complete at 100 is a context whose R2 index knows about 100 notes and
 * believes it is caught up. That is an R2-index question, upstream of every
 * line in this file, and it is not diagnosable from a fixture — it needs the
 * live manifest's `freshness`. Written down here rather than guessed at.
 *
 * The guard stays whatever the answer, because the property is load-bearing —
 * `state: "ready"` is the one gate `fastSearchAnswer` trusts — and was proved
 * by nothing before this.
 */
/**
 * THE TWO TIERS GO OUT TOGETHER.
 *
 * A personal connection reads both FTS tables, and this client talks to D1
 * over Cloudflare's HTTP API rather than a native binding — the databases are
 * created per workspace at runtime and a Worker's D1 bindings are fixed at
 * deploy time, so there is no binding to have. Each tier is therefore a full
 * HTTPS request, and awaiting them one at a time made the fast path's floor
 * two round trips when its whole claim is to be one.
 *
 * Proved by construction rather than by a stopwatch: the stub below does not
 * answer the first query until the second has arrived. Serially that is a
 * deadlock, so a `searchProjection` that awaits in a loop cannot finish this
 * check — and a timer turns the hang into a failure rather than a stuck suite.
 */
export async function runParallelTierChecks(check) {
  const gate = { calls: 0, release: null };
  const both = new Promise((resolve) => {
    gate.release = resolve;
  });
  const client = {
    async query() {
      gate.calls += 1;
      if (gate.calls >= 2) gate.release();
      await both;
      return [];
    },
  };

  const answered = await Promise.race([
    searchProjection(client, { query: "quokka", tier: "private" }).then(() => "answered"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  check("a personal caller's two tiers are queried together, not one after the other", answered === "answered");
  check("and both really were asked", gate.calls === 2);

  // The budget is settled for every table before any of them runs, so a pass
  // that cannot afford the second never issues the first. A reserve taken out
  // of what the previous stage happened to leave is not a reserve.
  const spent = [];
  const counted = {
    async query() {
      spent.push(1);
      return [];
    },
  };
  const budget = createSearchBudget(1);
  const refused = await searchProjection(counted, {
    query: "quokka",
    tier: "private",
    budget,
  });
  check("a budget too small for both tiers answers nothing", refused === null);
  check("and issues no query at all", spent.length === 0);
}

export async function runSweepCompletionChecks(check) {
  const backend = createD1Backend();
  const client = createD1Client(DESCRIPTOR, { fetchImpl: (u, i) => backend.handle(u, i) });

  const TOTAL = 250;
  const notes = {};
  const census = new Map();
  for (let n = 0; n < TOTAL; n += 1) {
    const path = `1-projects/n${String(n).padStart(3, "0")}.md`;
    notes[path] = `# Note ${n}\n\nA numbat, number ${n}.\n`;
    census.set(path, `v${n}`);
  }
  const store = noteStore(notes);

  const reports = [];
  let readyAt = null;
  let passes = 0;
  // Generous but finite: 250 notes at the pass cap is ~13 passes, and a loop
  // that cannot end is a test that hangs rather than fails.
  while (passes < 200) {
    passes += 1;
    const result = await projectPass(store, client, {
      census,
      visibilityOf: () => "team",
      budget: createSearchBudget(400),
      reportProgress: (p) => reports.push(p),
    });
    const indexed = backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n;
    const last = reports[reports.length - 1];
    if (readyAt === null && last && last.state === "ready") readyAt = indexed;
    if (indexed >= TOTAL && result.sweepComplete) break;
  }

  const indexed = backend.rows("SELECT COUNT(*) AS n FROM notes")[0].n;
  check(
    "a census larger than one probe window is copied in full",
    indexed === TOTAL,
  );
  check(
    "and the sweep does not call itself complete at the window boundary",
    readyAt === null || readyAt === TOTAL,
  );
  check(
    "no report ever counts more notes than the census holds",
    reports.every((report) => report.notesIndexed <= TOTAL),
  );
  check(
    "so `ready` is never sent over a partially copied context",
    reports
      .filter((report) => report.state === "ready")
      .every((report) => report.notesIndexed === TOTAL && report.notesPending === 0),
  );
  check(
    "and it is sent once the whole census is in",
    reports.some((report) => report.state === "ready"),
  );
  backend.close();
}

