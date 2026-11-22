/**
 * The control plane's side of moving every workspace onto its workspace object (`workspaceObjectsMove.ts`): the facts
 * one step is chosen from, the lease that keeps two runs off one workspace, and the census of where every workspace
 * stands. Counts and closed words only, never a key, a path, a handle or a body: the census prints in a public log.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type DatabaseReader } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { bindingIsManaged } from "./lib/billing/plan";
import { isMoved, nextMoveStep, type MoveFacts, type Storage } from "./lib/workspaceObjects/moveStep";

/** How long one run holds a workspace before another may take it: past the longest step and its waits. */
export const MOVE_LEASE_MS = 20 * 60 * 1000;
/** How long after a step that did not finish (a difference, an unreachable object) the sweep tries it again. */
export const MOVE_RETRY_MS = 60 * 60 * 1000;
/** The most workspaces a census or a sweep reads: far past production's, and inside one query's reads. */
const MAX_WORKSPACES = 4000;

async function recordOf(db: DatabaseReader, workspaceId: Id<"workspaces">): Promise<Doc<"workspaceObjectHomes"> | null> {
  return await db
    .query("workspaceObjectHomes")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

async function factsOf(db: DatabaseReader, workspace: Doc<"workspaces"> | null, workspaceId: Id<"workspaces">): Promise<MoveFacts & { record: Doc<"workspaceObjectHomes"> | null }> {
  const record = await recordOf(db, workspaceId);
  const binding = await db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .first();
  const storage: Storage = binding === null ? "none" : bindingIsManaged(binding, workspaceId) ? "managed" : "own";
  const personal = workspace?.kind === "personal";
  let hasPerson = false;
  if (personal) {
    const owners = (
      await db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .take(10)
    ).filter((member) => member.role === "owner");
    hasPerson = owners.length === 1;
  }
  return {
    record,
    exists: workspace !== null,
    storage,
    personal,
    hasPerson,
    notes: record?.home ?? "bucket",
    access: record?.access ?? "convex",
    personAccess: record?.personAccess ?? "convex",
    texting: record?.texting ?? "convex",
  };
}

const factsValidator = v.object({
  exists: v.boolean(),
  storage: v.union(v.literal("none"), v.literal("own"), v.literal("managed")),
  personal: v.boolean(),
  hasPerson: v.boolean(),
  notes: v.union(v.literal("bucket"), v.literal("dual"), v.literal("object")),
  access: v.union(v.literal("convex"), v.literal("dual"), v.literal("object")),
  personAccess: v.union(v.literal("convex"), v.literal("dual"), v.literal("object")),
  texting: v.union(v.literal("convex"), v.literal("object")),
});

/** What one step of `workspaceId`'s move is chosen from. */
export const factsFor = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: factsValidator,
  handler: async (ctx, { workspaceId }) => {
    const { record: _record, ...facts } = await factsOf(ctx.db, await ctx.db.get(workspaceId), workspaceId);
    return facts;
  },
});

/**
 * Takes `workspaceId` for one run until `until`, or answers false while another run holds it. A workspace with no
 * record yet (never armed) has nothing to lease: its first step writes the record, and arming twice is harmless.
 */
export const claimMove = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number(), until: v.number() },
  returns: v.boolean(),
  handler: async (ctx, { workspaceId, now, until }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record === null) return true;
    if (record.moveLeaseUntil !== undefined && record.moveLeaseUntil > now) return false;
    await ctx.db.patch(record._id, { moveLeaseUntil: until });
    return true;
  },
});

/** Holds the lease on for the run that carries on (after a wait, or with a long copy's cursor). */
export const renewMove = internalMutation({
  args: { workspaceId: v.id("workspaces"), until: v.number() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, until }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record !== null) await ctx.db.patch(record._id, { moveLeaseUntil: until });
    return null;
  },
});

