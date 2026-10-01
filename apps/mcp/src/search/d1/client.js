/**
 * The gateway's wire to one context's search database.
 *
 * ## Why the gateway holds this at all
 *
 * The control plane provisions the database and deletes it; it never reads a
 * note. **The gateway is the only component in the system that opens a
 * customer's bucket**, so it is the only one that can copy notes into a
 * projection of them — see `d1/project.js`'s header for the second half of
 * that argument, which is that everything deciding *content* belongs beside
 * the search it serves.
 *
 * ## The token is radioactive
 *
 * `apiToken` is handled exactly as `secretAccessKey` is in `controlPlane.js`:
 * it arrives on the binding response, lives in memory for the life of one
 * request, and appears in exactly one place — the `Authorization` header
 * built below. It is never logged, never placed in a URL, never written to a
 * bucket, and never carried by an error.
 *
 * That last one is why this module classifies rather than relays. A provider's
 * error text can name the account, the database, or quote the request that
 * carried the token; `D1Error` therefore carries a code from a **closed set**
 * and a fixed sentence, which is the same rule `apps/convex/functions/lib/d1.ts`
 * states for the control plane's half ("our codes, from a closed set, never
 * the provider's text"). The two are deliberately the same vocabulary, so a
 * failure means the same thing whichever side saw it.
 *
 * ## One statement per request, and why not fewer
 *
 * D1's HTTP endpoint takes `{sql, params}` and answers with an array of
 * results, which reads like an invitation to send several statements at once.
 * `lib/d1.ts` declined that invitation — "it binds one params array across
 * them, which is a footgun rather than a feature" — and so does this. The
 * arithmetic of which placeholder in a multi-statement string belongs to which
 * statement is provider behaviour nobody here has verified, and the text
 * flowing through these placeholders is the customer's notes: a binding that
 * shifts by one writes one note's body into another note's row.
 *
 * The cost is real and is paid on the budget rather than hidden: a note costs
 * one request per statement, and `projectPass` bounds how many notes a pass
 * projects. A slow backfill is the failure this trades for, and a slow
 * backfill converges.
 */

/**
 * ## Why this is HTTP and not a native D1 binding
 *
 * A Worker's D1 bindings are declared in `wrangler.toml` and resolved at
 * deploy time. There is no runtime call that opens a database by id, and
 * `env.SOMETHING.prepare()` needs a name that existed when the Worker was
 * published.
 *
 * Fast search creates **one database per opted-in workspace, at runtime**, so
 * there is no binding to have. Binding them would mean a redeploy per customer
 * who flips the switch, and then a ceiling: bindings are capped per Worker, in
 * the low thousands, which is a number of customers rather than a number of
 * anything technical. Neither is a thing to build.
 *
 * So the cost is real and is paid: every query is an HTTPS request out of the
 * Worker rather than the same-colo RPC a binding gives. It is the floor for
 * this architecture, not an interim step, and what has been done about it is
 * to make the fast path issue **one round trip** instead of three — the tiers
 * go out together (`serve.js`) and the manifest moved behind the response
 * (`fastSearchAnswer`).
 *
 * The alternative that would remove it is one database for every tenant with
 * a `workspaceId` column, and that is refused by `docs/decisions/search.md`
 * for a reason no amount of latency outweighs: FTS5 computes corpus
 * statistics over a whole table, so one shared table would rank every
 * customer's search against every other customer's vocabulary.
 */

/** The provider's API root. The only host this module ever addresses. */
export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

/** How long one D1 call may take before the gateway gives up. */
const D1_TIMEOUT_MS = 8_000;

/**
 * How big one batched request may get: statements, and bytes of SQL and
 * params. A window of a hundred ordinary notes fits in one request, which is
 * the point; the caps keep a group of very long notes from becoming one body
 * big enough, or slow enough, to hit a limit of D1's own, and keep a refused
 * group small.
 */
export const D1_BATCH_STATEMENTS = 500;
export const D1_GROUP_BYTES = 512 * 1024;

