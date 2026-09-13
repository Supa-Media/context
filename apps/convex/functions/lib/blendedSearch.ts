/**
 * One search across several contexts, blended into one list.
 *
 * The console's search page asks a question the per-context search cannot:
 * *"where did anybody write about the review cycle"*, over every workspace and
 * workspace this person can reach. This module is the pure half of the answer
 * — the fusion, the paging and the cursor — with no Convex, no store and no
 * credential in it, so every rule below is drivable from a test.
 *
 * `functions/files.ts`'s `searchContexts` is the impure half: it resolves who
 * may be asked, fans out, and calls exactly the same `searchNotes` the
 * single-context search calls. **There is no second search in this feature.**
 * `docs/decisions/search.md` says the console and an AI client must not become
 * two implementations of one question; a blended search that re-implemented
 * ranking, snippets or `canSee` would be a third.
 *
 * ## Why the fusion is rank-based and not score-based
 *
 * The obvious design is "normalize each context's scores into 0..1 and sort",
 * and it is wrong twice.
 *
 * First, there is no score to normalize. `searchNotes` returns a *ranked list*
 * and nothing else — the R2 path's BM25F numbers and the projection's `bm25()`
 * numbers never leave their own module, deliberately, because they are the one
 * thing that would let a caller tell which derivative answered.
 *
 * Second, even with the numbers in hand they are not comparable. BM25 is
 * scored against a corpus: `N`, `df` and `avglen` are properties of the
 * context the note lives in, and of the *tier* the caller reads it at
 * (`tablesForTier`). A 12-point hit in a four-note workspace and a 12-point hit
 * in a four-thousand-note workspace are not the same quantity, and min-maxing them
 * into a shared 0..1 does not make them one — it invents a comparison and hides
 * that it was invented. The failure mode is exactly the one the brief names:
 * the biggest context wins every blend, because a big corpus produces bigger
 * spreads.
 *
 * So this fuses **ranks**, with reciprocal rank fusion: a note's contribution
 * is `1 / (RRF_K + rank)` in its own context's list. Each context therefore
 * contributes the same ladder regardless of its size, and a context's first
 * result always outranks any context's third. That is the property the page
 * needs and the only one that is honestly available.
 *
 * ## Ties are broken deterministically, and that is a security property
 *
 * Two hits at the same rank in different contexts have identical scores by
 * construction. Left to `Array.prototype.sort`'s stability over an argument
 * order that comes out of `Promise.all`, the blended order would wobble between
 * two requests for the same query — which breaks paging, because a cursor
 * describes how far down each source the reader has come. Ties break on the
 * source key and then the path, both of which the caller already sees.
 */

import { MAX_RESULTS } from "../../../mcp/src/search/query.js";

/**
 * How deep into one context's ranked list a reader may ever go.
 *
 * `MAX_RESULTS` and not a number of this module's own: it is where `query.js`
 * cuts the *ranking*, so it is the last rank that exists to be read. Paging
 * past it would hand back a short page that reads as "no more matches" when
 * what actually happened is that the ranker stopped.
 *
 * The consequence is worth stating plainly rather than discovering: a blended
 * search reaches at most fifty notes per context. Going deeper is a change to
 * the ranker's cap, not to the page.
 */
export const MAX_SOURCE_DEPTH = MAX_RESULTS;

/** Results one page of the blended list holds. */
export const BLEND_PAGE_SIZE = 20;

/**
 * The reciprocal-rank constant, from the original RRF paper's `k = 60`.
 *
 * What it controls is how sharply the first result of a context beats its
 * second. Small `k` makes rank 1 dominate, so a blended page becomes "the top
 * hit from each context" and nothing else; large `k` flattens the ladder until
 * a context's tenth result interleaves with another's first. Sixty is the
 * published default and behaves well at the list lengths here (ten to fifty per
 * source); it is a tuning number, not an invariant, and nothing about
 * correctness depends on its value.
 */
export const RRF_K = 60;

/** Bytes of cursor this will parse. A longer one is somebody's experiment. */
const CURSOR_CAP = 4096;

/* -------------------------------------------------------------------------- */
/*                                   scope                                    */
/* -------------------------------------------------------------------------- */

/** A context this viewer may search: resolved live, never taken from a client. */
export interface SearchableContext {
  workspaceId: string;
  slug: string;
  displayName: string;
}

/**
 * Which contexts this request actually searches.
 *
 * `eligible` is the live answer to "which contexts is this person a member of,
 * with fast search serving" — computed in the control plane from memberships
 * and the `searchIndexes` row, per request, never cached and never sent by the
 * client. `requested` is the scope chips the page has selected, and it can
 * only ever **narrow**.
 *
 * ## The rule that makes this safe
 *
 * An id in `requested` that is not in `eligible` is dropped, silently and
 * identically whether it names a context that does not exist, one that exists
 * and this person is not in, or one they are in whose fast search is off. That
 * is `isolation.test.ts`'s rule applied to a scope list: an endpoint that
 * distinguished "not yours" from "never existed" would be an oracle for which
 * contexts are real, and a fan-out is a particularly good place to run one
 * because it accepts a *list* — a hundred guesses per request.
 *
 * Dropping rather than refusing is deliberate for the same reason. Refusing the
 * whole request on one bad id tells the caller their guess was interesting;
 * dropping it means a crafted list and an honest list that name the same
 * reachable contexts produce byte-identical answers.
 *
 * An empty or absent `requested` means every eligible context — "all fast
 * search contexts", the page's default.
 */
