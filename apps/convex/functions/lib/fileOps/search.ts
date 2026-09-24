/**
 * Searching a context, and maintaining the index that search reads.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { canSee, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
// The gateway's search, imported rather than ported — see `searchNotes` below.
// `apps/mcp` targets the Workers runtime, which is Convex's runtime too, so
// these run here unmodified over the same store `provisioning.ts` already
// builds from a binding.
import { createSearchBudget } from "../../../../mcp/src/search/maintain.js";
import { loadDocmapPaths, syncShardedIndex } from "../../../../mcp/src/search/shards.js";
import { searchIndexedNotes } from "../../../../mcp/src/search/visible.js";
import { answerFromProjection, pageDepth } from "../../../../mcp/src/search/d1/serve.js";
import type { FileStore } from "./store";
import { notFound } from "./errors";
import { requireFolderPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";

/**
 * What the imported search needs of a store: reads, listings and the
 * conditional write its index maintenance does. `FileStore` satisfies it —
 * the cast at the call site is because `apps/mcp` is JavaScript with no
 * exported type to line these up structurally, not because anything is
 * missing.
 */
type SearchStore = Parameters<typeof searchIndexedNotes>[0];

/**
 * Store operations one console search may spend.
 *
 * It no longer buys a backfill. A search reads a ready index — the change that
 * took a console search over a real workspace from twenty-odd seconds to a
 * fraction of one — so what this covers is a manifest, the shards the query's
 * terms can be in, ten snippet reads, and the one listing a **miss** over a
 * converged index is allowed to buy before it says "nothing". Generous rather
 * than tight because a Convex action has no subrequest ceiling and the cost of
 * being one op short is an answer that understates itself.
 */
const CONSOLE_SEARCH_BUDGET = 300;

/**
 * Store operations one background maintenance pass may spend.
 *
 * This is where every listing, note read and shard write in the console's half
 * of the system now happens, and nobody is waiting on it: it runs in a
 * scheduled action, after the search that noticed the index was behind has
 * already answered. Cloudflare's per-invocation subrequest cap is what bounds
 * the gateway's equivalent and there is no such cap here, so the number is
 * chosen against the customer's request quota instead — large enough that a
 * cold workspace converges in a handful of passes rather than dozens.
 */
const INDEX_SYNC_BUDGET = 600;

/** One console search result: a path the caller may see, and lines from it. */
export interface SearchHit {
  path: string;
  title: string;
  snippets: string[];
}

export interface SearchResults {
  hits: SearchHit[];
  /** Visible matches found, which may exceed the hits returned. */
  matchCount: number;
  /** `matchCount` is a floor: the ranked list was full, or a walk was cut short. */
  matchCountIsFloor: boolean;
  /** The index has not caught up with the bucket, so results may be short. */
  indexIncomplete: boolean;
  /**
   * There was no index to answer from at all.
   *
   * Never collapsed into "no matches": a bucket nothing has indexed yet would
   * then tell somebody their note does not exist, which is the failure this
   * whole feature exists to remove. The gateway answers this case with a
   * literal scan it can afford inside one Worker invocation; the console says
   * the context is still being indexed and leaves its own filename filter
   * standing.
   */
  indexMissing: boolean;
  /**
   * Some of this caller's own visible notes lost per-message recall to the
   * search index's own capacity, and never resolves by searching again — the
   * opposite claim from `indexIncomplete`, which is why it is a separate
   * field rather than folded into it (`docs/decisions/search.md`, sizing
   * section). `false` for the D1 projection path: a chunk row per message has
   * no shard byte cap for a mailbox to cross, so this is a fact about the R2
   * shard index alone.
   */
  reducedRecall: boolean;
  /**
   * Which of the caller's own visible notes those are — already filtered
   * through this scope's `canSee`, the same as every path in `hits`, and safe
   * to render for that reason. A note's own path names the channel and day
   * (`0-inbox/email/<address>/2026-09-07.md`), which is what makes this
   * actionable rather than a bare count.
   */
  reducedRecallNotes: string[];
}

