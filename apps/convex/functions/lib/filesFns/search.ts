/**
 * Searching from the console: one context, the folder and note path lists,
 * and the blended search across every context the caller can search.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import {
  type BlendSource,
  decodeCursor,
  depthFor,
  encodeCursor,
  fuse,
  pageOf,
  queryFingerprint,
  resolveScope,
} from "../blendedSearch";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";
import { type BlendedAnswer, SOURCE_DEADLINE_MS, withDeadline } from "./searchDeadline";

/**
 * Maintenance passes that may chain behind one search's worth of work.
 *
 * A workspace of a few thousand notes does not index in one pass, and the
 * alternative to chaining is what the project note calls out as still open:
 * "the complete backfill finishes without requiring repeated user searches".
 * Making somebody search eight times to finish their own index is making them
 * do the system's work.
 *
 * Each link is scheduled only by a pass that **made progress and did not
 * finish**, so a converged bucket stops at one and a bucket that cannot
 * converge — an unreadable folder, a shard that will not fit — stops as soon
 * as it stops changing rather than looping on the customer's request quota.
 * The bound is the backstop for the case both of those miss.
 */
const INDEX_SYNC_CHAIN = 12;

/**
 * Search this context's notes. Any member may search what their scope can see.
 *
 * The console's palette used to filter the folders somebody had happened to
 * expand, and said so — "only folders you have opened are searched". That is
 * a file picker, not search: the answer to "where did I write about Ikenna"
 * lived in a folder the person had not opened, which is exactly the case
 * search exists for. This asks the bucket, through the same index and the
 * same code an AI client's `search_notes` answers from.
 */
export async function searchContextHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    query: string;
    prefix?: string;
  },
): Promise<Extract<OperationResult, { kind: "searchResults" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "search", query: args.query, prefix: args.prefix },
  })) as Extract<OperationResult, { kind: "searchResults" }>;

  // The index this answer read is the index some earlier pass built, and a
  // search does no maintenance of its own — that is what took a console
  // search over a real workspace from twenty-odd seconds to a fraction of one.
  // So the answer's own report of how far behind the index is decides
  // whether a pass runs behind it.
  //
  // **Scheduled, never called.** `ctx.runAction` would put a full listing of
  // the customer's bucket back in front of the person waiting, which is the
  // whole defect; `ctx.scheduler.runAfter` enqueues a job in a separate
  // transaction whose return value is discarded, so this action returns as
  // soon as it has an answer (CLAUDE.md, "Scheduling is not calling"). The
  // target is a statically resolvable `internal.` reference, as that rule
  // requires.
  //
  // Nothing is scheduled for a converged index. A pass per search over a
  // bucket with no work in it is a full listing per search, billed to the
  // customer, to discover there was nothing to do.
  if (result.indexMissing || result.indexIncomplete) {
    await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      grantedNames,
      operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
    });
  }
  return result;
}

/**
 * Every folder this member's scope may see, for a destination picker.
 *
 * `member` and above, which is the read this already is — and deliberately
 * NOT gated on being able to write here. The picker offers a context only
 * where the mover is at least an `editor`, and that decision belongs where the
 * list of contexts is, not to a folder listing: an action that refused a
 * reader would also refuse every other honest use of "what folders are in
 * @work", starting with the next one.
 *
 * Its own action rather than a shape of `listFiles`, because the walk is the
 * point: one call, one credential, the whole tree. See `listFolderPaths`.
 */
export async function folderPathsHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "folderPaths" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "folderPaths" },
  });
  return result as Extract<OperationResult, { kind: "folderPaths" }>;
}

/**
 * Every note path this member's scope may see, for the editor's link
 * resolution — `[[name]]` following and the `[[` completion.
 *
 * **Read-only, and deliberately schedules nothing.** `searchContext` chains
 * `maintainIndex` behind a miss because somebody is watching a spinner for an
 * answer about a word they typed; nobody is watching this one, and a context
 * that has never been searched simply resolves fewer links until an ordinary
 * search — or `maintainIndex`'s own hourly reach — catches the index up. See
 * `docs/decisions/app-and-console.md`, "L1".
 */
export async function notePathsHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<Extract<OperationResult, { kind: "notePaths" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "notePaths" },
  });
  return result as Extract<OperationResult, { kind: "notePaths" }>;
}

