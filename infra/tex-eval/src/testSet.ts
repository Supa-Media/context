import { DurableObject } from "cloudflare:workers";
import { ATTEMPTS_MISMATCH, SHA, attemptsOf, counts, dayOf, mayRun, problemWith, unitTests, verdict, type Attempts, type Conversation, type Test, type Verdict } from "./rules";
import { searchCounts as countSearchCases, searchProblemWith, type SearchCase, type SearchResult } from "./searchRules";
import { allCases, caseList, caseOf, createSearchTables, deleteCase, finishSearch, searchRunRows, seedCases, startSearch, upsertCase, type SearchRunRow } from "./searchStore";

/**
 * The Test Set: one Durable Object, the only place its conversations are kept. Nothing here is logged but ids and
 * counts; no method hands a conversation's words to anything but the two callers the Worker lets in (a person in
 * the Lab through the gateway's `PeopleDoor`, and main's Test Set workflow starting a run).
 */

export interface RunStart {
  pr: number;
  sha: string;
  base: string;
  ghRun: string;
  actor?: string;
  /** The patch-id of the pull request's diff from main: the same on a commit that only merges main. */
  change?: string;
}
export interface RunRow {
  id: string;
  pr: number;
  sha: string;
  base: string;
  at: number;
  gh_run: string;
  verdict: Verdict | null;
  allowance: boolean;
}