/**
 * Search the notes this scope can see, from the derived index in the
 * customer's own bucket.
 *
 * **This runs the gateway's search, imported, rather than a port of it.**
 * `searchIndexedNotes` is the same function `search_notes` answers from, so
 * the console and an AI client cannot disagree about what a query matches or
 * about who may see a hit — CLAUDE.md's "one search path" rule, extended to a
 * third caller. What is passed in is this runtime's own `canSee` and
 * `isPlumbing`, which `__tests__/privacyEngine.test.ts` already proves answer
 * identically to the gateway's for every manifest, key and scope it is given.
 *
 * The subrequest budget the gateway sets exists because Cloudflare caps
 * subrequests per invocation; a Convex action has no such cap, so this passes
 * a larger one — a console search on a cold bucket then makes real progress on
 * the backfill instead of nibbling at it, and the same index serves both
 * surfaces afterwards.
 *
 * **A search does not maintain the index**, and that is the change that took a
 * console search over a real workspace from twenty-odd seconds to a fraction of
 * one. It reads a manifest, the shards this query's terms can be in, and the
 * notes it is quoting. `searchContext` schedules `maintainSearchIndex` behind
 * the answer when the answer says the index is behind.
 *
 * ## And the projection first, where this context has a complete one
 *
 * `answerFromProjection` is imported for exactly the reason `searchIndexedNotes`
 * is, and it is the same rule: everything below the D1 query is a privacy
 * boundary — which rows a caller keeps, whether the count is taken before or
 * after that filter, whether an empty result is an answer — and a second copy
 * of those decisions in this file would be a second place for each of them to
 * be wrong. What is injected is this runtime's own `canSee`, bound to the
 * caller's scope, exactly as it is into `searchIndexedNotes` below.
 *
 * `null` from it means **not answered** and never "no results": a projection
 * is a disposable derivative that can be behind, and reporting its silence as
 * an empty context is the failure this whole surface is built to avoid. So a
 * miss costs the R2 answer as well and the person waits what they waited
 * before; only a hit is fast. That is what makes it safe to consult on every
 * search rather than behind a second switch.
 *
 * `projection` is `null` unless the caller opened one, which it does only for
 * a row the control plane calls `ready` — the same gate the gateway applies,
 * because a projection that is still filling answers a query about a note it
 * has not copied with a silence this path would read as a miss.
 *
 * The one exception is `refreshOnMiss`, and it is the reason a member's search
 * can still cause a write under `.index/` whatever their role — worth saying
 * out loud beside a module whose every other write is gated on `canEdit`. It is
 * not an escalation and it is not new: an AI client on a team-tier grant
 * maintains this index too, the keys are plumbing rather than note content, and
 * the whole thing is a disposable derivative a person's own notes can rebuild.
 * What a member must not be able to do is *read* more than their scope, and
 * that is `isVisible`, below.
 */
/**
 * Every note path this scope may see, for link resolution in the editor —
 * `docs/decisions/app-and-console.md`, "L1".
 *
 * A bare `[[name]]` and the `[[` completion both need the whole bucket's note
 * paths, and the console's file tree only knows the folders somebody has
 * expanded. Rather than a second index — a full bucket listing paid for on
 * the customer's request quota, which is exactly the cost
 * `1-projects/context-lc-search-performance/overview.md` spent Phase 2
 * removing from the search path — this reads the search index's own docmap,
 * which is already maintained behind every search's response.
 *
 * **Filtered through the caller's own `canSee`, the same as every hit a
 * search returns.** The docmap holds every note in the bucket regardless of
 * who asks, so skipping this filter would leak a private note's *existence* —
 * its path — to a team member who could not open it, through a completion
 * list rather than a listing. That is exactly the existence oracle rule #2 at
 * the top of this file exists to prevent, reached through a different door.
 *
 * `null` for every way the index is not there to answer from — nothing has
 * indexed this bucket, the docmap could not be read, no budget was left —
 * and deliberately not a partial or wrong answer instead: a link that stays
 * undrawn until the index catches up is dishonest about *timing*, never about
 * *destination*.
 */
export async function notePathIndex(
  store: FileStore,
  clearance: Clearance,
  budget: number = CONSOLE_SEARCH_BUDGET,
): Promise<{ paths: string[] } | null> {
  const state = await loadPrivacyState(store);
  const isVisible = (path: string) =>
    canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
  const found = await loadDocmapPaths(
    store as unknown as Parameters<typeof loadDocmapPaths>[0],
    createSearchBudget(budget),
    0,
  );
  if (found === null) return null;
  return { paths: found.paths.filter((path) => isVisible(path) && !isPlumbing(path)) };
}