/**
 * One search across several contexts, blended into one list.
 *
 * ## Why the fan-out is here
 *
 * Because the per-context search already is. This action resolves a scope,
 * calls `runFileOperation`'s `search` once per context, and blends the answers
 * — and every part it does not do is the point: it does not open a bucket, does
 * not know what a projection is, does not rank, does not cut a snippet, and
 * **does not contain a privacy filter.** `searchNotes` owns all of that, once,
 * for the console and for `search_notes` alike, exactly as
 * `docs/decisions/search.md` requires. A blended search that re-derived who may
 * see a hit would be a third copy of `canSee` and the one most likely to be
 * wrong, because it is the one nobody would think to test per tier.
 *
 * The gateway was the alternative home and it is the wrong one twice: a Worker
 * has a fifty-subrequest ceiling per invocation, which a fan-out over eight
 * customers' buckets walks into by itself, and the console would need a request
 * per context per page — which is the "the client makes one request per page"
 * property this exists to give it.
 *
 * ## Every page re-checks everything
 *
 * Membership, role and fast-search state are re-read on every page of every
 * query: `searchableContextsFor` is a live read, `authorizeFileAccess` runs per
 * context per page, and the scope the caller asked for can only narrow that.
 * So somebody removed from a workspace between page one and page two gets page
 * two without it — no cached scope, no cursor-carried permission. The cursor
 * carries offsets and nothing else, and `decodeCursor` says at length why.
 *
 * ## What it deliberately does not do
 *
 * **It schedules index maintenance for one case only: a context with no index
 * at all.** `searchContext` schedules a pass behind any lagging index, because
 * a person searching one context is the cheapest possible trigger for catching
 * that context up. Multiplying that by the width of a scope would put a full
 * bucket listing per context behind every keystroke on this page, billed to
 * every one of those customers, so a merely *incomplete* index is left to the
 * passes that already ride the gateway's own searches.
 *
 * A **missing** one is different in kind and is the state this page created for
 * itself the moment it started searching contexts without a projection: a
 * context nobody has ever searched directly has no shard index, answers every
 * query with `indexMissing`, and would report "still being indexed" on this
 * page forever — a permanent apology that no amount of waiting resolves. So the
 * first page of a search schedules one chain per such context and no more:
 * later pages of the same query schedule nothing, and the condition is
 * self-limiting, because a context that has been indexed once is never
 * `indexMissing` again.
 *
 * **It logs no query text.** Nothing in this function writes the words
 * somebody typed anywhere: not to audit, not to a structured log, not into the
 * cursor. `docs/decisions/search.md` records that as a decision rather than an
 * omission — a search over several people's contexts is a much better guess at
 * what somebody is working on than any single note read.
 */
