/**
 * "Privacy on rows": staff's switch from the privacy rules to access rows
 * (`nodeMigration.accessSource`), and the check that decides when it may move.
 * Shown in admin › Search › Privacy on rows (`apps/mobile/features/admin/
 * PrivacyRowsView.tsx`).
 *
 * Three settings. `file` (Off): the rules decide, rows are not kept. `shadow`
 * (Shadow): rows are derived on every rules write and move, but nothing reads
 * them. `rows` (On): readers judge by the rows. Moving to `rows` is refused
 * unless every bound workspace's latest check (`lib/privacyRows/checks.ts`)
 * ran against its current derivation and found no difference. Going back to
 * Off is always allowed.
 *
 * Counts, times, paths and clearances only. A note's text never reaches here.
 * Every public function checks staff first, through the same `requireAdmin`
 * the Notes by id card uses. Starting work only schedules internal functions,
 * one per workspace, so no single transaction walks every tree.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, mutation, query, type DatabaseReader, type MutationCtx, type QueryCtx } from "../_generated/server";
import { requireAdmin, type AdminActor } from "./lib/admin";
import { recordAdminAudit } from "./lib/adminFns/audit";
import { toConvexError } from "./lib/adminFns/errors";
import { workspaceArchived } from "./lib/archivedWorkspaces";
import { accessParityPage } from "./lib/nodes/accessParity";
import { accessSourceOf, backfillAccess, type AccessSource } from "./lib/nodes/accessBackfill";
import { privacyAuthorityOn } from "./lib/nodes/privacyAuthority";
import { SAMPLE_MAX, accessStateRowOf, checkRowOf, checkStatus, type CheckStatus } from "./lib/privacyRows/checks";
import { boundWorkspaces } from "./nodesMigration";
import { renderRowsAsRules } from "./lib/privacyRows/backToOff";

const sourceValidator = v.union(v.literal("file"), v.literal("shadow"), v.literal("rows"));
const statusValidator = v.union(
  v.literal("unchecked"),
  v.literal("running"),
  v.literal("stale"),
  v.literal("differs"),
  v.literal("clean"),
);
const sampleValidator = v.array(v.object({ path: v.string(), clearance: v.string() }));

const rowValidator = v.object({
  workspaceId: v.id("workspaces"),
  /** The workspace's slug, or null when it has none. */
  slug: v.union(v.string(), v.null()),
  archived: v.boolean(),
  status: statusValidator,
  checked: v.number(),
  differences: v.number(),
  /** Rules the derivation could not place: shown, and they do not block the switch. */
  orphans: v.number(),
  checkedAt: v.union(v.null(), v.number()),
});

/** The staff check, as every public function here runs it. */
async function staffActor(ctx: QueryCtx): Promise<AdminActor> {
  try {
    return await requireAdmin(ctx);
  } catch (error) {
    throw toConvexError(error);
  }
}

/** Every bound workspace, archived ones included: their rows answer a reader too, if they are ever read. */
const TOO_MANY = { code: "ROWS_TOO_MANY", message: "There are too many workspaces to check at once." } as const;

function noun(count: number): string {
  return count === 1 ? "workspace" : "workspaces";
}

interface Gate {
  /** Workspaces whose result does not stand for their rows now: unchecked, running, or stale. */
  notChecked: number;
  /** Workspaces whose current check found a difference. */
  differing: number;
}

async function gateOf(db: DatabaseReader, ids: Id<"workspaces">[]): Promise<Gate> {
  const gate: Gate = { notChecked: 0, differing: 0 };
  for (const workspaceId of ids) {
    const status = checkStatus(await checkRowOf(db, workspaceId), await accessStateRowOf(db, workspaceId));
    if (status === "differs") gate.differing += 1;
    else if (status !== "clean") gate.notChecked += 1;
  }
  return gate;
}

/** Why `rows` is refused right now, or null when it is allowed. */
async function refusalFor(
  db: DatabaseReader,
  source: AccessSource,
  ids: Id<"workspaces">[],
  truncated: boolean,
): Promise<{ code: string; message: string } | null> {
  if (truncated) return TOO_MANY;
  if (source === "file") {
    return {
      code: "ROWS_NOT_SHADOW",
      message: "Start keeping rows first. Rows decide who sees what only after they have been kept up to date and checked.",
    };
  }
  const gate = await gateOf(db, ids);
  if (gate.notChecked > 0) {
    return {
      code: "ROWS_NOT_CHECKED",
      message: `${gate.notChecked} ${noun(gate.notChecked)} ${gate.notChecked === 1 ? "has" : "have"} no current check of rows against the rules. Check every workspace, then try again.`,
    };
  }
  if (gate.differing > 0) {
    return {
      code: "ROWS_DIFFER",
      message: `${gate.differing} ${noun(gate.differing)} ${gate.differing === 1 ? "differs" : "differ"} from the rules. Fix the difference first; the sample on each row says where.`,
    };
  }
  // Rows are born keyed: a note's row is adopted at its id key, and the moves that keep rows are only safe there.
  if ((await db.query("noteIdLayout").first())?.mode !== "keys") {
    return {
      code: "ROWS_NEEDS_KEYS",
      message: "Notes have to be read from their id keys before rows can be the truth. Finish moving the note keys first.",
    };
  }
  return null;
}