export function resolveScope(
  eligible: readonly SearchableContext[],
  requested: readonly string[] | undefined,
): SearchableContext[] {
  if (requested === undefined || requested.length === 0) return [...eligible];
  const asked = new Set(requested);
  return eligible.filter((context) => asked.has(context.workspaceId));
}

/* -------------------------------------------------------------------------- */
/*                                  fusion                                    */
/* -------------------------------------------------------------------------- */

/** One context's answer, as the fusion needs it. */
export interface BlendSource {
  /** The workspace id. Opaque here; it is only ever compared, never parsed. */
  key: string;
  /** The ranked list this source returned, best first. */
  hits: readonly { path: string; title: string; snippets: readonly string[] }[];
  /**
   * How many of this source's hits earlier pages already delivered.
   *
   * The hits above are the whole ranked list from rank 0, because that is the
   * only thing the ranker can produce; this is where the page resumes reading
   * it. Ranks are global to the list rather than to the page, so a note's
   * fusion score does not change depending on which page it appears on.
   */
  offset: number;
  /** How deep this source was asked to read, so paging can tell "no more". */
  asked: number;
}

export interface BlendedRow {
  /** The source this came from — the workspace id. */
  key: string;
  path: string;
  title: string;
  /** The one explanatory line, or `""` where the index had none. */
  snippet: string;
  /** Fusion score. Exposed for tests and ordering; never rendered. */
  score: number;
  /** Rank within its own context's list, from zero. */
  rank: number;
}

/**
 * Fuse the sources into one ordered list.
 *
 * Dedupe is on `(context, path)` and not on `path` alone, and that is a
 * decision rather than an oversight: `1-projects/plan.md` in two workspaces is two
 * different notes that happen to share a name, and collapsing them would hide
 * one person's work behind another's. What it does close is the same source
 * appearing twice in a scope list, which is the only way one note can arrive
 * twice.
 */