export async function searchNotes(
  store: FileStore,
  options: {
    query: string;
    prefix?: string;
    clearance: Clearance;
    budget?: number;
    /**
     * How far down the ranked list to read, in notes.
     *
     * Ten by default, which is the palette every caller had before the search
     * page existed. `pageDepth` is the shared clamp and the ceiling is
     * `MAX_RESULTS`, where the *ranking* is cut — see its comment in
     * `search/d1/serve.js` for why a deeper page is a deeper slice of the same
     * list rather than a second query with an offset.
     */
    limit?: number;
    /**
     * Whether an empty answer may buy one bucket listing and ask again.
     *
     * True for a single-context search, which is the case `searchIndexedNotes`
     * wrote the rule for: somebody wrote a note a minute ago and is looking for
     * it, and one listing is worth not telling them it does not exist.
     *
     * **A fan-out across contexts passes false**, and the arithmetic is the
     * reason. The rule costs one listing per *miss*, and a blended search over
     * eight contexts misses in most of them by construction — a word that is in
     * one workspace is absent from the other seven. That is seven full bucket
     * listings, on seven customers' request quotas, for one keystroke's worth
     * of scrolling, and it would make the fan-out's worst case its ordinary
     * case. The honesty the rule buys is not lost: a source whose index is
     * behind still says so, per source, and the page renders that rather than
     * "no matches".
     */
    refreshOnMiss?: boolean;
  },
  projection: ProjectionClient | null = null,
): Promise<SearchResults> {
  const query = options.query.trim();
  if (query === "") {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: false,
      reducedRecall: false,
      reducedRecallNotes: [],
    };
  }

  const folder = options.prefix ? requireFolderPath(options.prefix) : "";
  const state = await loadPrivacyState(store);
  // A folder this scope cannot open is not a narrower search, it is a folder
  // that does not exist — the same answer `listFolder` gives, so a prefix
  // cannot become a way to ask whether a hidden folder has anything in it.
  if (folder !== "" && !folderVisibleAtScope(folder, options.clearance, state.rules, state.overrides)) {
    throw notFound();
  }

  const isVisible = (path: string) =>
    canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names);

  // Clamped once, here, and handed to both index paths — a page depth that the
  // projection honoured and the R2 index did not would make the number of
  // results depend on which derivative answered, which is the one difference
  // between them a caller must never be able to see.
  const limit = pageDepth(options.limit);

  if (projection !== null) {
    try {
      const fast = await answerFromProjection(projection, {
        query,
        prefix: folder,
        tier: options.clearance.scope,
        isVisible,
        limit,
      });
      if (fast) {
        return {
          hits: fast.hits.map((hit: { key: string; title: string; snippets: string[] }) => ({
            path: hit.key,
            title: hit.title,
            snippets: hit.snippets,
          })),
          matchCount: fast.matchCount,
          matchCountIsFloor: fast.matchCountIsFloor,
          // The projection is filled from the R2 index's own docmap, so a note
          // that index has not reached is a note the projection cannot hold
          // either. Reading the manifest to say so would cost the object read
          // this path exists to avoid, and the answer it would give is the one
          // the caller gets on its next miss anyway — so this reports what it
          // knows, which is that the answer came from a complete projection.
          indexIncomplete: false,
          indexMissing: false,
          // `false`, unconditionally: the projection holds one row per message
          // with no shard byte cap for a mailbox to cross, so a channel-day
          // note is never reduced here the way it can be in the R2 index. See
          // `SearchResults.reducedRecall`.
          reducedRecall: false,
          reducedRecallNotes: [],
        };
      }
    } catch {
      // Every D1 failure is one of `d1/client.js`'s closed-set codes, and none
      // is a reason to fail a search somebody is watching a spinner for: the
      // R2 index answers below exactly as it does with fast search off. A bare
      // catch also swallows a bug in this block, which is the honest cost of
      // that rule — the alternative is a console search that fails outright
      // when it had a good answer one call away.
    }
  }

  const found = await searchIndexedNotes(store as unknown as SearchStore, {
    isVisible,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    query,
    prefix: folder,
    limit,
    budget: createSearchBudget(options.budget ?? CONSOLE_SEARCH_BUDGET),
    // A person typed this and is watching a spinner, which is exactly who the
    // rule is for: a miss over an index that believes it is converged buys one
    // listing and asks again, and an answer with hits in it buys nothing. The
    // console is where somebody writes a note and then looks for it, so the
    // case this covers — the index is current as of a minute ago and the note
    // is newer than that — is the console's own most likely miss.
    //
    // A fan-out turns it off; see `refreshOnMiss` in the options above.
    refreshOnMiss: options.refreshOnMiss ?? true,
  });

  if (!found.indexed) {
    return {
      hits: [],
      matchCount: 0,
      matchCountIsFloor: false,
      indexIncomplete: false,
      indexMissing: true,
      reducedRecall: false,
      reducedRecallNotes: [],
    };
  }

  return {
    hits: (found.hits ?? []).map((hit) => ({
      path: hit.key,
      title: hit.title,
      snippets: hit.snippets,
    })),
    matchCount: found.matchCount ?? 0,
    matchCountIsFloor: Boolean(found.matchCountIsFloor),
    indexIncomplete: Boolean(found.indexIncomplete),
    indexMissing: false,
    reducedRecall: Boolean(found.reducedRecall),
    reducedRecallNotes: found.reducedRecallNotes ?? [],
  };
}

/**
 * One pass of the R2 shard index, over a budget the caller owns.
 *
 * The one place that knows what an indexing pass *is* — which keys count as
 * notes, and that it is `syncShardedIndex` and not something of ours. Both
 * callers below share it so they cannot come to disagree about either: a
 * background indexer with its own notion of `isIndexable` is a second place
 * for the index to be wrong, in the way a second search path would be a second
 * place for a visibility bug.
 *
 * It takes the budget rather than a number because the projection spends from
 * the same one — the listing, the note reads and the D1 statements are one
 * pass's worth of work, and two allowances would mean neither bounded it.
 */
