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

/**
 * Everything `SCHEMA_STATEMENTS` creates, dropped.
 *
 * For one caller — a database this deployment is **adopting** rather than
 * creating (`ensureDatabase`). An adopted database is this workspace's own
 * from an attempt that did not finish, or from a life before the owner last
 * switched fast search off, and what it holds is a disposable derivative
 * (CLAUDE.md, "Plain files stay canonical"), so starting it empty costs a
 * rebuild and loses nothing.
 *
 * **`index_state` is the reason this exists at all**, and dropping it is not
 * tidiness. The backfill's cursor lives in that table: it records how far the
 * sweep has walked so a pass that dies is resumed rather than restarted. Adopt
 * a database with a cursor in it and the fresh backfill resumes from wherever
 * the old one stopped — every note before that point is never projected, the
 * counters say the index is complete, and the context quietly searches a
 * corpus with a hole in the front of it. A stale `notes` row for a note
 * deleted while the feature was off is the same class of wrong, more visibly.
 *
 * **`index_state` goes first**, and the order is the failure plan. These run
 * one statement at a time, so a reset can stop half way — and only the first
 * attempt resets, because the one after it finds a `databaseId` on the row and
 * goes straight to the schema. Cursor first means the worst half-applied
 * outcome is a full re-project over rows that are still there; the other order
 * leaves the cursor standing with the tables gone, which is the hole above
 * with no second chance at it.
 *
 * `notes_by_visibility` is not listed: an index goes with its table.
 */
export const RESET_STATEMENTS: readonly string[] = [
  `DROP TABLE IF EXISTS index_state`,
  `DROP TABLE IF EXISTS notes`,
  `DROP TABLE IF EXISTS notes_private_fts`,
  `DROP TABLE IF EXISTS notes_team_fts`,
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
  /**
   * What Cloudflare actually said, for the structured log and nothing else.
   *
   * **Never a row, never a screen.** `message` above and `D1_MESSAGES` below
   * are what a person reads, and the rule that keeps a provider sentence out
   * of them — it can name an account, a database or the token — is a rule
   * about what is *shown*, not about what is *known*. Dropping the provider's
   * own code and text at `classify` turned every 4xx that is not one of the
   * four statuses below into the same six words on a settings card with
   * nothing behind them anywhere: the deployment that hit one had no way to
   * learn whether it was a name already taken, an account out of databases, or
   * a statement D1 would not accept. So the detail is carried, and the
   * provisioner logs it beside the workspace id.
   *
   * Empty when the body was not JSON, which is itself worth seeing.
   */
  readonly detail: string;
  constructor(code: D1ErrorCode, message: string, detail = "") {
    super(message);
    this.name = "D1Error";
    this.code = code;
    this.detail = detail;
  }
}

