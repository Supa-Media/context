/**
 * The diagnosis (`functions/noteIdsCopy.ts`, `runCheck`): every id copy the
 * rows record is compared with its source, a page at a time, through the same
 * mover ticket the copy uses (`idCheck`) or here when there is no mover. A copy
 * the bucket says is missing or differs is cleared from its row, so the next
 * pass copies it again. Nothing else is written.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../../../_generated/server";
import type { GatewayCredential } from "../storage/shapes";
import { CHECK_FAILED_LABEL, COPY_PAGE, COPY_RETRY_MS, COPY_STREAK_MAX, ID_BYTE_BUDGET, ID_LANES, type NoteIdItem } from "../nodes/noteIds";
import { runNoteIdPageOnMover } from "../storageMover";
import { nodeAt } from "./state";

const STATES = new Set(["same", "missing", "source_missing", "differs"]);

export interface CheckArgs {
  workspaceId: Id<"workspaces">;
  runId: number;
  after?: string;
  checkedAt: number;
  checked: number;
  missing: number;
  differs: number;
  streak?: number;
}

export interface CheckDeps {
  origin: string | null;
  credential(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<GatewayCredential | null>;
  checkHere(page: {
    kind: "idCheck";
    workspaceId: string;
    source: GatewayCredential & { workspaceId: string };
    items: { path: string; key: string }[];
    limits: { lanes: number; byteBudget: number };
  }): Promise<{ results: unknown[] }>;
}

export interface CheckAnswer {
  path: string;
  key: string;
  etag: string;
  state: string;
}

/** What the bucket said about each item: an item it did not answer for is left out, never guessed. */
export function normalizeCheck(items: readonly NoteIdItem[], answers: readonly unknown[]): CheckAnswer[] {
  const byPath = new Map<string, string>();
  for (const answer of answers) {
    const entry = answer as { path?: unknown; state?: unknown } | null;
    if (entry && typeof entry.path === "string" && typeof entry.state === "string" && STATES.has(entry.state)) {
      byPath.set(entry.path, entry.state);
    }
  }
  const out: CheckAnswer[] = [];
  for (const item of items) {
    const state = byPath.get(item.path);
    if (state !== undefined) out.push({ path: item.path, key: item.key, etag: item.etag, state });
  }
  return out;
}

/**
 * Apply one page's answers. An item counts only if its row still holds the
 * copy and etag it was checked at; a `missing` or `differs` copy is cleared.
 */
export async function recordCheckPage(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  answers: CheckAnswer[],
): Promise<{ checked: number; missing: number; differs: number }> {
  const counted = { checked: 0, missing: 0, differs: 0 };
  for (const answer of answers) {
    const node = await nodeAt(ctx.db, workspaceId, answer.path);
    if (node === null || node.kind !== "file" || node.goneAt !== undefined) continue;
    if (node.etag !== answer.etag || node.idCopy?.key !== answer.key) continue;
    counted.checked += 1;
    if (answer.state === "missing" || answer.state === "differs") {
      if (answer.state === "missing") counted.missing += 1;
      else counted.differs += 1;
      await ctx.db.patch(node._id, { idCopy: undefined });
    }
  }
  return counted;
}

/** One page of the diagnosis, then the next, or the diagnosis written when the copies are all read. */
export async function runCheckChain(ctx: ActionCtx, args: CheckArgs, deps: CheckDeps): Promise<void> {
  const { workspaceId } = args;
  const streak = args.streak ?? 0;
  try {
    const page = await ctx.runQuery(internal.functions.noteIdsCopy.checkPage, {
      workspaceId,
      ...(args.after === undefined ? {} : { after: args.after }),
      limit: COPY_PAGE,
    });
    if (page.paused) return;
    let { checked, missing, differs } = args;
    if (page.items.length > 0) {
      const answers = await checkItems(ctx, args, page.items, deps);
      const counted = await ctx.runMutation(internal.functions.noteIdsCopy.recordCheck, { workspaceId, answers });
      checked += counted.checked;
      missing += counted.missing;
      differs += counted.differs;
    }
    if (page.done) {
      await ctx.runMutation(internal.functions.noteIdsCopy.finishDiagnosis, {
        workspaceId,
        checkedAt: args.checkedAt,
        checked,
        missing,
        differs,
      });
      return;
    }
    await ctx.scheduler.runAfter(0, internal.functions.noteIdsCopy.runCheck, {
      workspaceId,
      runId: args.runId,
      ...(page.next === undefined ? {} : { after: page.next }),
      checkedAt: args.checkedAt,
      checked,
      missing,
      differs,
      streak: 0,
    });
  } catch {
    console.error("noteIds.check_page_failed", { workspaceId });
    if (streak + 1 >= COPY_STREAK_MAX) {
      await ctx.runMutation(internal.functions.noteIdsCopy.failDiagnosis, { workspaceId, label: CHECK_FAILED_LABEL });
      return;
    }
    await ctx.scheduler.runAfter(COPY_RETRY_MS, internal.functions.noteIdsCopy.runCheck, {
      ...args,
      streak: streak + 1,
    });
  }
}

async function checkItems(
  ctx: ActionCtx,
  args: CheckArgs,
  items: NoteIdItem[],
  deps: CheckDeps,
): Promise<CheckAnswer[]> {
  if (deps.origin !== null) {
    const outcome = await runNoteIdPageOnMover(ctx, args.workspaceId, { runId: args.runId, phase: "id_check", items }, deps.origin);
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    return normalizeCheck(items, outcome.results);
  }
  const credential = await deps.credential(ctx, args.workspaceId);
  if (credential === null) throw new Error("SOURCE_UNAVAILABLE");
  const page = await deps.checkHere({
    kind: "idCheck",
    workspaceId: String(args.workspaceId),
    source: { ...credential, workspaceId: String(args.workspaceId) },
    items: items.map(({ path, key }) => ({ path, key })),
    limits: { lanes: ID_LANES, byteBudget: ID_BYTE_BUDGET },
  });
  return normalizeCheck(items, page.results);
}