/** Split statements into groups under both caps, in order. */
export function groupStatements(list) {
  const groups = [];
  let group = [];
  let bytes = 0;
  for (const statement of list) {
    const size = JSON.stringify(statement).length;
    if (group.length > 0 && (group.length >= D1_BATCH_STATEMENTS || bytes + size > D1_GROUP_BYTES)) {
      groups.push(group);
      group = [];
      bytes = 0;
    }
    group.push(statement);
    bytes += size;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

/**
 * Cap on a D1 response body.
 *
 * Every statement this gateway sends is either a write (a tiny envelope back)
 * or a bounded `SELECT` over a window of paths. A trusted service having a bad
 * day is still a way to exhaust a Worker, so the body is bounded here the way
 * `controlPlane.js` bounds its own.
 */
const D1_RESPONSE_BYTE_CAP = 1_000_000;

/**
 * Failure codes, and the whole set of them.
 *
 * Same vocabulary as `apps/convex/functions/lib/d1.ts`, so an operator reading
 * a `searchIndexes` row does not have to know which half of the system wrote
 * it.
 */
export const D1_ERROR_CODES = Object.freeze([
  "NOT_CONFIGURED",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "REFUSED",
]);

export class D1Error extends Error {
  /**
   * `detail` is for the people diagnosing a failure, and carries only what
   * this module wrote itself: `cause` from a closed set ("timeout",
   * "network", "http_<status>", "envelope", "body_read", "oversize"), the
   * statement's shape (its verb and table, from our own SQL text, never a
   * bound parameter), and how long the request took. Never a provider
   * message, never a param, never the token.
   */
  constructor(code, detail = {}) {
    super(`search index unavailable: ${code}`);
    this.name = "D1Error";
    this.code = code;
    this.failureCause = typeof detail.cause === "string" ? detail.cause : undefined;
    this.statement = typeof detail.statement === "string" ? detail.statement : undefined;
    this.elapsedMs = Number.isFinite(detail.elapsedMs) ? detail.elapsedMs : undefined;
  }
}

/**
 * The shape of one of our statements, for a log line: `INSERT notes_private_fts`.
 *
 * Read off the SQL this module was handed, which is always a literal in this
 * codebase; the customer's text only ever travels as a bound parameter, so
 * none of it can appear here.
 */
export function statementShape(sql) {
  const text = typeof sql === "string" ? sql : "";
  const verb = (text.match(/^\s*([A-Za-z]+)/) || [])[1];
  const table = (text.match(/\b(?:FROM|INTO|UPDATE|TABLE(?:\s+IF\s+(?:NOT\s+)?EXISTS)?)\s+([A-Za-z_][A-Za-z0-9_]*)/i) || [])[1];
  return [verb ? verb.toUpperCase() : "?", table || ""].join(" ").trim();
}

/** What a failure log may say about a D1 failure. See `D1Error`. */
export function failureDetailOf(error) {
  if (!(error instanceof D1Error)) return null;
  return {
    cause: error.failureCause ?? null,
    statement: error.statement ?? null,
    elapsedMs: error.elapsedMs ?? null,
  };
}

/**
 * A status becomes one of ours.
 *
 * Nothing from `body` reaches the returned error — not the message, not the
 * provider's own numeric code. The body is read only to decide that the
 * envelope failed at all, because Cloudflare answers a refused statement with
 * a 200 and `success: false`.
 */
function classify(status, detail = {}) {
  if (status === 401 || status === 403) return new D1Error("UNAUTHORIZED", detail);
  if (status === 404) return new D1Error("NOT_FOUND", detail);
  if (status === 429) return new D1Error("RATE_LIMITED", detail);
  if (status >= 500) return new D1Error("UNAVAILABLE", detail);
  return new D1Error("REFUSED", detail);
}

/**
 * The `searchIndex` sibling of a storage binding, validated.
 *
 * **Absent means fast search is off for this workspace, which is the normal
 * case and not an error** — `docs/decisions/search.md`: "off is a working
 * state, not a degraded one". So this returns `null` for anything it cannot
 * fully validate, and every caller treats `null` as "serve from R2 and do no
 * projection". A half-formed descriptor is the same as no descriptor: reaching
 * a database with two of its three coordinates is not a thing to attempt.
 *
 * `state` is the control plane's word, and a state this build does not know is
 * carried through rather than rejected — the console decides what an unknown
 * state renders as, and refusing one here would stop projecting for a
 * vocabulary the control plane is entitled to extend.
 */
export function readSearchIndexBinding(binding) {
  const descriptor = binding && typeof binding === "object" ? binding.searchIndex : null;
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return null;
  const { databaseId, accountId, apiToken, state } = descriptor;
  if (typeof databaseId !== "string" || !databaseId) return null;
  if (typeof accountId !== "string" || !accountId) return null;
  if (typeof apiToken !== "string" || !apiToken) return null;
  return {
    databaseId,
    accountId,
    apiToken,
    state: typeof state === "string" && state ? state : null,
  };
}

/**
 * A client for one database.
 *
 * Constructed per request from the binding, like the control-plane client next
 * door: it holds the token for the life of one invocation and keeps no
 * module-level state a reused isolate could carry into another tenant's call.
 */
export function createD1Client(descriptor, options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const config = readSearchIndexBinding({ searchIndex: descriptor });
  if (!config) throw new D1Error("NOT_CONFIGURED");
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(
    config.accountId
  )}/d1/database/${encodeURIComponent(config.databaseId)}/query`;

  /**
   * One round trip: POST `payload`, and return the parsed envelope's `result`.
   *
   * `shapeOf` names the statement for a failure's detail. Everything that can
   * go wrong becomes a `D1Error` from the closed set, with a cause of ours.
   */
  async function post(payload, shapeOf) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), D1_TIMEOUT_MS);
    const started = Date.now();
    const detail = (cause) => ({
      cause,
      statement: shapeOf,
      elapsedMs: Date.now() - started,
    });
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          // The token appears here and nowhere else in the process.
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        // "manual", not "error": workerd does not implement `"error"` and
        // rejects before the request is made, which the catch below would
        // flatten into an unexplainable UNAVAILABLE on every call. See
        // `scripts/check-worker-fetch-options.mjs`.
        redirect: "manual",
      });
    } catch {
      // The caught error can quote the request, `Authorization` included. It is
      // dropped on the floor rather than wrapped — `controlPlane.js`'s rule.
      // Whether our own timer fired is ours to say, and is the one fact a
      // person diagnosing "could not be reached" needs first.
      throw new D1Error(
        "UNAVAILABLE",
        detail(controller.signal.aborted ? "timeout" : "network"),
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response) throw new D1Error("UNAVAILABLE", detail("network"));
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > D1_RESPONSE_BYTE_CAP) {
      throw new D1Error("REFUSED", detail("oversize"));
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new D1Error("UNAVAILABLE", detail("body_read"));
    }
    if (text.length > D1_RESPONSE_BYTE_CAP) throw new D1Error("REFUSED", detail("oversize"));
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    // A refused statement comes back 200 with `success: false`, so the status
    // alone is not the check.
    if (response.status !== 200 || !body || body.success !== true) {
      throw classify(
        response.status,
        detail(response.status === 200 ? "envelope" : `http_${response.status}`),
      );
    }
    return { result: body.result, detail };
  }

  /**
   * Run one statement and return its rows.
   *
   * `params` are bound, never interpolated — there is deliberately no overload
   * of this taking a formatted string. The text flowing through here is the
   * customer's notes, and a note containing `'; DROP TABLE` is an ordinary
   * Tuesday.
   */
  async function query(sql, params = []) {
    const { result } = await post({ sql, params }, statementShape(sql));
    const first = Array.isArray(result) ? result[0] : undefined;
    const rows = first && Array.isArray(first.results) ? first.results : [];
    return rows;
  }

  /**
   * Set once a batch was refused, so the rest of this client's life goes
   * statement by statement rather than paying a refused request per group.
   */
  let batchRefused = false;

  /**
   * Several statements in ONE request, or `false` if D1 would not take them
   * that way.
   *
   * THE REASON A LARGE CONTEXT TOOK A DAY TO INDEX. A note is at least five
   * statements (three deletes, the `notes` row, a row per chunk) and each was
   * its own HTTPS request, against an API that allows about 1,200 requests per
   * five minutes per token. A 17,000-note context was ~90,000 requests: hours
   * of rate limiting before anything else. D1's query endpoint takes a
   * `{batch: [{sql, params}]}` body and runs it as one transaction, so a note
   * is one request, and all or none of it lands.
   *
   * Trusted only when the answer says so: one result per statement, none
   * reporting failure. A 400 or an answer of any other shape falls back to one
   * statement per request, which is what this did before and is always right.
   */
  async function batch(statements) {
    if (batchRefused) return false;
    let result;
    try {
      ({ result } = await post(
        { batch: statements.map(({ sql, params }) => ({ sql, params: params ?? [] })) },
        `BATCH ${statements.length}`,
      ));
    } catch (error) {
      if (error instanceof D1Error && error.code === "REFUSED") {
        batchRefused = true;
        return false;
      }
      throw error;
    }
    const answered =
      Array.isArray(result) &&
      result.length === statements.length &&
      result.every((entry) => entry && typeof entry === "object" && entry.success !== false);
    if (!answered) {
      batchRefused = true;
      return false;
    }
    return true;
  }

  /**
   * Run a group of statements, all or none as far as the budget is concerned.
   *
   * The budget is **peeked before the first statement is charged**, so a group
   * is never started that the counter cannot finish — a half-applied note is a
   * `notes` row whose chunks are missing, which reads as an indexed note that
   * matches nothing. The budget still counts statements, whatever the
   * transport: it bounds work, and a batch is the same work in fewer requests.
   *
   * Sent as groups under `D1_BATCH_STATEMENTS` and `D1_GROUP_BYTES`, each one
   * transaction.
   * Where D1 refuses a batch it falls back to one statement per request, which
   * is not a transaction: what makes that survivable is the cursor, which
   * advances only after a group lands, so the next pass re-projects the note —
   * and every group begins by deleting the note's rows, so re-projecting is
   * idempotent.
   *
   * Returns `{applied, skipped}` rather than throwing on a refused budget: out
   * of budget is the ordinary end of a pass, and a throw would make the
   * ordinary case look like the failure case.
   */
  async function runAll(statements, { budget = null, reserve = 0 } = {}) {
    const list = Array.isArray(statements) ? statements : [];
    if (list.length === 0) return { applied: 0, skipped: false };
    if (budget && budget.remaining <= reserve + list.length) {
      return { applied: 0, skipped: true };
    }
    let applied = 0;
    for (const group of groupStatements(list)) {
      if (budget) for (let n = 0; n < group.length; n += 1) budget.take(reserve);
      if (group.length > 1 && (await batch(group))) {
        applied += group.length;
        continue;
      }
      for (const statement of group) {
        await query(statement.sql, statement.params ?? []);
        applied += 1;
      }
    }
    return { applied, skipped: false };
  }

  return { query, runAll, databaseId: config.databaseId, state: config.state };
}