export function fuse(sources: readonly BlendSource[]): BlendedRow[] {
  const rows: BlendedRow[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const from = Math.max(0, Math.floor(source.offset));
    for (let index = from; index < source.hits.length; index += 1) {
      const hit = source.hits[index]!;
      // The separator is written as an ESCAPE and never as the character. A
      // literal NUL makes git treat the whole file as binary, so it has no
      // diff and cannot be reviewed — `check-source-diffable` fails the build
      // for exactly that. What is wanted is the character's property: it
      // cannot occur in a workspace id or a bucket key, so no two different
      // pairs can produce the same joined string.
      const id = `${source.key}\u0000${hit.path}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({
        key: source.key,
        path: hit.path,
        title: hit.title,
        snippet: hit.snippets[0] ?? "",
        score: 1 / (RRF_K + index),
        rank: index,
      });
    }
  }
  return rows.sort(
    (a, b) =>
      b.score - a.score ||
      a.key.localeCompare(b.key) ||
      a.path.localeCompare(b.path),
  );
}

export interface BlendedPage {
  rows: BlendedRow[];
  /**
   * Where each source has been read to, for the next cursor — **or `null` when
   * there is nothing left to read.**
   *
   * `null` is the whole of "no more pages": a page whose leftovers are empty
   * and whose every source ran out inside the depth it was asked for.
   */
  next: Record<string, number> | null;
}

/**
 * Cut one page, and say where each source has been read to.
 *
 * The next cursor is per source and not a global offset, which is what "stable
 * across sources" means here: page two resumes each context's own ranked list
 * exactly where page one stopped reading it, so a context that contributed one
 * result to page one is not re-read from the top on page two just because
 * another context contributed twelve.
 *
 * It is stable against the *page*, not against the *world*. A note written
 * between two pages can move a rank and be missed or repeated, because the
 * ranked list is recomputed per request over an index that is itself catching
 * up. The alternative — carrying every delivered path in the cursor — grows a
 * URL by a path per result and still cannot fix a reorder. A repeat inside one
 * page is impossible; across pages it is possible and acceptable, and it is the
 * same trade every re-queried search paginator makes.
 */
export function pageOf(
  rows: readonly BlendedRow[],
  sources: readonly BlendSource[],
  size: number = BLEND_PAGE_SIZE,
): BlendedPage {
  const taken = rows.slice(0, Math.max(1, Math.floor(size)));
  const next: Record<string, number> = {};
  for (const source of sources) {
    next[source.key] = Math.max(0, Math.floor(source.offset));
  }
  for (const row of taken) {
    // The rank *after* this one, so the next page resumes below it. Taking a
    // count of delivered rows instead would be wrong the moment a source's
    // rows are not contiguous in the blended order, which is the normal case.
    next[row.key] = Math.max(next[row.key] ?? 0, row.rank + 1);
  }

  const leftovers = rows.length - taken.length;
  const deeper = sources.some((source) => {
    // A source that returned fewer hits than it asked for has no more to give;
    // one that filled its window may, unless the window was already the last
    // rank the ranker produces.
    const filled = source.hits.length >= source.asked;
    return filled && source.asked < MAX_SOURCE_DEPTH;
  });
  return { rows: taken, next: leftovers > 0 || deeper ? next : null };
}

/* -------------------------------------------------------------------------- */
/*                                  cursors                                   */
/* -------------------------------------------------------------------------- */

/**
 * A fingerprint of the query, for the cursor to carry instead of the query.
 *
 * **The raw query never goes into the cursor**, and that is a privacy decision
 * rather than a size one. A cursor is a client-held string that ends up in
 * request logs, in a retry, and — if the page ever puts one in the URL — in
 * browser history and in whatever a person pastes into a chat. `?q=` is a
 * restorable search somebody typed on purpose; a cursor is machinery, and
 * machinery that quietly carries a second copy of the same words is how note
 * vocabulary escapes the surfaces that were reviewed for it.
 *
 * FNV-1a, 32 bits, hex. It is not a security boundary and nothing is decided by
 * it: a collision means a stale cursor is honoured, and the worst that does is
 * resume the wrong page of a list the caller is allowed to read either way.
 */
export function queryFingerprint(query: string): string {
  let hash = 0x811c9dc5;
  const normalized = query.trim().toLowerCase();
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    // The FNV prime, as shifts, because `hash * 16777619` overflows a double
    // into a number whose low bits are gone — which would silently make this a
    // much worse hash rather than a broken one.
    hash =
      (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

interface CursorBody {
  v: 1;
  q: string;
  at: Record<string, number>;
}

/** Where each source has been read to, as one opaque string for the client. */
export function encodeCursor(fingerprint: string, offsets: Record<string, number>): string {
  const body: CursorBody = { v: 1, q: fingerprint, at: offsets };
  // Only ASCII goes in — a hex fingerprint, Convex ids and integers — so
  // `btoa` is safe without a UTF-8 dance. `encodeCursor` is the only writer;
  // `decodeCursor` trusts nothing it reads back.
  return btoa(JSON.stringify(body)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type CursorRead =
  /** Start at the top: absent, malformed, or for a different query. */
  | { kind: "fresh" }
  | { kind: "page"; offsets: Record<string, number> };

/**
 * Read a cursor back, trusting **nothing** in it.
 *
 * This is the crafted-cursor boundary, and the property that makes it one is
 * not in this function: a cursor cannot name a context to search. The scope
 * comes from `resolveScope` over the live eligible list, and the offsets here
 * are consulted only for keys that scope already contains. So the worst a
 * forged cursor can do is offer an offset for a context the caller can already
 * search, or one that is ignored.
 *
 * What is left to police is arithmetic, and each refusal below is a real
 * attack rather than defensive noise:
 *
 *  - a non-integer, negative or `Infinity` offset would slice the ranked list
 *    into nonsense — `slice(-1)` returns the *last* result, which is a page
 *    somebody could not otherwise reach;
 *  - an offset past `MAX_SOURCE_DEPTH` asks the ranker for a rank it does not
 *    produce, and is clamped rather than refused so a stale cursor from a
 *    deeper build degrades to the last page rather than to an error;
 *  - a cursor for a different query is ignored, so "load more" after retyping
 *    cannot splice one query's page two onto another query's page one.
 *
 * Every refusal is the same answer — start at the top — because a cursor that
 * failed to parse and a cursor that was for something else are both "this page
 * has no position", and telling them apart would be a signal about a string the
 * client should be treating as opaque.
 */
export function decodeCursor(raw: string | undefined, fingerprint: string): CursorRead {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > CURSOR_CAP) {
    return { kind: "fresh" };
  }
  let body: unknown;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    body = JSON.parse(atob(padded));
  } catch {
    return { kind: "fresh" };
  }
  if (typeof body !== "object" || body === null) return { kind: "fresh" };
  const parsed = body as Partial<CursorBody>;
  if (parsed.v !== 1 || parsed.q !== fingerprint) return { kind: "fresh" };
  if (typeof parsed.at !== "object" || parsed.at === null) return { kind: "fresh" };

  const offsets: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed.at)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const at = Math.floor(value);
    if (at <= 0) continue;
    offsets[key] = Math.min(at, MAX_SOURCE_DEPTH);
  }
  return { kind: "page", offsets };
}

/**
 * How deep one source must be read for this page.
 *
 * The ranker has no offset, so a second page is the same list read further
 * down: the window is "where this source resumes, plus a page". Capped at
 * `MAX_SOURCE_DEPTH`, which is where the ranking itself stops.
 */
export function depthFor(offset: number, size: number = BLEND_PAGE_SIZE): number {
  const from = Math.max(0, Math.floor(offset));
  return Math.min(from + Math.max(1, Math.floor(size)), MAX_SOURCE_DEPTH);
}
