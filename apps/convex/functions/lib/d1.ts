/**
 * The search projection's database: its shape, and how to talk to it.
 *
 * Pure functions and one `fetch` against `api.cloudflare.com`, like
 * `lib/cloudflare.ts` next door and for the same reason — nothing here reads
 * or writes Convex, nothing holds a credential longer than the call it was
 * passed to, and the whole module is unit-testable against a stubbed socket.
 *
 * ## What lives in one of these, and what must not
 *
 * A **disposable derivative** of one context's notes: enough text to answer a
 * search, plus the path and version to join it back to the canonical Markdown
 * in the customer's own bucket. Deleting the database costs a rebuild and
 * loses nothing (CLAUDE.md, "Plain files stay canonical").
 *
 * One database per context, never a shared one with a tenant column. That is
 * the same rule as the buckets and for a sharper reason than tidiness: FTS5's
 * ranking reads **corpus statistics** — how many documents hold a term, how
 * long the average one is — and in a shared table those are computed across
 * every tenant. A term's rarity in one customer's notes would then shift
 * another's result order, which is an inference channel that no `WHERE` clause
 * closes. Per-database is how the statistics stay inside one boundary.
 *
 * ## Two tokens, not one
 *
 * Creating and deleting databases needs `D1:Edit` on the account. *Querying*
 * one needs only `D1:Read`. The control plane provisions and therefore holds
 * the first; anything that merely serves a search should hold the second. They
 * are separate entries in `appSecrets` so that is a configuration fact rather
 * than an intention — see `SEARCH_D1_API_TOKEN` and `SEARCH_D1_READ_TOKEN`.
 *
 * ## Statement shape
 *
 * Every call takes SQL with `?` placeholders and a params array. There is no
 * string interpolation of a value anywhere in this module and there must never
 * be one: the text being indexed is the customer's notes, and a note
 * containing `'; DROP TABLE` is an ordinary Tuesday.
 */

export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * The `appSecrets` names both halves of the write credential are stored under.
 *
 * Here rather than beside the provisioner because there are two callers now and
 * they must not be able to drift: `fastSearchProvision` opens them to create and
 * delete a database, and `controlPlane.openStorageBinding` opens them to hand
 * the gateway what it needs to write a projection into one. A second literal
 * spelling of a secret name is a deployment that is configured and a code path
 * that reads nothing, reported as "not configured yet".
 *
 * `SEARCH_D1_READ_TOKEN` — the `D1:Read` half this module's header describes —
 * has no constant because nothing reads it yet. See the caveat on
 * `openStorageBinding`: the token below carries `D1:Edit` on the whole account,
 * which is more than any one context's projection needs.
 */
export const D1_TOKEN_SECRET = "SEARCH_D1_API_TOKEN";
export const D1_ACCOUNT_SECRET = "SEARCH_D1_ACCOUNT_ID";

/** Bumped when `SCHEMA_STATEMENTS` changes in a way an existing index needs. */
export const D1_SCHEMA_VERSION = 1;

/**
 * How much of a note goes into one row.
 *
 * D1's row limit is 2MB. Chunking at well under that leaves room for the
 * FTS5 index's own overhead and keeps a single oversized note from being a
 * special case — **and it is what removes the 2,048-character cap** that the
 * R2 index has, which the search-performance note calls the largest remaining
 * source of a search that does not find something that is there. A long note
 * becomes several rows, all of them searchable, rather than a truncated one.
 */
export const CHUNK_CHARS = 4_000;

/**
 * Overlap between consecutive chunks, in characters.
 *
 * Without it, a phrase straddling a chunk boundary is in neither chunk as a
 * phrase, so a two-word search for it misses — a false negative caused purely
 * by where the arithmetic fell. The overlap is larger than any phrase a person
 * types.
 */
export const CHUNK_OVERLAP = 200;