export async function runIndexPass(
  store: FileStore,
  budget: ReturnType<typeof createSearchBudget>,
  reserve = 0,
  /**
   * Test-only injection, exactly as `syncShardedIndex` itself documents:
   * nothing in production passes this, and `maintainSearchIndex` does not
   * accept it from its own caller. Real shedding needs a shard's serialized
   * body to cross `SHARD_PARSE_BYTE_CAP` (2MB), which a unit test proving the
   * *plumbing* through this file — as opposed to the sizing mechanism itself,
   * already exhaustively covered in `apps/mcp/test/commsSearchIndex.test.mjs`
   * — should not have to build megabytes of Markdown to reach.
   */
  shardByteCap?: number,
) {
  return await syncShardedIndex(store as unknown as Parameters<typeof syncShardedIndex>[0], {
    budget,
    reserve,
    isIndexable: (key: string) => key.endsWith(".md") && !isPlumbing(key),
    ...(shardByteCap === undefined ? {} : { shardByteCap }),
  });
}

/**
 * Bring the search index a pass further. Nobody is waiting on this.
 *
 * A console search reads a ready index and maintains nothing, so this is the
 * whole of the console's half of index maintenance — a full listing of the
 * bucket, an etag diff, the notes that changed re-read, the shards they belong
 * to rewritten. It used to happen in front of the person asking the question,
 * which is what made a search over a real workspace take twenty seconds and
 * sometimes fail on a ten-second fetch deadline partway through.
 *
 * It is reached through the same credential barrier every other file operation
 * goes through, and **scheduled** rather than called: `searchContext` enqueues
 * it after answering, which propagates no taint (CLAUDE.md, "Scheduling is not
 * calling") and hands the caller nothing to wait for.
 *
 * It is the same `syncShardedIndex` the gateway runs, not a second maintenance
 * path. A background indexer with its own diff would be a second place for the
 * index to be wrong, in the way a second search path would be a second place
 * for a visibility bug.
 *
 * **It reads every note in the bucket, private ones included, and answers
 * nothing about them.** The return carries counts of the index's own progress
 * and no path, no title and no term — an indexing pass is scope-blind by
 * construction (`isIndexable`, never `isVisible`), and the moment one could
 * report *which* notes it touched it would be an existence oracle for the
 * private half of somebody's bucket.
 */
export async function maintainSearchIndex(
  store: FileStore,
  /** `shardByteCap` is test-only — see `runIndexPass`. */
  options: { budget?: number; shardByteCap?: number } = {},
): Promise<{ pending: number; changed: boolean; complete: boolean; shed: number; oversizedShards: number }> {
  const pass = await runIndexPass(
    store,
    createSearchBudget(options.budget ?? INDEX_SYNC_BUDGET),
    0,
    options.shardByteCap,
  );
  return {
    pending: pass.pending,
    // `committed`, not `changed`: a pass whose manifest write lost a race to a
    // concurrent one did work the winner is about to re-derive, and the chain
    // below must not treat that as progress. Otherwise every search in a burst
    // schedules twelve more passes over the same notes.
    changed: Boolean(pass.committed),
    // "Nothing left to do", which is what decides whether another pass is
    // scheduled behind this one. A truncated listing counts as incomplete for
    // the same reason it does everywhere else here: a walk that was cut short
    // is not evidence that there was nothing more to find.
    complete: pass.pending === 0 && !pass.listingTruncated && !pass.manifestOverflow,
    // `pending`'s opposite, in the same no-path-no-title-no-term shape every
    // other count on this return already follows: a scalar over the whole
    // bucket, private notes included, for the operator rather than any one
    // caller — `searchNotes`'s own `reducedRecallNotes` is the caller-safe,
    // per-scope answer to the same fact. This pass's own count, not the
    // index's running total: a shard nothing changed this pass is not
    // reopened, so a note shed earlier and untouched since is not recounted
    // here every pass — see `docs/decisions/search.md`, sizing section.
    shed: pass.shed.length,
    oversizedShards: pass.oversizedShards,
  };
}

/**
 * The part of the gateway's D1 client this needs, and nothing more.
 *
 * Structural rather than an import of `createD1Client`'s return, because the
 * client is welded to `fetch` and this function has no business constructing
 * one: `runFileOperation` builds it from a credential that must not reach this
 * module, exactly as it builds the store.
 */
export interface ProjectionClient {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  runAll(
    statements: readonly { sql: string; params?: unknown[] }[],
    options?: { budget?: unknown; reserve?: number },
  ): Promise<{ applied: number; skipped: boolean }>;
}
