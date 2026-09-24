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