/**
 * The projection schema.
 *
 * Two FTS5 tables rather than one, split by visibility, and that split is the
 * privacy design rather than an optimization:
 *
 * `bm25()` computes its statistics over the whole table it is asked about. A
 * single table with a `visibility` column would let a team-tier caller's result
 * *ordering* be shifted by terms that appear only in private notes — the
 * inference channel `search/CONTRACT.md` already argues about at length for the
 * R2 index ("a rewrite whose trigger is private content is an output channel
 * however it is spelled"). Querying only `notes_team_fts` computes N, df and
 * avgdl over exactly the documents that caller may read.
 *
 * The visibility recorded here is **a projection of `privacy.md` at index
 * time**, so it can go stale between an edit to that file and the next pass.
 * That is why it is not the security boundary: the live `canSee` still filters
 * every result before it leaves, exactly as it does for the R2 index. The split
 * buys correct statistics; the filter buys correctness.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS notes (
     path        TEXT PRIMARY KEY,
     version     TEXT NOT NULL,
     visibility  TEXT NOT NULL,
     title       TEXT NOT NULL,
     uploaded    TEXT,
     chunks      INTEGER NOT NULL,
     indexed_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS notes_by_visibility ON notes (visibility)`,
  // `path` and `ord` are UNINDEXED: they are how a hit is joined back to the
  // note, never something a query matches on.
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_private_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS notes_team_fts USING fts5(
     path UNINDEXED, ord UNINDEXED, title, headings, tags, body,
     tokenize = 'unicode61 remove_diacritics 2'
   )`,
  `CREATE TABLE IF NOT EXISTS index_state (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

/** The two FTS tables, by the visibility whose corpus each one is. */
export const FTS_TABLE = {
  private: "notes_private_fts",
  team: "notes_team_fts",
} as const;

export type Visibility = keyof typeof FTS_TABLE;

/**
 * The tables a caller at one tier may read.
 *
 * A personal connection reads both — its visible corpus really is every note,
 * so statistics over both are statistics over what it can see. A team
 * connection reads only the team table. **There is no third case**, and a
 * caller tier that is not one of these two is a programming error rather than
 * a default: defaulting would mean guessing, and the safe guess and the useful
 * guess are different.
 */
export function tablesForTier(tier: "private" | "team"): string[] {
  return tier === "private"
    ? [FTS_TABLE.private, FTS_TABLE.team]
    : [FTS_TABLE.team];
}

/**
 * Split a note's body into overlapping chunks.
 *
 * Returns at least one chunk, even for empty text, so `notes.chunks` is never
 * zero for a note that exists — a note with no body still has a title and a
 * path worth matching.
 */
export function chunkText(
  text: string,
  size: number = CHUNK_CHARS,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  if (typeof text !== "string" || text.length === 0) return [""];
  if (text.length <= size) return [text];
  // A stride of at least one character, whatever the arguments, so a bad
  // overlap is a slow index rather than an infinite loop.
  const stride = Math.max(1, size - Math.max(0, overlap));
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += stride) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

/**
 * Escape a user's query for FTS5's MATCH grammar.
 *
 * **This is not SQL escaping** — the query is always a bound parameter, so SQL
 * injection is closed by the placeholder. This is the *other* injection: FTS5
 * has its own expression language, in which bare `AND`, `OR`, `NOT`, `NEAR`,
 * `*`, `^`, `:` and parentheses are operators. A person searching for
 * `NEAR(a b)` or for a colon in a path means those characters literally, and
 * an unescaped query either errors or silently means something else.
 *
 * Every token is wrapped in double quotes, which is FTS5's literal-string
 * form, with embedded quotes doubled. A quoted string is a phrase, so a
 * multi-word query becomes several quoted terms — an implicit AND, which is
 * what the R2 index already does and what `search/CONTRACT.md` documents as
 * the phrase behaviour.
 */
export function toMatchExpression(query: string): string | null {
  if (typeof query !== "string") return null;
  // Split on anything that is not a letter, digit, or underscore. The
  // tokenizer will do the same thing to the indexed text, so a term that
  // survives here is a term that can match.
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" ");
}

// -- the wire ------------------------------------------------------------

export type D1ErrorCode =
  | "NOT_CONFIGURED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "REFUSED";

export class D1Error extends Error {
  readonly code: D1ErrorCode;
  constructor(code: D1ErrorCode, message: string) {
    super(message);
    this.name = "D1Error";
    this.code = code;
  }
}

