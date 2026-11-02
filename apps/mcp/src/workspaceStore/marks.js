/**
 * "A change is coming": marks a writer leaves in the workspace's object before it changes the tree in the control
 * plane, so the object knows it is behind without asking anybody.
 *
 * The control plane still takes tree writes (rows, moves, access) and pushes them here after they commit
 * (`apps/convex/functions/workspaceObjectPush.ts`). A write that may narrow what someone sees (access taken back,
 * a move into a private folder, a note trashed) opens a mark here first (`ws.mark.open`), then commits, then the
 * push that carries it closes the mark in the same storage transaction as its rows (`ws.apply` `close`). While any
 * mark is open, a reader's question waits for the push (`MARK_WAIT_MS`), and if it has still not landed the answer
 * says `behind: true`, so the gateway answers from the control plane instead of from rows the writer is changing.
 * The object is never the one place that serves a share somebody has just taken back.
 *
 * A mark always ends: closed by the push that carries its change, closed by its writer when its change failed, or
 * at its expiry (`MAX_MARK_MS`) when its writer died before committing anything. While it is open, the object fails
 * towards the control plane, never towards wider rows.
 */

/** The longest a mark is kept: a writer that dies between opening one and committing leaves nothing to push. */
export const MAX_MARK_MS = 10 * 60 * 1000;
/** How long a reader's question waits for an open mark's push before it answers `behind`. */
export const MARK_WAIT_MS = 2_000;
const WAIT_STEP_MS = 20;
/** The most marks one call opens or closes. */
const MAX_TOKENS = 500;

const SCHEMA = [`CREATE TABLE IF NOT EXISTS ws_marks (token TEXT PRIMARY KEY, until INTEGER NOT NULL)`];

export class WorkspaceMarkRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkspaceMarkRefused";
  }
}

const isToken = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);

function tokensOf(tokens) {
  if (!Array.isArray(tokens) || tokens.length > MAX_TOKENS || !tokens.every(isToken)) throw new WorkspaceMarkRefused(`marks come as 0 to ${MAX_TOKENS} tokens`);
  return tokens;
}

/** The marks table over a Durable Object's `sql`. `now` is a clock, for the tests. */
export function workspaceMarks(sql, { now = () => Date.now() } = {}) {
  for (const statement of SCHEMA) sql.exec(statement);
  const rows = (cursor) => (typeof cursor?.toArray === "function" ? cursor.toArray() : []);
  const marks = {
    /** Open a mark; `ttlMs` is capped at `MAX_MARK_MS`. Opening one already open moves its expiry on. */
    open(token, ttlMs = MAX_MARK_MS) {
      if (!isToken(token)) throw new WorkspaceMarkRefused("a mark needs its token");
      const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.min(ttlMs, MAX_MARK_MS) : MAX_MARK_MS;
      const until = now() + ttl;
      sql.exec(`DELETE FROM ws_marks WHERE until <= ?`, now());
      sql.exec(`INSERT INTO ws_marks (token, until) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET until = excluded.until`, token, until);
      return { open: true, until };
    },
    /** Close marks: their change has landed, or will never come. Closing one not held is nothing. */
    close(tokens) {
      let closed = 0;
      for (const token of tokensOf(tokens)) {
        const held = rows(sql.exec(`SELECT token FROM ws_marks WHERE token = ?`, token)).length > 0;
        if (held) {
          sql.exec(`DELETE FROM ws_marks WHERE token = ?`, token);
          closed += 1;
        }
      }
      return { closed };
    },
    /** How many marks are open now. A read only reads: expired ones are dropped when a mark is opened. */
    count() {
      return Number(rows(sql.exec(`SELECT COUNT(*) AS n FROM ws_marks WHERE until > ?`, now()))[0]?.n ?? 0);
    },
    behind() {
      return marks.count() > 0;
    },
  };
  return marks;
}

/**
 * Wait while a change is coming: `false` once no mark is open, `true` if one still is after `waitMs`. Awaiting a
 * timer lets the object take other calls meanwhile, the push that closes the mark among them.
 */
export async function waitForMarks(marks, { waitMs = MARK_WAIT_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (marks === null || marks === undefined || !marks.behind()) return false;
  for (let waited = 0; waited < waitMs; waited += WAIT_STEP_MS) {
    await sleep(WAIT_STEP_MS);
    if (!marks.behind()) return false;
  }
  return true;
}

export { tokensOf as markTokens };