export async function searchContextsHandler(
  ctx: ActionCtx,
  args: {
    query: string;
    contexts?: Id<"workspaces">[];
    cursor?: string;
  },
): Promise<BlendedAnswer> {
  const actorUserId = await callerId(ctx);
  const searchable = await ctx.runQuery(
    internal.functions.fastSearch.searchableContextsFor,
    { actorUserId },
  );

  const query = args.query.trim();
  const scope = resolveScope(searchable, args.contexts);
  if (query === "" || scope.length === 0) {
    // An empty query and an empty scope are both "nothing was asked", and
    // both answer with an empty page rather than an error. `searchableCount`
    // is what lets the page tell the two apart on screen.
    return {
      results: [],
      matchCount: 0,
      matchCountIsFloor: false,
      cursor: null,
      sources: [],
      searchableCount: searchable.length,
    };
  }

  const fingerprint = queryFingerprint(query);
  const read = decodeCursor(args.cursor, fingerprint);
  const offsets = read.kind === "page" ? read.offsets : {};

  /*
    ONE DEADLINE PER SOURCE, AND A SLOW CONTEXT COSTS ONLY ITSELF.

    `Promise.all` over a list where each entry has already been wrapped, so
    the whole page is bounded by the slowest source that answers *in time*
    rather than by the slowest source. A bucket that has stopped answering
    would otherwise hold every other context's results behind it, which is
    the failure mode a blended list makes worse rather than better: one
    unreachable context and the page has nothing on it.
  */
  const answered = await Promise.all(
    scope.map(async (context) => {
      const offset = offsets[context.workspaceId] ?? 0;
      const asked = depthFor(offset);
      const settled = await withDeadline(
        (async () => {
          // The one authorization function, per context, per page. The
          // searchable list already established membership; this re-establishes
          // it through the same query every other file action uses, so a
          // blended search cannot come to disagree with a single one about
          // what role means what scope.
          const { scope: tier } = await ctx.runQuery(
            internal.functions.files.authorizeFileAccess,
            {
              actorUserId,
              workspaceId: context.workspaceId as Id<"workspaces">,
              minimum: "member" as const,
            },
          );
          const answer = (await ctx.runAction(
            internal.functions.files.runFileOperation,
            {
              workspaceId: context.workspaceId as Id<"workspaces">,
              scope: tier,
              operation: {
                kind: "search" as const,
                query,
                limit: asked,
                // See `searchNotes`: a fan-out misses in most of its contexts
                // by construction, and one listing per miss is the cost of a
                // rule written for a single spinner.
                refreshOnMiss: false,
              },
            },
          )) as Extract<OperationResult, { kind: "searchResults" }>;
          // The tier rides back out with the answer so the maintenance pass
          // below can be scheduled with the scope this search was authorized
          // at, rather than re-deriving one outside the race — where a second
          // `authorizeFileAccess` would be a second answer to the same
          // question.
          return { answer, tier };
        })(),
        SOURCE_DEADLINE_MS,
      );
      return {
        context,
        offset,
        asked,
        settled: settled === null ? null : settled.answer,
        tier: settled === null ? null : settled.tier,
      };
    }),
  );

  const sources: BlendSource[] = [];
  const rows: BlendedAnswer["sources"] = [];
  let matchCount = 0;
  let matchCountIsFloor = false;
  for (const { context, offset, asked, settled } of answered) {
    if (settled === null) {
      // A refusal, a timeout and a thrown storage error are one state on
      // screen, and deliberately: what a person can do about each is press
      // retry on that row. The reason is not carried because it would be a
      // provider's sentence about somebody else's bucket.
      //
      // **And the blended total stops claiming to be exact.** A source that
      // was never read is a walk cut short, which is the condition under
      // which every other count in this system reports itself as a floor —
      // `search/CONTRACT.md`'s rule, and the census's own language. Summing
      // the sources that answered and calling the result a total would be a
      // confident number over a scope only half searched, and the one place
      // that understatement matters most is the page whose whole promise is
      // "everything you can reach".
      matchCountIsFloor = true;
      rows.push({
        workspaceId: context.workspaceId as Id<"workspaces">,
        slug: context.slug,
        displayName: context.displayName,
        state: "failed",
        matchCount: 0,
        matchCountIsFloor: false,
      });
      continue;
    }
    sources.push({
      key: context.workspaceId,
      hits: settled.hits,
      offset,
      asked,
    });
    matchCount += settled.matchCount;
    matchCountIsFloor = matchCountIsFloor || settled.matchCountIsFloor;
    rows.push({
      workspaceId: context.workspaceId as Id<"workspaces">,
      slug: context.slug,
      displayName: context.displayName,
      // An index that has not caught up is not "no matches here", and a
      // blended list is where that lie is easiest to tell: nine contexts
      // answer, the tenth is still indexing, and its silence reads as an
      // answer about somebody's notes.
      state: settled.indexMissing || settled.indexIncomplete ? "indexing" : "ok",
      matchCount: settled.matchCount,
      matchCountIsFloor: settled.matchCountIsFloor,
    });
  }

  /*
    The one pass this page schedules — see "what it deliberately does not do".

    A context with no shard index at all answers every query with
    `indexMissing` and would say "still being indexed" on this page for as
    long as nobody searched it from somewhere else. One chain per such
    context, on the first page of a query only, and never for an index that
    merely lags: that one catches up behind the searches the gateway and the
    palette already ride.

    **Scheduled, never called** (CLAUDE.md, "Scheduling is not calling"). A
    `runAction` here would put a full listing of somebody's bucket in front of
    the person waiting for this page, which is the defect the whole
    no-maintenance rule exists to avoid.
  */
  if (args.cursor === undefined) {
    for (const { context, settled, tier } of answered) {
      if (settled === null || tier === null || !settled.indexMissing) continue;
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: context.workspaceId as Id<"workspaces">,
        scope: tier,
        operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
      });
    }
  }

  const page = pageOf(fuse(sources), sources);
  const named = new Map(scope.map((context) => [context.workspaceId, context]));
  return {
    results: page.rows.map((row) => {
      const context = named.get(row.key)!;
      return {
        workspaceId: context.workspaceId as Id<"workspaces">,
        slug: context.slug,
        displayName: context.displayName,
        path: row.path,
        title: row.title,
        snippet: row.snippet,
      };
    }),
    matchCount,
    matchCountIsFloor,
    cursor: page.next === null ? null : encodeCursor(fingerprint, page.next),
    sources: rows,
    searchableCount: searchable.length,
  };
}
