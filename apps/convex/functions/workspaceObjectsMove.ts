/**
 * Every workspace moved onto its workspace object, on its own (decided by the owner, 2026-11-20: "move everything to
 * a durable object, unless they are bringing their own storage"; `docs/decisions/storage-and-credentials/
 * workspace-objects.md`, "Every workspace is moved on its own").
 *
 * Until now a workspace moved only when someone ran the "Workspace objects" workflows for it, so every workspace made
 * since the first move stayed on the control plane and its bucket. Now:
 *
 * - **A new workspace** starts moving the moment its managed bucket is bound (`managedProvisioningFns/complete.ts`):
 *   armed before its first folders are written, copied, compared and switched within minutes.
 * - **Every other workspace** on managed storage is picked up by `sweep`, hourly, until it is wholly on its object.
 * - **A bucket of the workspace's own** is never moved, and a workspace with no storage waits for its bucket.
 *
 * `advance` takes one step at a time (`lib/workspaceObjects/moveStep.ts`) through the same functions the workflows
 * call, so each switch keeps its own guard: `object` only after a fresh, clean parity check. A step that cannot prove
 * the copy stops the run with a closed word on the record (`moveNote`) and the workspace stays where it was; the
 * sweep tries again an hour later. Logs carry the workspace id, step and closed words, never a key, path or body.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { failureOf } from "./lib/workspaceObjects/failures";
import { nextMoveStep, type MoveFacts } from "./lib/workspaceObjects/moveStep";
import { MOVE_LEASE_MS } from "./workspaceObjectsMoveRows";

/** How long one run works before it hands its place to the next: well inside an action's ten minutes. */
const RUN_BUDGET_MS = 5 * 60 * 1000;
/**
 * The wait after arming, before the copy: a request already holding the older binding has finished by then (so every
 * later save is mirrored), and a new workspace's first folders have been written.
 */
export const ARM_WAIT_MS = 2 * 60 * 1000;
/** Workspaces one sweep starts, spaced so they do not all read their buckets at once. */
const SWEEP_MAX = 10;
const SWEEP_SPACING_MS = 30 * 1000;
/** Pages of one copy or check before a run gives up on it. */
const MAX_PAGES = 400;

const phaseValidator = v.union(v.literal("notes_copy"), v.literal("notes_check"), v.literal("access_copy"), v.literal("access_check"));
type Phase = "notes_copy" | "notes_check" | "access_copy" | "access_check";

/** A run on this workspace alone: the cursor queues it and ends the listing, as the parity workflow builds it. */
const aloneCursor = (workspaceId: Id<"workspaces">) => JSON.stringify({ page: null, queue: [String(workspaceId)], exhausted: true });

type Advance = { workspaceId: Id<"workspaces">; phase?: Phase; cursor?: string; renew?: boolean };
type Outcome = { note: string } | { next: Advance; delayMs: number } | "again";

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ event, ...fields }));

/** Pages one of the workflows' paged actions to its end, or answers where it stopped when the run's time is up. */
async function pageThrough<T extends { cursor: string; done: boolean }>(
  run: (cursor: string) => Promise<T>,
  start: string,
  deadline: number,
  each: (page: T) => void,
): Promise<{ done: true } | { done: false; cursor: string }> {
  let cursor = start;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer = await run(cursor);
    each(answer);
    if (answer.done) return { done: true };
    cursor = answer.cursor;
    if (Date.now() > deadline) return { done: false, cursor };
  }
  throw new Error("move: too many pages");
}

