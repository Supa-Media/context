/**
 * The Search Test's SQL, kept out of the TestSet object so its methods stay thin. Every function takes the
 * object's SQL storage; none reads or writes anything else. Runs are capped with the Test Set's own rules (rules.ts),
 * counted on search_runs only; the allowance a person gives a pull request is the Test Set's, shared.
 */
import { SHA, dayOf, mayRun } from "./rules";
import { searchProblemWith, searchVerdict, type SearchCase, type SearchResult, type SearchVerdict } from "./searchRules";
import type { RunStart } from "./testSet";

export function createSearchTables(sql: SqlStorage) {
  sql.exec(`CREATE TABLE IF NOT EXISTS search_cases (id TEXT PRIMARY KEY, body TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS search_runs (id TEXT PRIMARY KEY, pr INTEGER NOT NULL, sha TEXT NOT NULL, base TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, gh_run TEXT NOT NULL, tests TEXT NOT NULL, verdict TEXT, allowance INTEGER NOT NULL DEFAULT 0, change TEXT)`);
}

export function allCases(sql: SqlStorage): SearchCase[] {
  return sql.exec<{ body: string }>(`SELECT body FROM search_cases ORDER BY id`).toArray().map((r) => JSON.parse(r.body) as SearchCase);
}

export function caseOf(sql: SqlStorage, id: string): SearchCase | null {
  const row = sql.exec<{ body: string }>(`SELECT body FROM search_cases WHERE id = ?`, id).toArray()[0];
  return row ? (JSON.parse(row.body) as SearchCase) : null;
}

/** The Lab's list: id, kind, the query's length (never the query), how many notes it expects, who and when. */
export function caseList(sql: SqlStorage) {
  return sql
    .exec<{ body: string; by: string; at: number }>(`SELECT body, by, at FROM search_cases ORDER BY id`)
    .toArray()
    .map((r) => {
      const c = JSON.parse(r.body) as SearchCase;
      return { id: c.id, kind: c.kind ?? null, queryLength: c.query.length, expect: c.expect.length, by: r.by, at: r.at };
    });
}

export function upsertCase(sql: SqlStorage, c: SearchCase, who: string, now: number) {
  sql.exec(`INSERT INTO search_cases (id, body, by, at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, by = excluded.by, at = excluded.at`, c.id, JSON.stringify(c), who, now);
}

/** True when a case with this id was there and is gone. */
export function deleteCase(sql: SqlStorage, id: string): boolean {
  return sql.exec(`DELETE FROM search_cases WHERE id = ?`, id).rowsWritten > 0;
}

/** The held-out search cases moved in by main's seed workflow: kept where no case has the id, never overwriting. */
export function seedCases(sql: SqlStorage, cases: unknown[], ghRun: string, now: number) {
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const c of Array.isArray(cases) ? cases : []) {
    const id = String((c as { id?: unknown } | null)?.id ?? "?");
    const problem = searchProblemWith(c);
    if (problem) {
      skipped.push(`${id}: ${problem}`);
      continue;
    }
    const sc = c as SearchCase;
    if (caseOf(sql, sc.id)) {
      skipped.push(`${sc.id}: already here`);
      continue;
    }
    sql.exec(`INSERT INTO search_cases (id, body, by, at) VALUES (?, ?, ?, ?)`, sc.id, JSON.stringify(sc), `seed:${ghRun}`, now);
    kept.push(sc.id);
  }
  return { kept, skipped };
}

/** A search run starts: capped, then handed every search case. The same GitHub run asking again gets its own run back. */
export function startSearch(sql: SqlStorage, s: RunStart, now: number) {
  if (!Number.isInteger(s.pr) || s.pr <= 0) return { ok: false as const, why: "name the pull request" };
  if (!SHA.test(s.sha) || !SHA.test(s.base)) return { ok: false as const, why: "name the commit and main's commit in full" };
  const same = sql.exec<{ id: string }>(`SELECT id FROM search_runs WHERE gh_run = ? AND sha = ? AND verdict IS NULL`, s.ghRun, s.sha).toArray()[0];
  const cases = allCases(sql);
  if (same) return { ok: true as const, run: same.id, cases, same: true };
  const n = (q: string, v: string | number) => sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM search_runs WHERE ${q} = ?`, v).one().n;
  const allowed = sql.exec<{ left: number }>(`SELECT left FROM allowances WHERE pr = ?`, s.pr).toArray()[0]?.left ?? 0;
  const change = s.change && SHA.test(s.change) ? s.change : null;
  const changes = sql.exec<{ n: number }>(`SELECT COUNT(DISTINCT COALESCE(change, id)) AS n FROM search_runs WHERE pr = ?`, s.pr).one().n;
  const sameChange = change !== null && sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM search_runs WHERE pr = ? AND change = ?`, s.pr, change).one().n > 0;
  const may = mayRun({ commit: n("sha", s.sha), pr: changes, sameChange, day: n("day", dayOf(now)), allowed });
  if (!may.ok) return { ok: false as const, why: may.why };
  if (may.spendsAllowance) sql.exec(`UPDATE allowances SET left = left - 1 WHERE pr = ?`, s.pr);
  const id = crypto.randomUUID();
  sql.exec(`INSERT INTO search_runs (id, pr, sha, base, day, at, gh_run, tests, allowance, change) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, s.pr, s.sha, s.base, dayOf(now), now, s.ghRun, JSON.stringify(cases.map((c) => c.id)), may.spendsAllowance ? 1 : 0, change);
  return { ok: true as const, run: id, cases, same: false };
}

/** The run's answers come back: scored here, against the cases it was handed, once. */
export function finishSearch(sql: SqlStorage, run: string, ghRun: string, branch: SearchResult[], main: SearchResult[]) {
  const row = sql.exec<{ tests: string; gh_run: string; verdict: string | null }>(`SELECT tests, gh_run, verdict FROM search_runs WHERE id = ?`, run).toArray()[0];
  if (!row || row.gh_run !== ghRun) return { ok: false as const, why: "no such run for this workflow run" };
  if (row.verdict) return { ok: true as const, verdict: JSON.parse(row.verdict) as SearchVerdict };
  const v = searchVerdict(JSON.parse(row.tests) as string[], Array.isArray(branch) ? branch : [], Array.isArray(main) ? main : []);
  sql.exec(`UPDATE search_runs SET verdict = ? WHERE id = ?`, JSON.stringify(v), run);
  return { ok: true as const, verdict: v };
}

export interface SearchRunRow {
  id: string;
  pr: number;
  sha: string;
  base: string;
  at: number;
  gh_run: string;
  verdict: SearchVerdict | null;
  allowance: boolean;
}

/** Recent search runs: pull request, commit, when, and the verdict's counts. No ids, no words. */
export function searchRunRows(sql: SqlStorage, limit: number): SearchRunRow[] {
  return sql
    .exec<{ id: string; pr: number; sha: string; base: string; at: number; gh_run: string; verdict: string | null; allowance: number }>(`SELECT id, pr, sha, base, at, gh_run, verdict, allowance FROM search_runs ORDER BY at DESC LIMIT ?`, Math.min(Math.max(1, limit), 100))
    .toArray()
    .map((r) => ({ ...r, verdict: r.verdict ? (JSON.parse(r.verdict) as SearchVerdict) : null, allowance: r.allowance === 1 }));
}
