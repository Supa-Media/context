/**
 * One pass of keeping notes' facts current (`lib/nodes/facts.ts`): read the
 * notes the change log (or a first walk) says changed, parse their links with
 * the parser a move's rewrite uses and their front matter with the one every
 * List uses, and record both. Runs inside the credential barrier as
 * `nodesFactFill`, since it reads note text from the bucket; only what the
 * parsers return is kept, never the text.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { FileStore } from "../fileOps";
import type { OperationResult } from "../filesFns/operationTypes";
import { linkRowsOf } from "../../../../mcp/src/tree/links.js";
import { propsOf } from "../../../../mcp/src/tree/props.js";
import { indexableText } from "../../../../mcp/src/encryption/format.js";
import { commonReadFailure, readFailureKind } from "../../../../mcp/src/store/readFailure.js";
import { FACT_FILL_CHAIN, FACT_FILL_CONCURRENCY, FACT_RECORD_ROWS } from "./facts";

interface Parsed {
  path: string;
  etag?: string;
  gone?: boolean;
  links: string[][];
  props: string | null;
}

/** What one note's text says: its links and its props (`null` when encrypted). */
export function factsOf(path: string, text: string): { links: string[][]; props: string | null } {
  const props = propsOf(text);
  return {
    // An encrypted note's links are inside its ciphertext: none recorded,
    // which is also what a rewrite does with it (it never rewrites one).
    links: (linkRowsOf(path, indexableText(text)) as Array<[string, string]>).map(([kind, target]) => [kind, target]),
    props: props === null ? null : JSON.stringify(props),
  };
}

/** One note's facts, or why it could not be read this time (`readFailure.js`). */
async function parse(store: FileStore, note: { path: string; etag?: string; gone?: boolean }): Promise<Parsed | { failed: string }> {
  if (note.gone === true) return { path: note.path, gone: true, links: [], props: null };
  try {
    const object = await store.get(note.path);
    const version = note.etag === undefined ? {} : { etag: note.etag };
    // Gone since the tree saw it: its links go, its row stays unparsed, and the sweep that takes the row away settles it.
    if (!object) return { path: note.path, gone: true, links: [], props: null };
    return { path: note.path, ...version, ...factsOf(note.path, await object.text()) };
  } catch (error) {
    return { failed: readFailureKind(error) };
  }
}

/** Notes grouped so no one `record` call writes more than `FACT_RECORD_ROWS` links. */
export function recordBatches(parsed: readonly Parsed[]): Parsed[][] {
  const batches: Parsed[][] = [];
  let current: Parsed[] = [];
  let rows = 0;
  for (const note of parsed) {
    const size = Math.max(1, note.links.length);
    if (current.length > 0 && rows + size > FACT_RECORD_ROWS) {
      batches.push(current);
      current = [];
      rows = 0;
    }
    current.push(note);
    rows += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Schedule a fill pass; errors are swallowed, since the next trigger starts one too. */
export async function scheduleFactFill(
  ctx: Pick<ActionCtx, "scheduler">,
  workspaceId: Id<"workspaces">,
  passes = 0,
  delayMs = 0,
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(delayMs, internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private",
      operation: { kind: "nodesFactFill", passes },
    });
  } catch {
    // The cron's next round starts it.
  }
}

/** One `nodesFactFill` pass with the bucket the barrier opened. */
export async function runFactFill(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  passes: number,
): Promise<OperationResult> {
  // Only a tree that serves has rows worth following.
  if ((await ctx.runQuery(internal.functions.nodes.served, { workspaceId })) === null) {
    return { kind: "nodesKept", complete: false };
  }
  const state = await ctx.runMutation(internal.functions.nodeFacts.claim, { workspaceId, now: Date.now() });
  // Another pass holds it, and checks the log again as it finishes (`behind`),
  // so a change it read too early starts the next pass; the cron catches one
  // whose pass died.
  if (state === null) return { kind: "nodesKept", complete: false };
  let failed: string[] = [];
  const kinds: string[] = [];
  let next = state;
  let more = false;
  try {
    const plan = await ctx.runQuery(internal.functions.nodeFacts.due, { workspaceId, state });
    next = plan.next;
    more = plan.more;
    const parsed: Parsed[] = [];
    for (let start = 0; start < plan.notes.length; start += FACT_FILL_CONCURRENCY) {
      const wave = plan.notes.slice(start, start + FACT_FILL_CONCURRENCY);
      const read = await Promise.all(wave.map((note) => parse(store, note)));
      read.forEach((result, index) => {
        if ("failed" in result) {
          failed.push(wave[index]!.path);
          kinds.push(result.failed);
        } else parsed.push(result);
      });
    }
    for (const batch of recordBatches(parsed)) {
      await ctx.runMutation(internal.functions.nodeFacts.record, { workspaceId, notes: batch });
    }
  } catch {
    // Nothing recorded past here: the pass ends where it started.
    console.error("nodes.fact_fill_failed", { workspaceId });
    next = state;
    more = false;
    failed = state.retry ?? [];
    kinds.length = 0;
  }
  await ctx.runMutation(internal.functions.nodeFacts.finish, {
    workspaceId,
    next: {
      ready: next.ready,
      seq: next.seq,
      ...(next.after === undefined ? {} : { after: next.after }),
      ...(next.startSeq === undefined ? {} : { startSeq: next.startSeq }),
      ...(next.upgrade === undefined ? {} : { upgrade: next.upgrade }),
      ...(next.upgraded === true ? { upgraded: true } : {}),
    },
    failed,
    ...(failed.length > 0 && kinds.length > 0 ? { failedKind: commonReadFailure(kinds) ?? "other" } : {}),
  });
  // Changes logged while this pass read are the next pass's.
  if (!more) more = await ctx.runQuery(internal.functions.nodeFacts.behind, { workspaceId }).catch(() => false);
  if (more && passes + 1 < FACT_FILL_CHAIN) await scheduleFactFill(ctx, workspaceId, passes + 1);
  return { kind: "nodesKept", complete: !more };
}