async function notesCopyCheck(ctx: ActionCtx, workspaceId: Id<"workspaces">, phase: Phase, cursor: string, deadline: number): Promise<Outcome> {
  if (phase === "notes_copy") {
    let failed = 0;
    let heldBack = 0;
    const copied = await pageThrough(
      async (at) => await ctx.runAction(internal.functions.workspaceObjects.backfill, { step: "copy", dryRun: false, cursor: at }),
      cursor,
      deadline,
      (page) => {
        failed += page.failed + page.unreachable + page.bodies.failed;
        heldBack += page.heldBack;
      },
    );
    if (!copied.done) return { next: { workspaceId, phase: "notes_copy", cursor: copied.cursor, renew: true }, delayMs: 0 };
    if (heldBack > 0) return { note: "notes_too_big" };
    if (failed > 0) return { note: "notes_copy_failed" };
    return { next: { workspaceId, phase: "notes_check", cursor: aloneCursor(workspaceId), renew: true }, delayMs: 0 };
  }
  let switched = 0;
  let why = "";
  const checked = await pageThrough(
    async (at) => await ctx.runAction(internal.functions.workspaceObjects.parity, { cursor: at, switchClean: true }),
    cursor,
    deadline,
    (page) => {
      switched += page.switched;
      if (page.differing > 0) why = "notes_parity_differs";
      else if (page.unreachable > 0) why = "notes_unreachable";
    },
  );
  if (!checked.done) return { next: { workspaceId, phase: "notes_check", cursor: checked.cursor, renew: true }, delayMs: 0 };
  return switched > 0 ? "again" : { note: why || "notes_not_switched" };
}

async function accessCopyCheck(ctx: ActionCtx, workspaceId: Id<"workspaces">, phase: Phase, cursor: string, deadline: number, facts: MoveFacts): Promise<Outcome> {
  if (phase === "access_copy") {
    let failed = 0;
    const copied = await pageThrough(
      async (at) => await ctx.runAction(internal.functions.accessObjects.backfill, { step: "copy", dryRun: false, cursor: at }),
      cursor,
      deadline,
      (page) => {
        failed += page.failed + page.unreachable + page.notReady;
      },
    );
    if (!copied.done) return { next: { workspaceId, phase: "access_copy", cursor: copied.cursor, renew: true }, delayMs: 0 };
    if (failed > 0) return { note: "access_copy_failed" };
    return { next: { workspaceId, phase: "access_check", cursor: aloneCursor(workspaceId), renew: true }, delayMs: 0 };
  }
  const checked = await pageThrough(
    async (at) => await ctx.runAction(internal.functions.accessObjects.parity, { cursor: at }),
    cursor,
    deadline,
    () => {},
  );
  if (!checked.done) return { next: { workspaceId, phase: "access_check", cursor: checked.cursor, renew: true }, delayMs: 0 };
  // Each scope still mirroring is switched; `setAccess` refuses unless its own check just came back clean.
  const scopes: Array<{ scope: "workspace" | "person"; home: string }> = [{ scope: "workspace", home: facts.access }];
  if (facts.personal && facts.hasPerson) scopes.push({ scope: "person", home: facts.personAccess });
  for (const { scope, home } of scopes) {
    if (home !== "dual") continue;
    const set = await ctx.runAction(internal.functions.accessObjects.setAccess, { workspaceId, scope, home: "object" });
    if (!set.ok) return { note: `access_${scope}_${(set.reason ?? "refused").toLowerCase()}` };
  }
  return "again";
}

/** One step from what the record says now, or the phase a previous run handed on. */
async function step(ctx: ActionCtx, args: Advance, deadline: number): Promise<Outcome> {
  const facts: MoveFacts = await ctx.runQuery(internal.functions.workspaceObjectsMoveRows.factsFor, { workspaceId: args.workspaceId });
  const { workspaceId } = args;
  if (args.phase !== undefined && args.cursor !== undefined) {
    const phase = args.phase;
    args.phase = undefined;
    const cursor = args.cursor;
    args.cursor = undefined;
    if (phase.startsWith("notes")) return facts.notes === "dual" ? await notesCopyCheck(ctx, workspaceId, phase, cursor, deadline) : "again";
    const stillDual = facts.access === "dual" || (facts.personal && facts.hasPerson && facts.personAccess === "dual");
    return stillDual ? await accessCopyCheck(ctx, workspaceId, phase, cursor, deadline, facts) : "again";
  }
  const next = nextMoveStep(facts);
  log("workspace_move_step", { workspaceId, step: next.step });
  switch (next.step) {
    case "skip":
      return { note: next.why };
    case "done":
      return { note: "done" };
    case "notes_arm": {
      const set = await ctx.runAction(internal.functions.workspaceObjects.setHome, { workspaceId, home: "dual" });
      if (!set.ok) return { note: `notes_arm_${(set.reason ?? "refused").toLowerCase()}` };
      return { next: { workspaceId, phase: "notes_copy", cursor: aloneCursor(workspaceId), renew: true }, delayMs: ARM_WAIT_MS };
    }
    case "notes_copy_check":
      return await notesCopyCheck(ctx, workspaceId, "notes_copy", aloneCursor(workspaceId), deadline);
    case "access_arm": {
      const scopes: Array<{ scope: "workspace" | "person"; home: string }> = [{ scope: "workspace", home: facts.access }];
      if (facts.personal && facts.hasPerson) scopes.push({ scope: "person", home: facts.personAccess });
      for (const { scope, home } of scopes) {
        if (home !== "convex") continue;
        const set = await ctx.runAction(internal.functions.accessObjects.setAccess, { workspaceId, scope, home: "dual" });
        if (!set.ok) return { note: `access_arm_${scope}_${(set.reason ?? "refused").toLowerCase()}` };
      }
      return { next: { workspaceId, phase: "access_copy", cursor: aloneCursor(workspaceId), renew: true }, delayMs: ARM_WAIT_MS };
    }
    case "access_copy_check":
      return await accessCopyCheck(ctx, workspaceId, "access_copy", aloneCursor(workspaceId), deadline, facts);
    case "texting_push": {
      const pushed = await ctx.runAction(internal.functions.textingObjects.push, { workspaceId, switchOn: true });
      return pushed === "pushed" ? "again" : { note: "texting_skipped" };
    }
  }
}