export interface D1Envelope<T> {
  success: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

/**
 * Cloudflare's own account of a failure, flattened onto one line.
 *
 * Codes as well as messages: `lib/cloudflare.ts` classifies on the numeric
 * code precisely because it is the specific signal, and a log that records
 * only the status says nothing a retry would not have said.
 */
function providerDetail(
  status: number,
  body: D1Envelope<unknown> | null,
): string {
  const said = (body?.errors ?? [])
    .map((entry) =>
      [entry.code, entry.message].filter((part) => part !== undefined).join(" "),
    )
    .filter((part) => part.length > 0);
  return said.length === 0 ? `HTTP ${status}` : `HTTP ${status}: ${said.join("; ")}`;
}

function classify(status: number, body: D1Envelope<unknown> | null): D1Error {
  // Our codes, from a closed set, never the provider's text — the same rule
  // `lib/cloudflare.ts` states. A provider message can name an account, a
  // database, or the token itself. It travels as `detail`, which the caller
  // logs and never records on a row.
  const detail = providerDetail(status, body);
  if (status === 401 || status === 403) {
    return new D1Error(
      "UNAUTHORIZED",
      "The search database credential was refused.",
      detail,
    );
  }
  if (status === 404) {
    return new D1Error("NOT_FOUND", "That search database does not exist.", detail);
  }
  if (status === 429) {
    return new D1Error(
      "RATE_LIMITED",
      "Cloudflare is rate limiting this account.",
      detail,
    );
  }
  if (status >= 500) {
    return new D1Error("UNAVAILABLE", "Cloudflare did not answer. Retry.", detail);
  }
  return new D1Error(
    "REFUSED",
    `Cloudflare refused the request (${status}).`,
    detail,
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

/** Cloudflare's cap on a D1 database name. */
const D1_DATABASE_NAME_MAX = 63;

/** A name a person can recognize in the Cloudflare dashboard. */
export function databaseNameFor(workspaceId: string): string {
  // The workspace id, not the slug: a slug can be renamed and a database name
  // cannot, so a slug-derived name goes stale and stops matching the context
  // it belongs to. Ids are opaque and carry no customer content.
  //
  // **THE NAME IS AN IDENTITY, SO IT MAY NOT BE LOSSY.** `ensureDatabase`
  // adopts a database that already carries this name, and the argument for why
  // that is safe — "the name is a prefix plus an immutable, unguessable id, so
  // a database of that name IS this workspace's" — holds only while two
  // workspaces cannot produce one name. This used to end `.slice(0, 63)`,
  // which is precisely the operation that breaks that: two ids agreeing on
  // their first 48 characters become one name, and the second context adopts
  // the first one's database, resets it and projects its own notes in.
  //
  // Unreachable today, and that is why it is worth refusing rather than
  // capping: a Convex id is 32 characters against 48 available, so the only
  // way to reach it is an id format change — a change nobody would think to
  // review as a tenancy change, arriving long after the adoption logic that
  // gives it teeth. When the honest answer will not fit, there is no second
  // answer to fall back to, which is the same choice `readSearchIndexBinding`
  // makes about a half-formed descriptor and `selectWorkspace` about a default
  // outside the covered set.
  if (!workspaceId) {
    throw new Error("a search database needs a workspace id to be named after");
  }
  const name = `context-search-${workspaceId}`;
  if (name.length > D1_DATABASE_NAME_MAX) {
    throw new Error(
      `a search database name may be at most ${D1_DATABASE_NAME_MAX} characters; ` +
        "this workspace id does not fit, and truncating one would let two contexts " +
        "share a database",
    );
  }
  return name;
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

/**
 * The database of exactly this name in this account, or `null`.
 *
 * Cloudflare's `name` filter is a match rather than an identity, so the
 * returned list is checked for the exact name before anything is adopted from
 * it: `databaseNameFor` is a prefix plus a workspace id, and a filter that
 * matched loosely would hand back a different context's database. An entry
 * without a `uuid` is not a database anything can talk to and is skipped.
 */
export async function findDatabaseByName(
  config: D1Config,
  name: string,
): Promise<D1Database | null> {
  const listed = await call<D1Database[]>(
    config,
    `/accounts/${config.accountId}/d1/database?name=${encodeURIComponent(name)}`,
    { method: "GET" },
  );
  if (!Array.isArray(listed)) return null;
  const match = listed.find(
    (entry) =>
      entry?.name === name &&
      typeof entry?.uuid === "string" &&
      entry.uuid.length > 0,
  );
  return match ?? null;
}

/**
 * The database for this context: created, or adopted if it is already there.
 *
 * ADOPTING IS THE CORRECT BEHAVIOUR HERE, and it is the same argument
 * `managedProvisioning.ts` makes about a taken bucket name. A taken name in
 * the *customer's* account is a question — it might be theirs. In ours there
 * is no such doubt: the name is `context-search-<workspace id>`, the id is
 * immutable and unguessable, and only this deployment creates databases in
 * that account. A database of that name **is** this workspace's, so the run
 * takes it rather than refusing.
 *
 * Refusing is what it used to do, and the cost was not a slower retry but a
 * permanent one. A create whose name is taken answers from outside the four
 * statuses `classify` names, so it landed on `REFUSED` — which
 * `fastSearchProvision` treats as terminal, correctly, because a malformed
 * request does not become well-formed by waiting. The row went `failed` with
 * six words on it, the card's "Try again" ran the identical create, and it
 * failed identically for as long as anybody pressed it. Every way the name
 * comes to be taken is a way in: a create whose answer was lost, a schedule
 * that raced another, a release that deleted the row and not the database, or
 * a database migrated into this account under the name a later provision will
 * ask for.
 *
 * **The lookup runs only after a create has already failed**, so the ordinary
 * first provision is one request as before. A lookup that fails too rethrows
 * the *create's* error: the create is what the caller was doing, and "we could
 * not check" is not a more useful thing to report than what Cloudflare said.
 *
 * Gated on what is **there**, not on which code came back. Which status
 * Cloudflare answers a taken name with is provider behaviour this repo does
 * not control and has never tested (`fastSearch.test.ts` says so in as many
 * words), so a rule keyed on one would be a guess that fails silently if it is
 * wrong. "A database of this exact name exists in our account" is checkable,
 * and it is the whole condition adoption needs. It also catches the create
 * whose answer was lost rather than refused, which is the same orphan by a
 * different route. A credential that may not create one usually may not list
 * them either, so this is no way past a refused token.
 */
export async function ensureDatabase(
  config: D1Config,
  name: string,
): Promise<{ database: D1Database; adopted: boolean }> {
  try {
    return { database: await createDatabase(config, name), adopted: false };
  } catch (error) {
    if (!(error instanceof D1Error)) throw error;
    let existing: D1Database | null = null;
    try {
      existing = await findDatabaseByName(config, name);
    } catch {
      throw error;
    }
    if (existing === null) throw error;
    return { database: existing, adopted: true };
  }
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