export interface D1Envelope<T> {
  success: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

function classify(status: number, body: D1Envelope<unknown> | null): D1Error {
  // Our codes, from a closed set, never the provider's text — the same rule
  // `lib/cloudflare.ts` states. A provider message can name an account, a
  // database, or the token itself.
  if (status === 401 || status === 403) {
    return new D1Error("UNAUTHORIZED", "The search database credential was refused.");
  }
  if (status === 404) {
    return new D1Error("NOT_FOUND", "That search database does not exist.");
  }
  if (status === 429) {
    return new D1Error("RATE_LIMITED", "Cloudflare is rate limiting this account.");
  }
  if (status >= 500) {
    return new D1Error("UNAVAILABLE", "Cloudflare did not answer. Retry.");
  }
  const first = body?.errors?.[0]?.message;
  return new D1Error(
    "REFUSED",
    first ? `Cloudflare refused the request (${status}).` : `Cloudflare refused the request (${status}).`,
  );
}

export interface D1Config {
  accountId: string;
  apiToken: string;
  fetchImpl?: typeof globalThis.fetch;
}

async function call<T>(
  config: D1Config,
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
      method: init.method,
      headers: {
        // The token appears here and nowhere else.
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
  } catch {
    // The caught error can quote the request, headers included. Dropped rather
    // than wrapped — the same reasoning `controlPlane.js` gives.
    throw new D1Error("UNAVAILABLE", "Cloudflare could not be reached.");
  }

  let body: D1Envelope<T> | null = null;
  try {
    body = (await response.json()) as D1Envelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok || body?.success !== true) {
    throw classify(response.status, body);
  }
  return body.result as T;
}

export interface D1Database {
  uuid: string;
  name: string;
}

/** A name a person can recognize in the Cloudflare dashboard. */
export function databaseNameFor(workspaceId: string): string {
  // The workspace id, not the slug: a slug can be renamed and a database name
  // cannot, so a slug-derived name goes stale and stops matching the context
  // it belongs to. Ids are opaque and carry no customer content.
  return `context-search-${workspaceId}`.slice(0, 63);
}

export async function createDatabase(
  config: D1Config,
  name: string,
): Promise<D1Database> {
  return await call<D1Database>(config, `/accounts/${config.accountId}/d1/database`, {
    method: "POST",
    body: { name },
  });
}

export async function deleteDatabase(
  config: D1Config,
  databaseId: string,
): Promise<void> {
  try {
    await call<unknown>(
      config,
      `/accounts/${config.accountId}/d1/database/${databaseId}`,
      { method: "DELETE" },
    );
  } catch (error) {
    // A database that is already gone is a successful delete. Anything else
    // rethrows, because "we could not delete the copy of their notes" must not
    // be swallowed into a green release.
    if (error instanceof D1Error && error.code === "NOT_FOUND") return;
    throw error;
  }
}

export interface D1QueryResult<Row> {
  results: Row[];
  success: boolean;
  meta?: Record<string, unknown>;
}

/**
 * Run one statement.
 *
 * `params` are bound, never interpolated. There is no overload of this that
 * takes a formatted string, deliberately: the text flowing through here is
 * the customer's own notes.
 */
export async function query<Row = Record<string, unknown>>(
  config: D1Config,
  databaseId: string,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await call<D1QueryResult<Row>[]>(
    config,
    `/accounts/${config.accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: { sql, params } },
  );
  const first = Array.isArray(result) ? result[0] : undefined;
  return first?.results ?? [];
}

/**
 * Run several statements as one request.
 *
 * D1's `/query` endpoint accepts multiple statements separated by semicolons
 * but binds one params array across them, which is a footgun rather than a
 * feature. This sends them one at a time and stops at the first failure, so a
 * half-applied schema is a reported error rather than a database that looks
 * fine and is missing a table.
 */
export async function exec(
  config: D1Config,
  databaseId: string,
  statements: readonly string[],
): Promise<void> {
  for (const sql of statements) {
    await query(config, databaseId, sql, []);
  }
}

/**
 * The operator-facing sentence for a failure code. **Ours, from a closed set.**
 *
 * Here rather than beside the provisioner because there are two writers of
 * `searchIndexes.error` now — `provisionIndex` creating the database, and the
 * projection pass filling it — and a second copy of these sentences is two
 * spellings of the same failure for one person to compare. The rule they both
 * obey is `classify`'s: a provider message can name the account, the database,
 * or the token, so none of it is ever repeated back.
 */
export const D1_MESSAGES: Readonly<Record<string, string>> = {
  NOT_CONFIGURED:
    "Fast search is not configured on this deployment yet. An administrator needs to set SEARCH_D1_API_TOKEN and SEARCH_D1_ACCOUNT_ID.",
  UNAUTHORIZED:
    "The configured Cloudflare token was refused. It needs D1:Edit on the account in SEARCH_D1_ACCOUNT_ID.",
  NOT_FOUND: "The search database could not be found.",
  RATE_LIMITED: "Cloudflare is rate limiting this account. This will retry.",
  UNAVAILABLE: "Cloudflare could not be reached. This will retry.",
  REFUSED: "Cloudflare refused the search database request.",
};

/** `REFUSED` for a code from outside the set, which is the least specific truth. */
export function messageFor(code: string): string {
  return D1_MESSAGES[code] ?? D1_MESSAGES.REFUSED!;
}