/**
 * Moves one workspace as far as it can go: each step chosen again from the record, a long copy handed to the next run
 * with its cursor, the wait after arming spent outside any run. Holds the workspace's lease while it works.
 */
export const advance = internalAction({
  args: { workspaceId: v.id("workspaces"), phase: v.optional(phaseValidator), cursor: v.optional(v.string()), renew: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { workspaceId } = args;
    const started = Date.now();
    const deadline = started + RUN_BUDGET_MS;
    if (args.renew !== true) {
      const claimed: boolean = await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.claimMove, { workspaceId, now: started, until: started + MOVE_LEASE_MS });
      if (!claimed) {
        log("workspace_move_held", { workspaceId });
        return null;
      }
    }
    const state: Advance = { ...args };
    try {
      for (let steps = 0; steps < 12; steps += 1) {
        const outcome = await step(ctx, state, deadline);
        if (outcome === "again") {
          if (Date.now() > deadline) {
            await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.renewMove, { workspaceId, until: Date.now() + MOVE_LEASE_MS });
            await ctx.scheduler.runAfter(0, internal.functions.workspaceObjectsMove.advance, { workspaceId, renew: true });
            return null;
          }
          continue;
        }
        if ("next" in outcome) {
          // The record may have been written since the lease was taken (a first arm creates it): hold it to the wait's end.
          await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.renewMove, { workspaceId, until: Date.now() + outcome.delayMs + MOVE_LEASE_MS });
          await ctx.scheduler.runAfter(outcome.delayMs, internal.functions.workspaceObjectsMove.advance, outcome.next);
          return null;
        }
        log("workspace_move_stopped", { workspaceId, note: outcome.note });
        await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.releaseMove, { workspaceId, now: Date.now(), note: outcome.note });
        return null;
      }
      await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.releaseMove, { workspaceId, now: Date.now(), note: "too_many_steps" });
    } catch (error) {
      const failure = failureOf(error);
      console.warn(JSON.stringify({ event: "workspace_move_failed", workspaceId, ...failure }));
      await ctx.runMutation(internal.functions.workspaceObjectsMoveRows.releaseMove, { workspaceId, now: Date.now(), note: `failed_${failure.error}`.toLowerCase() });
    }
    return null;
  },
});

/** Hourly: starts a run for each managed workspace not yet wholly on its object and not tried within the hour. */
export const sweep = internalAction({
  args: {},
  returns: v.object({ started: v.number(), waiting: v.number() }),
  handler: async (ctx): Promise<{ started: number; waiting: number }> => {
    const ids: Id<"workspaces">[] = await ctx.runQuery(internal.functions.workspaceObjectsMoveRows.toMove, { now: Date.now() });
    const now = ids.slice(0, SWEEP_MAX);
    for (const [index, workspaceId] of now.entries()) {
      await ctx.scheduler.runAfter(index * SWEEP_SPACING_MS, internal.functions.workspaceObjectsMove.advance, { workspaceId });
    }
    return { started: now.length, waiting: ids.length - now.length };
  },
});