/** Write the switch row, as `nodesPrivacy.setAccessSource` does for one workspace. */
async function writeSource(ctx: MutationCtx, actor: AdminActor, source: AccessSource): Promise<void> {
  const row = await ctx.db.query("nodeMigration").first();
  const fields = { accessSource: source, updatedAt: Date.now(), updatedBy: actor.userId };
  if (row === null) await ctx.db.insert("nodeMigration", { paused: false, ...fields });
  else await ctx.db.patch(row._id, fields);
}

async function auditSwitch(ctx: MutationCtx, actor: AdminActor, from: AccessSource, to: AccessSource): Promise<void> {
  if (from === to) return;
  await recordAdminAudit(ctx, actor, "rows.source_set", "accessSource", { from, to });
}

/** The switch, the gate's reason if any, and each workspace's check. Counts, times and paths-free labels only. */
export const report = query({
  args: {},
  returns: v.object({
    source: sourceValidator,
    truncated: v.boolean(),
    /** Whether `useRows` would be allowed now, and if not, the plain reason. */
    ready: v.object({ ok: v.boolean(), reason: v.union(v.string(), v.null()) }),
    rows: v.array(rowValidator),
  }),
  handler: async (ctx) => {
    await staffActor(ctx);
    const source = await accessSourceOf(ctx.db);
    const { ids, truncated } = await boundWorkspaces(ctx);
    const rows = [];
    for (const workspaceId of ids) {
      const workspace = await ctx.db.get(workspaceId);
      if (workspace === null) continue;
      const check = await checkRowOf(ctx.db, workspaceId);
      const state = await accessStateRowOf(ctx.db, workspaceId);
      rows.push({
        workspaceId,
        slug: workspace.slug ?? null,
        archived: await workspaceArchived(ctx.db, workspaceId),
        status: checkStatus(check, state),
        checked: check?.checked ?? 0,
        differences: check?.differences ?? 0,
        orphans: state?.orphans.length ?? 0,
        checkedAt: check?.checkedAt ?? null,
      });
    }
    const refusal = await refusalFor(ctx.db, source, ids, truncated);
    return { source, truncated, ready: { ok: refusal === null, reason: refusal?.message ?? null }, rows };
  },
});

/** One workspace's latest check, with the first differences it found (path and clearance only). Null if never checked. */
export const differencesFor = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      status: statusValidator,
      checked: v.number(),
      differences: v.number(),
      checkedAt: v.union(v.null(), v.number()),
      sample: sampleValidator,
    }),
  ),
  handler: async (ctx, { workspaceId }) => {
    await staffActor(ctx);
    const check = await checkRowOf(ctx.db, workspaceId);
    if (check === null) return null;
    const state = await accessStateRowOf(ctx.db, workspaceId);
    return {
      status: checkStatus(check, state),
      checked: check.checked,
      differences: check.differences,
      checkedAt: check.checkedAt ?? null,
      sample: check.sample,
    };
  },
});

/** Start keeping rows: the switch goes to `shadow`, and every workspace's rows are derived, one scheduled job each. */
export const startKeeping = mutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    const actor = await staffActor(ctx);
    const { ids, truncated } = await boundWorkspaces(ctx);
    if (truncated) throw new ConvexError(TOO_MANY);
    const from = await accessSourceOf(ctx.db);
    await writeSource(ctx, actor, "shadow");
    for (const workspaceId of ids) await ctx.scheduler.runAfter(0, internal.functions.privacyRows.deriveWorkspace, { workspaceId });
    await auditSwitch(ctx, actor, from, "shadow");
    return { started: ids.length };
  },
});

/**
 * Check every workspace: a fresh run per workspace, walked a page at a time by
 * scheduled `checkPage` jobs. A run started again while another is going
 * supersedes it; the old chain stops at its next page.
 */