/** Hands the lease back with how the run ended: `note` is a closed word (`done`, `parity_differs`, …). */
export const releaseMove = internalMutation({
  args: { workspaceId: v.id("workspaces"), now: v.number(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { workspaceId, now, note }) => {
    const record = await recordOf(ctx.db, workspaceId);
    if (record !== null) await ctx.db.patch(record._id, { moveLeaseUntil: undefined, moveTriedAt: now, moveNote: note.slice(0, 60) });
    return null;
  },
});

/** The workspaces a sweep should move now: with storage (managed or their own), not wholly moved, not held, not tried within the hour. */
export const toMove = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("workspaces")),
  handler: async (ctx, { now }) => {
    const ids: Id<"workspaces">[] = [];
    for (const workspace of await ctx.db.query("workspaces").take(MAX_WORKSPACES)) {
      const facts = await factsOf(ctx.db, workspace, workspace._id);
      const step = nextMoveStep(facts).step;
      if (step === "skip" || step === "done") continue;
      const record = facts.record;
      if (record?.moveLeaseUntil !== undefined && record.moveLeaseUntil > now) continue;
      if (record?.moveTriedAt !== undefined && now - record.moveTriedAt < MOVE_RETRY_MS) continue;
      ids.push(workspace._id);
    }
    return ids;
  },
});

const homeCounts = () => ({ bucket: 0, dual: 0, object: 0 });
const accessCounts = () => ({ convex: 0, dual: 0, object: 0 });

/**
 * Where every workspace stands, in counts only: storage by kind, each switch by home, how many are wholly on their
 * object, and the last run's word for those that are not.
 */
export const census = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const counts = {
      workspaces: 0,
      storage: { none: 0, own: 0, managed: 0 },
      /** Of those with storage (managed or their own): wholly on their object, and the next step for the rest. */
      moved: 0,
      notMoved: 0,
      next: {} as Record<string, number>,
      lastNote: {} as Record<string, number>,
      notes: homeCounts(),
      access: accessCounts(),
      personAccess: accessCounts(),
      texting: { convex: 0, object: 0 },
      /** Own-storage workspaces by notes home, also counted in `notes`: they move like managed ones since 2026-11-22. */
      ownNotes: homeCounts(),
      /**
       * Workspaces by how many live folders do the `tex` job: two or more is a state the job rules never leave, in which
       * the workspace object asks the control plane where a new Tex note goes (`apps/mcp/src/workspaceStore/
       * lookupMiss.js` `texFolderOf`). Counts only.
       */
      texFolders: { none: 0, one: 0, many: 0 },
    };
    for (const workspace of await ctx.db.query("workspaces").take(MAX_WORKSPACES)) {
      const facts = await factsOf(ctx.db, workspace, workspace._id);
      counts.workspaces += 1;
      counts.storage[facts.storage] += 1;
      const tex = (
        await ctx.db
          .query("nodes")
          .withIndex("by_workspace_role", (q) => q.eq("workspaceId", workspace._id).eq("role", "tex"))
          .take(8)
      ).filter((row) => row.goneAt === undefined && row.kind === "folder").length;
      counts.texFolders[tex === 0 ? "none" : tex === 1 ? "one" : "many"] += 1;
      if (facts.storage === "own") counts.ownNotes[facts.notes] += 1;
      if (facts.storage === "none") continue;
      counts.notes[facts.notes] += 1;
      counts.access[facts.access] += 1;
      if (facts.personal && facts.hasPerson) {
        counts.personAccess[facts.personAccess] += 1;
        counts.texting[facts.texting] += 1;
      }
      if (isMoved(facts)) counts.moved += 1;
      else {
        counts.notMoved += 1;
        const step = nextMoveStep(facts).step;
        counts.next[step] = (counts.next[step] ?? 0) + 1;
        const note = facts.record?.moveNote ?? "never_tried";
        counts.lastNote[note] = (counts.lastNote[note] ?? 0) + 1;
      }
    }
    return counts;
  },
});
