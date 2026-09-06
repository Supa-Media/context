/**
 * A search database, in memory, for the control plane's own backfill.
 *
 * `apps/mcp/test/searchProjection.test.mjs` drives the projection against real
 * SQL through `node:sqlite`, and that is where every property *of the stored
 * rows* is proved: which table a private note lands in, what happens when a
 * note changes visibility, what a chunk boundary does to a phrase. **None of
 * that is re-proved here**, and this stub deliberately cannot: it models the
 * nine statements `d1/project.js` and `d1/backfill.js` emit and nothing else.
 *
 * What these tests are about is one layer up — whether a pass runs at all
 * without anybody searching, whether the chain behind it terminates, and
 * whether what it learns reaches the row. A `node:sqlite` database would make
 * those tests slower and no more true, and would need a Node-only import in a
 * suite that runs under `@edge-runtime/vm`.
 *
 * `runAll` is a hand copy of `createD1Client`'s, **including the budget peek
 * before the first statement is charged** — a group is never started that the
 * counter cannot finish. Copied rather than imported because the real one is
 * welded to `fetch`; the two are held together by the fact that a drift shows
 * up as a pass that lands a half-written note, which the checks below notice.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { D1Error } from "../../mcp/src/search/d1/client.js";

interface Budget {
  remaining: number;
  take(reserve: number): boolean;
}

export interface StubD1 {
  /** Paths in the `notes` table, sorted. */
  paths(): string[];
  /** The visibility recorded for a path, or `null`. */
  visibilityOf(path: string): string | null;
  /** FTS rows for a path in one tier. */
  chunksIn(tier: "private" | "team", path: string): number;
  /** Statements that CHANGED something, in order. Empty after a pure read. */
  writes: string[];
  /** The backfill cursor, as the projection left it. */
  cursor(): string;
  /** Statements this database was asked to run, in order. */
  statements: string[];
  /** Answer everything with this failure code until cleared. */
  fail: string | null;
  client: {
    query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
    runAll(
      statements: readonly { sql: string; params?: unknown[] }[],
      options?: { budget?: unknown; reserve?: number },
    ): Promise<{ applied: number; skipped: boolean }>;
  };
}

/**
 * One context's projection.
 *
 * The concurrency check hands the same `client` to two passes at once, which
 * is exactly what two racing passes see: one database, two readers of one
 * cursor.
 */