export const checkAll = mutation({
  args: {},
  returns: v.object({ started: v.number() }),
  handler: async (ctx) => {
    await staffActor(ctx);
    const { ids, truncated } = await boundWorkspaces(ctx);
    if (truncated) throw new ConvexError(TOO_MANY);
    for (const workspaceId of ids) {
      const check = await checkRowOf(ctx.db, workspaceId);
      const state = await accessStateRowOf(ctx.db, workspaceId);
      const runId = (check?.runId ?? 0) + 1;
      const fields = {
        workspaceId,
        runId,
        status: "running" as const,
        version: state?.version ?? 0,
        startedAt: Date.now(),
        checked: 0,
        differences: 0,
        sample: [],
      };
      if (check === null) await ctx.db.insert("privacyRowChecks", fields);
      else await ctx.db.replace(check._id, fields);
      await ctx.scheduler.runAfter(0, internal.functions.privacyRows.checkPage, { workspaceId, runId, cursor: null });
    }
    return { started: ids.length };
  },
});

/** Move the readers to the rows. Refused unless every workspace's check stands and found nothing. */
/**
 * Whether every privacy write works under rows. True: the gateway, the console and moves write a row's access;
 * a note asked to be private before its row exists keeps that as pending access, and the row is born with it
 * (`lib/nodes/pendingAccess.ts`); a new context's scaffold defaults cannot be pre-empted (`scaffoldDerived`); a
 * website folder with no row takes team as pending. Unkeyed folder moves are refused, and rows need the keys
 * (`ROWS_NEEDS_KEYS`). Set false to hold Use rows again.
 */
export const ROWS_WRITES_READY = true;

const ROWS_WRITES_PENDING = {
  code: "ROWS_WRITES_PENDING",
  message: "Rows can be checked now, but switching to them waits until every privacy change can be saved on rows.",
};

export const useRows = mutation({
  args: {},
  returns: v.object({ source: sourceValidator }),
  handler: async (ctx) => {
    const actor = await staffActor(ctx);
    const from = await accessSourceOf(ctx.db);
    if (from === "rows") return { source: "rows" as const };
    const { ids, truncated } = await boundWorkspaces(ctx);
    const refusal = await refusalFor(ctx.db, from, ids, truncated);
    if (refusal !== null) throw new ConvexError(refusal);
    if (!ROWS_WRITES_READY) throw new ConvexError(ROWS_WRITES_PENDING);
    // Rows mode reads the rules the rows render, through the authority; with the file as the authority its stale rules would still judge a move.
    if (!(await privacyAuthorityOn(ctx.db))) {
      throw new ConvexError({
        code: "ROWS_NEEDS_AUTHORITY",
        message: "Turn on the privacy rules as the authority before using rows. The file would otherwise still judge moves.",
      });
    }
    await writeSource(ctx, actor, "rows");
    await auditSwitch(ctx, actor, from, "rows");
    return { source: "rows" as const };
  },
});

/**
 * Back to Off: the rules decide again. From `file` or `shadow` always allowed; the rows are kept, but nothing
 * reads them. From `rows` the rows are first written back as the rules (`renderRowsAsRules`), or refused.
 */
export const backToOff = mutation({
  args: {},
  returns: v.object({ source: sourceValidator }),
  handler: async (ctx) => {
    const actor = await staffActor(ctx);
    const from = await accessSourceOf(ctx.db);
    if (from === "rows") await renderRowsAsRules(ctx);
    await writeSource(ctx, actor, "file");
    await auditSwitch(ctx, actor, from, "file");
    return { source: "file" as const };
  },
});

/** Derive one workspace's access rows. Scheduled by `startKeeping`; a large tree is walked in pages by `backfillAccess`. INTERNAL. */
export const deriveWorkspace = internalMutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, { workspaceId }): Promise<null> => {
    await backfillAccess(ctx, workspaceId);
    return null;
  },
});

/**
 * One page of a workspace's parity check (`accessParityPage`), storing what it
 * found and scheduling the next page. A page whose run was superseded does
 * nothing. INTERNAL.
 */
export const checkPage = internalMutation({
  args: { workspaceId: v.id("workspaces"), runId: v.number(), cursor: v.union(v.null(), v.string()) },
  returns: v.null(),
  handler: async (ctx, { workspaceId, runId, cursor }): Promise<null> => {
    const check = await checkRowOf(ctx.db, workspaceId);
    if (check === null || check.runId !== runId || check.status !== "running") return null;
    const step = await accessParityPage(ctx, workspaceId, cursor);
    const sample = [...check.sample];
    for (const diff of step.diffs) {
      if (sample.length < SAMPLE_MAX) sample.push({ path: diff.path, clearance: diff.clearance });
    }
    const progress = { checked: check.checked + step.checked, differences: check.differences + step.diffs.length, sample };
    if (step.next !== null) {
      await ctx.db.patch(check._id, progress);
      await ctx.scheduler.runAfter(0, internal.functions.privacyRows.checkPage, { workspaceId, runId, cursor: step.next });
      return null;
    }
    const state = await accessStateRowOf(ctx.db, workspaceId);
    await ctx.db.patch(check._id, {
      ...progress,
      status: "done",
      checkedAt: Date.now(),
      orphans: state?.orphans.length ?? 0,
    });
    return null;
  },
});