export class TestSet extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, body TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, sha TEXT NOT NULL, base TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, gh_run TEXT NOT NULL, tests TEXT NOT NULL, verdict TEXT, allowance INTEGER NOT NULL DEFAULT 0)`);
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(runs)`).toArray().some((c) => c.name === "change")) this.sql.exec(`ALTER TABLE runs ADD COLUMN change TEXT`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS allowances (pr INTEGER PRIMARY KEY, left INTEGER NOT NULL)`);
    // Who changed what, by id only.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS audit (at INTEGER NOT NULL, who TEXT NOT NULL, what TEXT NOT NULL, subject TEXT NOT NULL)`);
    // The Search Test: its own tables in this object (docs/decisions/testing/test-set-service.md).
    createSearchTables(this.sql);
  }

  private audit(who: string, what: string, subject: string) {
    this.sql.exec(`INSERT INTO audit (at, who, what, subject) VALUES (?, ?, ?, ?)`, Date.now(), who, what, subject);
    console.log(JSON.stringify({ event: "tex_eval", what, subject, who }));
  }

  private all(): Conversation[] {
    return this.sql.exec<{ body: string }>(`SELECT body FROM chats ORDER BY id`).toArray().map((r) => JSON.parse(r.body) as Conversation);
  }

  // ---- people (the Lab, through the gateway) ----

  list() {
    const rows = this.sql.exec<{ body: string; by: string; at: number }>(`SELECT body, by, at FROM chats ORDER BY id`).toArray();
    const chats = rows.map((r) => {
      const c = JSON.parse(r.body) as Conversation;
      const labels = c.msgs.reduce((a, m) => a + (m && !m.tex ? Object.keys(m.labels ?? {}).length : 0), 0);
      return { id: c.id, title: c.title ?? c.id, kind: c.kind ?? null, members: c.members ?? [], msgs: c.msgs.length, stars: unitTests(c).length, labels, by: r.by, at: r.at };
    });
    return { chats, counts: counts(this.all()) };
  }

  get(id: string): Conversation | null {
    const row = this.sql.exec<{ body: string }>(`SELECT body FROM chats WHERE id = ?`, id).toArray()[0];
    return row ? (JSON.parse(row.body) as Conversation) : null;
  }

  put(conv: Conversation, who: string) {
    const problem = problemWith(conv);
    if (problem) return { ok: false as const, problems: [problem] };
    this.sql.exec(`INSERT INTO chats (id, body, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, by = excluded.by, at = excluded.at`, conv.id, JSON.stringify(conv), who, Date.now());
    this.audit(who, "put", conv.id);
    return { ok: true as const, kept: conv.id, counts: counts(this.all()) };
  }

  remove(id: string, who: string) {
    const had = this.sql.exec(`DELETE FROM chats WHERE id = ?`, id).rowsWritten > 0;
    if (had) this.audit(who, "remove", id);
    return { removed: had ? id : null, counts: counts(this.all()) };
  }

  /** A person gives a capped pull request one more run. */
  allow(pr: number, who: string) {
    if (!Number.isInteger(pr) || pr <= 0) return { ok: false as const, why: "name a pull request by its number" };
    this.sql.exec(`INSERT INTO allowances (pr, left) VALUES (?, 1) ON CONFLICT(pr) DO UPDATE SET left = left + 1`, pr);
    this.audit(who, "allow", `#${pr}`);
    const left = this.sql.exec<{ left: number }>(`SELECT left FROM allowances WHERE pr = ?`, pr).one().left;
    return { ok: true as const, pr, left };
  }

  counts() {
    return counts(this.all());
  }

  /** Recent runs: pull request, commit, when, and the verdict's counts. No words. */
  runs(limit = 20) {
    return this.sql
      .exec<{ id: string; pr: number; sha: string; base: string; at: number; gh_run: string; verdict: string | null; allowance: number }>(`SELECT id, pr, sha, base, at, gh_run, verdict, allowance FROM runs ORDER BY at DESC LIMIT ?`, Math.min(Math.max(1, limit), 100))
      .toArray()
      .map((r): RunRow => ({ ...r, verdict: r.verdict ? (JSON.parse(r.verdict) as Verdict) : null, allowance: r.allowance === 1 }));
  }

  // ---- the Search Test: people (the Lab, through the gateway) ----

  searchList() {
    return { cases: caseList(this.sql), counts: countSearchCases(allCases(this.sql)) };
  }

  searchGet(id: string): SearchCase | null {
    return caseOf(this.sql, id);
  }

  searchPut(c: SearchCase, who: string) {
    const problem = searchProblemWith(c);
    if (problem) return { ok: false as const, problems: [problem] };
    upsertCase(this.sql, c, who, Date.now());
    this.audit(who, "search-put", c.id);
    return { ok: true as const, kept: c.id, counts: countSearchCases(allCases(this.sql)) };
  }

  searchRemove(id: string, who: string) {
    const had = deleteCase(this.sql, id);
    if (had) this.audit(who, "search-remove", id);
    return { removed: had ? id : null, counts: countSearchCases(allCases(this.sql)) };
  }

  searchCounts() {
    return countSearchCases(allCases(this.sql));
  }

  /** Recent search runs: no ids, no words. */
  searchRuns(limit = 20): SearchRunRow[] {
    return searchRunRows(this.sql, Number(limit));
  }

  // ---- main's Test Set workflow ----

  /** A run starts: capped, then handed every Test conversation. The same GitHub run asking again gets its own run back. */
  startRun(s: RunStart, now = Date.now()) {
    if (!Number.isInteger(s.pr) || s.pr <= 0) return { ok: false as const, why: "name the pull request" };
    if (!SHA.test(s.sha) || !SHA.test(s.base)) return { ok: false as const, why: "name the commit and main's commit in full" };
    const same = this.sql.exec<{ id: string }>(`SELECT id FROM runs WHERE gh_run = ? AND sha = ? AND verdict IS NULL`, s.ghRun, s.sha).toArray()[0];
    const chats = this.all();
    if (same) return { ok: true as const, run: same.id, conversations: chats };
    const n = (q: string, v: string | number) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE ${q} = ?`, v).one().n;
    const allowed = this.sql.exec<{ left: number }>(`SELECT left FROM allowances WHERE pr = ?`, s.pr).toArray()[0]?.left ?? 0;
    const change = s.change && SHA.test(s.change) ? s.change : null;
    // A run with no change named counts as a change of its own.
    const changes = this.sql.exec<{ n: number }>(`SELECT COUNT(DISTINCT COALESCE(change, id)) AS n FROM runs WHERE pr = ?`, s.pr).one().n;
    const sameChange = change !== null && this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE pr = ? AND change = ?`, s.pr, change).one().n > 0;
    const may = mayRun({ commit: n("sha", s.sha), pr: changes, sameChange, day: n("day", dayOf(now)), allowed });
    if (!may.ok) return { ok: false as const, why: may.why };
    if (may.spendsAllowance) this.sql.exec(`UPDATE allowances SET left = left - 1 WHERE pr = ?`, s.pr);
    const tests: Test[] = chats.flatMap(unitTests);
    const id = crypto.randomUUID();
    this.sql.exec(`INSERT INTO runs (id, pr, sha, base, day, at, gh_run, tests, allowance, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, s.pr, s.sha, s.base, dayOf(now), now, s.ghRun, JSON.stringify(tests), may.spendsAllowance ? 1 : 0, change);
    this.audit(s.actor ? `github:${s.actor}` : "github", "run", `#${s.pr} ${s.sha.slice(0, 7)}`);
    return { ok: true as const, run: id, conversations: chats };
  }

  /** The run's answers come back: scored here, against the tests it was handed, once. */
  finishRun(run: string, ghRun: string, branch: Attempts, main: Attempts) {
    const row = this.sql.exec<{ tests: string; gh_run: string; verdict: string | null }>(`SELECT tests, gh_run, verdict FROM runs WHERE id = ?`, run).toArray()[0];
    if (!row || row.gh_run !== ghRun) return { ok: false as const, why: "no such run for this workflow run" };
    if (row.verdict) return { ok: true as const, verdict: JSON.parse(row.verdict) as Verdict };
    // Checked before scoring, and nothing is stored on a refusal: the run can be answered again.
    const b = attemptsOf(branch);
    const m = attemptsOf(main);
    if (!b || !m || b.length !== m.length) return { ok: false as const, why: ATTEMPTS_MISMATCH };
    const v = verdict(JSON.parse(row.tests) as Test[], b, m);
    this.sql.exec(`UPDATE runs SET verdict = ? WHERE id = ?`, JSON.stringify(v), run);
    return { ok: true as const, verdict: v };
  }

  /** The held-out cases moved in by main's seed workflow: kept where no conversation has the id, never overwriting. */
  seed(convs: Conversation[], ghRun: string) {
    const kept: string[] = [];
    const skipped: string[] = [];
    for (const c of Array.isArray(convs) ? convs : []) {
      const problem = problemWith(c);
      if (problem || this.get(c.id)) {
        skipped.push(problem ? `${String((c as Conversation)?.id ?? "?")}: ${problem}` : `${c.id}: already here`);
        continue;
      }
      this.sql.exec(`INSERT INTO chats (id, body, by, at) VALUES (?, ?, ?, ?)`, c.id, JSON.stringify(c), `seed:${ghRun}`, Date.now());
      kept.push(c.id);
    }
    if (kept.length) this.audit(`github-run:${ghRun}`, "seed", `${kept.length} chats`);
    return { kept: kept.length, skipped, counts: counts(this.all()) };
  }

  // ---- the Search Test: main's search workflows ----

  /** A search run starts: capped on search runs only, then handed every search case. */
  startSearchRun(s: RunStart, now = Date.now()) {
    const started = startSearch(this.sql, s, now);
    if (!started.ok) return started;
    if (!started.same) this.audit(s.actor ? `github:${s.actor}` : "github", "search-run", `#${s.pr} ${s.sha.slice(0, 7)}`);
    return { ok: true as const, run: started.run, cases: started.cases };
  }

  /** The search run's answers come back: scored here, against the cases it was handed, once. */
  finishSearchRun(run: string, ghRun: string, branch: SearchResult[], main: SearchResult[]) {
    return finishSearch(this.sql, run, ghRun, branch, main);
  }

  /** The held-out search cases moved in by main's seed workflow: kept where no case has the id, never overwriting. */
  seedSearch(cases: unknown[], ghRun: string, now = Date.now()) {
    const { kept, skipped } = seedCases(this.sql, cases, ghRun, now);
    if (kept.length) this.audit(`github-run:${ghRun}`, "search-seed", `${kept.length} cases`);
    return { kept: kept.length, skipped, counts: countSearchCases(allCases(this.sql)) };
  }
}