export function stubD1(): StubD1 {
  const notes = new Map<string, Record<string, unknown>>();
  /**
   * The FTS rows, as text rather than as a count.
   *
   * The count was all these tests needed while the projection had no reader.
   * Now that `searchNotes` asks it a question, a row has to be able to answer
   * one — see `matchRows`.
   */
  interface Chunk {
    path: string;
    ord: number;
    title: string;
    text: string;
  }
  const fts = {
    private: [] as Chunk[],
    team: [] as Chunk[],
  };
  const indexState = new Map<string, string>();

  const stub: StubD1 = {
    statements: [],
    writes: [],
    fail: null,
    paths: () => [...notes.keys()].sort(),
    visibilityOf: (path) => (notes.get(path)?.visibility as string) ?? null,
    chunksIn: (tier, path) => fts[tier].filter((chunk) => chunk.path === path).length,
    cursor: () => indexState.get("backfill_cursor") ?? "",
    client: { query, runAll },
  };

  /**
   * Answer one `searchSql` SELECT, and answer it BADLY on purpose.
   *
   * A whole-word AND over the row's text, with none of FTS5's ranking, its
   * tokenizer, its snippet windows or its corpus statistics. Every property of
   * the real query — `bm25` weights, the negative scores, the tier split's
   * effect on ranking, what a chunk boundary does to a phrase — is proved
   * against real SQLite in `apps/mcp/test/searchD1.test.mjs` and
   * `searchProjection.test.mjs`, and re-proving it here against a model of my
   * own assumptions would bless them rather than test them.
   *
   * What it exists for is the layer above: does the console CALL the
   * projection, does its own `canSee` filter what comes back, does a miss fall
   * through to the R2 index, and does a refused database leave a working
   * search. Those are properties of `fileOps.ts`, and they need a row that can
   * answer, not a row that is right.
   */
  function matchRows(sql: string, params: unknown[]): Record<string, unknown>[] {
    const tier = sql.includes("notes_private_fts") ? "private" : "team";
    const wanted = String(params[0] ?? "")
      .split(/\s+/)
      .map((token) => token.replace(/^"|"$/g, "").toLowerCase())
      .filter((token) => token.length > 0);
    // `substr(path, 1, length(?)) = ?` binds the prefix twice; the limit is
    // always last.
    const prefix = params.length > 2 ? String(params[1]) : "";
    const limit = Number(params[params.length - 1]) || 25;

    return fts[tier]
      .filter((chunk) => chunk.path.startsWith(prefix))
      .filter((chunk) => {
        const haystack = `${chunk.title} ${chunk.text}`.toLowerCase();
        const words = new Set(haystack.split(/[^\p{L}\p{N}_]+/u));
        return wanted.every((token) => words.has(token));
      })
      .slice(0, limit)
      .map((chunk, index) => ({
        path: chunk.path,
        ord: chunk.ord,
        title: chunk.title,
        // Negative, because SQLite's `bm25()` is, and `mergeHits` negates it
        // back. A stub that returned positives would invert every ranking.
        score: -1 - index / 1000,
        snippet: chunk.text,
      }));
  }

  async function query(
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    stub.statements.push(sql);
    if (/^\s*(INSERT|DELETE|UPDATE|REPLACE|CREATE)/i.test(sql)) stub.writes.push(sql);
    if (stub.fail !== null) throw new D1Error(stub.fail);

    if (sql.includes("FROM index_state")) {
      return [...indexState].map(([key, value]) => ({ key, value }));
    }
    if (sql.includes("INSERT INTO index_state")) {
      indexState.set(String(params[0]), String(params[1]));
      return [];
    }
    if (sql.includes("COUNT(*)")) return [{ n: notes.size }];
    // The tables here exist by construction, so applying the schema is a
    // no-op — but it must be an *answered* no-op: `provisionIndex` runs
    // `SCHEMA_STATEMENTS` through the same endpoint, and a stub that refused
    // them would record a provision failure instead of `backfilling`.
    if (sql.startsWith("CREATE ")) return [];
    if (sql.includes("SELECT path, version FROM notes")) {
      return params
        .filter((path) => notes.has(String(path)))
        .map((path) => ({
          path: String(path),
          version: notes.get(String(path))!.version,
        }));
    }
    if (sql.startsWith("DELETE FROM notes WHERE")) {
      notes.delete(String(params[0]));
      return [];
    }
    if (sql.startsWith("DELETE FROM notes_private_fts")) {
      fts.private = fts.private.filter((chunk) => chunk.path !== String(params[0]));
      return [];
    }
    if (sql.startsWith("DELETE FROM notes_team_fts")) {
      fts.team = fts.team.filter((chunk) => chunk.path !== String(params[0]));
      return [];
    }
    if (sql.startsWith("INSERT INTO notes (")) {
      notes.set(String(params[0]), {
        version: params[1],
        visibility: params[2],
        title: params[3],
        uploaded: params[4],
        chunks: params[5],
      });
      return [];
    }
    if (sql.startsWith("INSERT INTO notes_private_fts") || sql.startsWith("INSERT INTO notes_team_fts")) {
      // `upsertStatements` binds (path, ord, title, headings, tags, body).
      const tier = sql.includes("notes_private_fts") ? "private" : "team";
      fts[tier].push({
        path: String(params[0]),
        ord: Number(params[1]) || 0,
        title: String(params[2] ?? ""),
        text: [params[3], params[4], params[5]].map((part) => String(part ?? "")).join(" "),
      });
      return [];
    }
    if (/^\s*SELECT[\s\S]*FROM notes_(private|team)_fts/i.test(sql)) {
      return matchRows(sql, params);
    }
    // Loud rather than silent: a statement this stub does not model is a
    // projection doing something these tests are not checking at all.
    throw new Error(`the projection sent a statement this stub does not model: ${sql}`);
  }

  async function runAll(
    statements: readonly { sql: string; params?: unknown[] }[],
    options: { budget?: unknown; reserve?: number } = {},
  ): Promise<{ applied: number; skipped: boolean }> {
    const list = Array.isArray(statements) ? statements : [];
    if (list.length === 0) return { applied: 0, skipped: false };
    const budget = options.budget as Budget | undefined;
    const reserve = options.reserve ?? 0;
    if (budget && budget.remaining <= reserve + list.length) {
      return { applied: 0, skipped: true };
    }
    let applied = 0;
    for (const statement of list) {
      if (budget) budget.take(reserve);
      await query(statement.sql, statement.params ?? []);
      applied += 1;
    }
    return { applied, skipped: false };
  }

  return stub;
}

/**
 * The stub behind Cloudflare's D1 query endpoint, layered over a bucket.
 *
 * `runFileOperation` builds the real `createD1Client` out of a credential it
 * read from `appSecrets`, so an action-level test cannot hand it a client — it
 * has to answer the wire. This routes `api.cloudflare.com` at the stub above
 * and everything else (the bucket) at `next`, which is how one `fetch` stub
 * serves both halves of a pass.
 *
 * It answers the provider's envelope exactly, including the part that catches
 * people out: a **refused statement comes back 200 with `success: false`**, so
 * a client that only looked at the status would read a failure as a result.
 */
export function d1AndBucketFetch(
  stub: StubD1,
  next: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
): (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = typeof input === "string" ? input : String((input as URL).toString());
    if (!url.startsWith("https://api.cloudflare.com/")) return await next(input, init);

    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (!url.endsWith("/query")) {
      // Creating or deleting the database itself, which answers a different
      // envelope: `{result: {uuid, name}}` rather than a rows array.
      return new Response(
        JSON.stringify({
          success: true,
          result: { uuid: "example-database-0000", name: String(body.name ?? "") },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (stub.fail !== null) {
      return new Response(
        JSON.stringify({
          // Provider text naming an account and a database, deliberately: none
          // of it may reach a log, an error, or the row a person reads.
          errors: [
            {
              code: 7403,
              message: `D1 database example-database on account example-account is not authorized`,
            },
          ],
          success: false,
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    let results: unknown[] = [];
    try {
      results = await stub.client.query(body.sql, body.params ?? []);
    } catch {
      return new Response(JSON.stringify({ success: false, errors: [] }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({ success: true, result: [{ results, success: true }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
}
