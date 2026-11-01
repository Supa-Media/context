/**
 * Copying every workspace into its workspace object, keeping the copy's rows
 * current, comparing the two, and the one switch that says where a
 * workspace's notes are read from (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * - `setHome`: the switch. The object takes the home first, then the record
 *   (`workspaceObjectHomes`), which the binding carries to every store
 *   (`storage.getBindingForGateway`). `object` is refused unless the last
 *   parity check, within the hour, found nothing.
 * - `backfill`: run by the "Workspace objects backfill" workflow. Step `arm`
 *   puts every bucket workspace on `dual`, so each save from then on is
 *   mirrored (`apps/mcp/src/store/workspaceRouting.js`). Step `copy` then
 *   copies every body (`lib/workspaceObjects/bodies.ts`, which never
 *   overwrites a newer mirrored write) and the rows and rules whole.
 * - `syncRows`: every minute, each `dual` workspace's rows and rules are
 *   pushed whole when the object's digest or rules version is not Convex's.
 *   Convex decides access while a workspace is `dual`; this only keeps the
 *   object's copy ready. A workspace at `object` is never pushed from Convex.
 * - `parity`: run by the "Workspace objects parity" workflow: bodies by
 *   SHA-256, rows by digest, rules as rendered, and who-can-see answers for
 *   sample readers. Each difference is asked again before it counts.
 *
 * Every answer is counts, never a key, a path or a body: the workflows' logs
 * are public, and so is this repository. Internal only.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { MAX_READ_IDS } from "../../mcp/src/workspaceStore/api.js";
import { managedEncryptionOption } from "./lib/managedEncryptionFns/storeOption";
import type { GatewayCredential } from "./lib/storage/shapes";
import { consoleTexRouting } from "./lib/texStore";
import {
  addCounts,
  copyPage,
  emptyBodyParity,
  emptyCopyCounts,
  objectBytesPage,
  parityPage,
  type BodyParity,
  type BodyStore,
  type CopyCounts,
  type ParityCursor,
  type SizeCursor,
  type WalkCursor,
} from "./lib/workspaceObjects/bodies";
import { addRevisionCounts, emptyRevisionCounts, revisionsPage, type RevisionCounts } from "./lib/workspaceObjects/revisions";
import { consoleWorkspaceClient, type WorkspaceObjectClient } from "./lib/workspaceObjects/door";
import { convexVisible, noteRows, objectRowOf, rowsDigest, samplePrincipals, type ObjectRow, type ReaderRules } from "./lib/workspaceObjects/rows";
import type { NotesHome } from "./workspaceObjectsRows";

const homeValidator = v.union(v.literal("bucket"), v.literal("dual"), v.literal("object"));
/** Rows per snapshot call: well under the object's 2,000 and the door's body size. */
const SNAPSHOT_CHUNK = 1000;
/** How long one page of a run may work before it hands back its cursor. */
const PAGE_BUDGET_MS = 2 * 60 * 1000;
/** Bucket keys listed per body page: small enough that one page never runs far past the budget. */
const KEYS_PER_PAGE = 100;
/** How recent a clean parity check must be for a workspace to be read from its object. */
const PARITY_FRESH_MS = 60 * 60 * 1000;
/** A difference is asked again after this long: a save in flight is mirrored by then. */
const RECHECK_MS = 5_000;
/**
 * The most a workspace's note texts and editing history may take to be copied: a SQLite Durable Object holds 10 GB.
 * A workspace past this is held back and counted, never cut short.
 */
const OBJECT_BYTES_CAP = 8 * 1024 * 1024 * 1024;
/** Rows are asked again after one sync tick has had time to run. */
const ROWS_RECHECK_MS = 70_000;

/** What a failure log may carry: the error's name and its code (a ConvexError's `data.code`, the gateway's `code`), never its message. */
export function failureOf(error: unknown): { error: string; code?: string } {
  const name = error instanceof Error ? error.name : "unknown";
  const data = (error as { data?: unknown } | null)?.data;
  const code = (data !== null && typeof data === "object" ? (data as { code?: unknown }).code : undefined) ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? { error: name, code } : { error: name };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The bucket alone, decrypted, logical-delete view; no workspace routing (no `workspaceStore` passed). `null` without a binding. */
async function openBucket(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<BodyStore | null> {
  const credential = (await ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId })) as GatewayCredential | null;
  if (credential === null) return null;
  const managedEncryption = await managedEncryptionOption(ctx, workspaceId);
  return storeForBinding({ ...credential, workspaceId: String(workspaceId) }, undefined, {
    managedEncryption,
    ...consoleTexRouting(ctx, workspaceId),
  }) as unknown as BodyStore;
}

/** Every live row of a workspace, as the object takes them, stamped `at`. */
async function convexRows(ctx: ActionCtx, workspaceId: Id<"workspaces">, at: number): Promise<ObjectRow[]> {
  const rows: ObjectRow[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 10_000; pages += 1) {
    const page = await ctx.runQuery(internal.functions.workspaceObjectsRows.rowsPage, { workspaceId, ...(after === undefined ? {} : { after }) });
    for (const row of page.rows) {
      const shaped = objectRowOf(row, at);
      if (shaped !== null) rows.push(shaped);
    }
    if (page.next === null) break;
    after = page.next;
  }
  return rows;
}

type HeldRules = { etag: string; folders: unknown[]; notes: unknown[]; accessVersion: number };

async function convexRules(ctx: ActionCtx, workspaceId: Id<"workspaces">): Promise<{ member: HeldRules; guest: HeldRules }> {
  const member = (await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId })) as HeldRules;
  const guest = (await ctx.runQuery(internal.functions.nodesPrivacy.authority, { workspaceId, audience: "guest" })) as HeldRules;
  return { member, guest };
}

/**
 * The rows and both audiences' rules pushed whole. `at` is taken before the
 * rows are read, so in `merge` mode any row the object wrote itself after the
 * read began is newer and kept.
 */
async function pushRows(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  client: WorkspaceObjectClient,
  mode: "replace" | "merge",
): Promise<{ rows: number; sha256: string; rulesVersion: number }> {
  const at = Date.now();
  const rows = await convexRows(ctx, workspaceId, at);
  const rules = await convexRules(ctx, workspaceId);
  const epoch = `${at}`;
  if (rows.length === 0) await client.rows.snapshot({ epoch, rows: [], last: true, mode });
  for (let start = 0; start < rows.length; start += SNAPSHOT_CHUNK) {
    await client.rows.snapshot({ epoch, rows: rows.slice(start, start + SNAPSHOT_CHUNK), last: start + SNAPSHOT_CHUNK >= rows.length, mode });
  }
  // A merge only adds and updates: a row Convex no longer has (trashed, deleted) is removed at the same clock, so a
  // narrowing taken just before the flip lands too, while a row the object wrote itself since (a newer clock) stays.
  if (mode === "merge") {
    const live = new Set(rows.map((row) => row.id));
    const stale: string[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 10_000; pages += 1) {
      const page = (await client.rows.list({ after, limit: 1000 } as never)) as { rows: Array<{ id: string }>; after?: string };
      for (const row of page.rows) if (!live.has(row.id)) stale.push(row.id);
      if (typeof page.after !== "string") break;
      after = page.after;
    }
    for (let start = 0; start < stale.length; start += SNAPSHOT_CHUNK) await client.rows.remove(stale.slice(start, start + SNAPSHOT_CHUNK), at);
  }
  await client.rules.put(rules.member, "member");
  await client.rules.put(rules.guest, "guest");
  const digest = await rowsDigest(rows);
  await ctx.runMutation(internal.functions.workspaceObjectsRows.recordCopy, {
    workspaceId,
    rowsSha: digest.sha256,
    rulesVersion: rules.member.accessVersion,
    rowsSyncedAt: Date.now(),
  });
  return { rows: digest.rows, sha256: digest.sha256, rulesVersion: rules.member.accessVersion };
}

/** The switch, object first. Answers why it refused, never a key or a path. */
async function setHomeFor(ctx: ActionCtx, workspaceId: Id<"workspaces">, home: NotesHome, force: boolean): Promise<{ ok: boolean; reason?: string }> {
  const client = consoleWorkspaceClient(ctx, workspaceId);
  if (client === null) return { ok: false, reason: "OBJECT_UNREACHABLE" };
  if (home === "object" && !force) {
    const record = await ctx.runQuery(internal.functions.workspaceObjectsRows.recordFor, { workspaceId });
    const parity = record?.parity;
    if (record?.backfilledAt === undefined) return { ok: false, reason: "NOT_BACKFILLED" };
    if (parity === undefined || Date.now() - parity.at > PARITY_FRESH_MS) return { ok: false, reason: "PARITY_STALE" };
    const clean =
      parity.bodies.missingInObject + parity.bodies.extraInObject + parity.bodies.differ + parity.visibility.differ === 0 &&
      parity.rows.match &&
      parity.rules.match;
    if (!clean) return { ok: false, reason: "PARITY_DIFFERS" };
  }
  await client.setHome(home);
  await ctx.runMutation(internal.functions.workspaceObjectsRows.recordHome, { workspaceId, home, now: Date.now() });
  // Flipping to the object: one last merge of Convex's rows, so a change Convex took just before the flip lands,
  // while anything the object wrote since keeps its newer clock.
  if (home === "object") await pushRows(ctx, workspaceId, client, "merge");
  return { ok: true };
}

/** Where a run stands: the workspace page, the workspaces left in it, and the body walk inside the first. */
interface RunCursor {
  page: string | null;
  queue: string[];
  exhausted: boolean;
  at?: WalkCursor;
  /** Counting the first workspace's size, carried across pages until it is known. */
  sizing?: SizeCursor;
  /** Measuring the first workspace's revisions: the listing cursor under `documents/`, and the sums so far. */
  revisions?: { cursor?: string; counts: RevisionCounts };
  /** The parity walk inside the first workspace, and what it has found so far. */
  check?: ParityCursor;
  found?: BodyParity;
}

function readCursor(raw: string | undefined): RunCursor {
  if (raw === undefined || raw === "") return { page: null, queue: [], exhausted: false };
  return JSON.parse(raw) as RunCursor;
}

/** The next workspace of a run, fetching the next page when the queue is empty; `null` when every one is done. */
async function nextWorkspace(ctx: ActionCtx, state: RunCursor): Promise<Id<"workspaces"> | null> {
  while (state.queue.length === 0) {
    if (state.exhausted) return null;
    const page = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspacesPage, { cursor: state.page });
    state.queue = page.ids.map(String);
    state.page = page.cursor;
    state.exhausted = page.done;
  }
  return state.queue[0] as Id<"workspaces">;
}

async function startState(ctx: ActionCtx, cursor: string | undefined, only: string | undefined): Promise<RunCursor | "NO_WORKSPACE"> {
  if (cursor) return readCursor(cursor);
  if (only === undefined || only === "") return readCursor(undefined);
  const id = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspaceBySlug, { slug: only });
  return id === null ? "NO_WORKSPACE" : { page: null, queue: [String(id)], exhausted: true };
}

const tallyValidator = v.object({ keys: v.number(), bytes: v.number(), largest: v.number() });
const revisionCountsValidator = v.object({ documents: v.number(), unreadable: v.number(), current: tallyValidator, older: tallyValidator });

const copyCountsValidator = v.object({
  listed: v.number(),
  copied: v.number(),
  same: v.number(),
  raced: v.number(),
  goneMeanwhile: v.number(),
  wouldCopy: v.number(),
  failed: v.number(),
  olderRevisions: v.number(),
  removedOlder: v.number(),
});

/** The switch, for the flip workflow and by hand. `object` waits for a clean, fresh parity check unless forced. */
export const setHome = internalAction({
  args: { workspaceId: v.id("workspaces"), home: homeValidator, force: v.optional(v.boolean()) },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { workspaceId, home, force }) => await setHomeFor(ctx, workspaceId, home, force === true),
});

/** The switch by handle, for the "Workspace objects home" workflow. */
export const setHomeBySlug = internalAction({
  args: { slug: v.string(), home: homeValidator, force: v.optional(v.boolean()) },
  returns: v.object({ ok: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { slug, home, force }): Promise<{ ok: boolean; reason?: string }> => {
    const workspaceId: Id<"workspaces"> | null = await ctx.runQuery(internal.functions.workspaceObjectsRows.workspaceBySlug, { slug });
    if (workspaceId === null) return { ok: false, reason: "NO_WORKSPACE" };
    return await setHomeFor(ctx, workspaceId, home, force === true);
  },
});

/** One page of the backfill. Counts only. `dryRun` writes nothing, the switch included. */
export const backfill = internalAction({
  args: {
    /** `revisions` measures how much of the history is current revisions; it reads only, whatever `dryRun` says. */
    step: v.union(v.literal("arm"), v.literal("copy"), v.literal("revisions")),
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    /** A handle: this workspace alone. */
    only: v.optional(v.string()),
  },
  returns: v.object({
    workspaces: v.number(),
    armed: v.number(),
    alreadyArmed: v.number(),
    notArmed: v.number(),
    unreachable: v.number(),
    failed: v.number(),
    heldBack: v.number(),
    bytes: v.number(),
    /** Of `bytes`: note texts, editing history and its key count, and the largest single key. */
    noteBytes: v.number(),
    historyBytes: v.number(),
    historyKeys: v.number(),
    largest: v.number(),
    /** Editing history by part (heads, documents, operations, revisions, structural, other): counts only. */
    historyParts: v.record(v.string(), v.object({ keys: v.number(), bytes: v.number(), largest: v.number() })),
    finished: v.number(),
    rows: v.number(),
    bodies: copyCountsValidator,
    /** Step `revisions`: the running totals for the workspace being measured, then the run's. */
    revisions: v.optional(revisionCountsValidator),
    refused: v.optional(v.string()),
    cursor: v.string(),
    done: v.boolean(),
  }),
  handler: async (ctx, { step, dryRun, cursor, only }) => {
    const counts = { workspaces: 0, armed: 0, alreadyArmed: 0, notArmed: 0, unreachable: 0, failed: 0, heldBack: 0, bytes: 0, noteBytes: 0, historyBytes: 0, historyKeys: 0, largest: 0, finished: 0, rows: 0 };
    const bodies: CopyCounts = emptyCopyCounts();
    const historyParts: Record<string, { keys: number; bytes: number; largest: number }> = {};
    const revisions = emptyRevisionCounts();
    const state = await startState(ctx, cursor, only);
    if (state === "NO_WORKSPACE") return { ...counts, bodies, historyParts, refused: "NO_WORKSPACE", cursor: "", done: true };
    const started = Date.now();
    while (Date.now() - started < PAGE_BUDGET_MS) {
      const workspaceId = await nextWorkspace(ctx, state);
      if (workspaceId === null) return { ...counts, bodies, historyParts, ...(step === "revisions" ? { revisions } : {}), cursor: "", done: true };
      const home = await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId });
      if (step === "arm") {
        counts.workspaces += 1;
        if (home !== "bucket") counts.alreadyArmed += 1;
        else if (dryRun) counts.armed += 1;
        else {
          const set = await setHomeFor(ctx, workspaceId, "dual", false);
          if (set.ok) counts.armed += 1;
          else counts.unreachable += 1;
        }
        state.queue.shift();
        continue;
      }
      if (step === "revisions") {
        try {
          const bucket = await openBucket(ctx, workspaceId);
          if (bucket === null) {
            counts.unreachable += 1;
            state.queue.shift();
            continue;
          }
          const measuring = state.revisions ?? { counts: emptyRevisionCounts() };
          const page = await revisionsPage(bucket, { ...(measuring.cursor ? { cursor: measuring.cursor } : {}), limit: KEYS_PER_PAGE });
          addRevisionCounts(measuring.counts, page.counts);
          if (page.next !== null) {
            state.revisions = { cursor: page.next, counts: measuring.counts };
            continue;
          }
          counts.workspaces += 1;
          addRevisionCounts(revisions, measuring.counts);
        } catch (error) {
          counts.failed += 1;
          console.warn(JSON.stringify({ event: "workspace_revisions_failed", workspaceId, error: error instanceof Error ? error.name : "unknown" }));
        }
        state.revisions = undefined;
        state.queue.shift();
        continue;
      }
      // Copy: only a workspace whose saves are already mirrored, or a copy could fall behind the moment it is made;
      // and never into one read from its object, whose own saves are newer than the bucket's copy written behind.
      if ((home === "bucket" && !dryRun) || home === "object") {
        if (home === "bucket") counts.notArmed += 1;
        else counts.alreadyArmed += 1;
        state.queue.shift();
        state.at = undefined;
        state.sizing = undefined;
        continue;
      }
      try {
        const bucket = await openBucket(ctx, workspaceId);
        const client = consoleWorkspaceClient(ctx, workspaceId);
        if (bucket === null || client === null) {
          counts.unreachable += 1;
          state.queue.shift();
          state.at = undefined;
          state.sizing = undefined;
          continue;
        }
        if (state.at === undefined) {
          // Counted before a byte is copied: one that would not fit is held back whole and named by count.
          // Counting is paged too: a workspace's history can run to hundreds of thousands of keys.
          // A dry run counts to the end, so a workspace held back is measured whole and by part.
          const cap = dryRun ? Number.POSITIVE_INFINITY : OBJECT_BYTES_CAP;
          const size = await objectBytesPage(bucket, state.sizing ?? { prefix: 0, keys: 0, bytes: 0 }, cap, started + PAGE_BUDGET_MS);
          if (size.next !== null) {
            state.sizing = size.next;
            continue;
          }
          state.sizing = undefined;
          counts.workspaces += 1;
          counts.bytes += size.bytes;
          counts.noteBytes += size.byPrefix[0]?.bytes ?? 0;
          counts.historyBytes += size.byPrefix[1]?.bytes ?? 0;
          counts.historyKeys += size.byPrefix[1]?.keys ?? 0;
          counts.largest = Math.max(counts.largest, size.largest);
          for (const [name, part] of Object.entries(size.parts)) {
            const into = (historyParts[name] ??= { keys: 0, bytes: 0, largest: 0 });
            into.keys += part.keys;
            into.bytes += part.bytes;
            into.largest = Math.max(into.largest, part.largest);
          }
          if (size.bytes > OBJECT_BYTES_CAP) {
            counts.heldBack += 1;
            console.warn(JSON.stringify({ event: "workspace_object_held_back", workspaceId, keys: size.keys, bytes: size.bytes }));
            state.queue.shift();
            continue;
          }
          state.at = { prefix: 0 };
        }
        const page = await copyPage(bucket, client.bodies as unknown as BodyStore, { at: state.at, limit: KEYS_PER_PAGE, dryRun });
        addCounts(bodies, page.counts);
        if (page.next !== null) {
          state.at = page.next;
          continue;
        }
        // Every body is across: the rows and rules whole, then the mark.
        if (!dryRun) {
          const pushed = await pushRows(ctx, workspaceId, client, "replace");
          counts.rows += pushed.rows;
          const now = Date.now();
          await client.markBackfilled(now);
          await ctx.runMutation(internal.functions.workspaceObjectsRows.recordCopy, { workspaceId, backfilledAt: now });
        }
        counts.finished += 1;
        state.queue.shift();
        state.at = undefined;
        state.sizing = undefined;
      } catch (error) {
        // One workspace that cannot be read (a revoked or broken binding) is counted and passed over, never the run's end.
        counts.failed += 1;
        console.warn(JSON.stringify({ event: "workspace_backfill_failed", workspaceId, ...failureOf(error) }));
        state.queue.shift();
        state.at = undefined;
        state.sizing = undefined;
      }
    }
    const running = step === "revisions" ? addRevisionCounts(addRevisionCounts(emptyRevisionCounts(), revisions), state.revisions?.counts ?? emptyRevisionCounts()) : null;
    return { ...counts, bodies, historyParts, ...(running ? { revisions: running } : {}), cursor: JSON.stringify(state), done: false };
  },
});

/** Every `dual` workspace's rows and rules pushed whole where the object's copy is not Convex's. From the cron. */
export const syncRows = internalAction({
  args: {},
  returns: v.object({ checked: v.number(), pushed: v.number(), unreachable: v.number() }),
  handler: async (ctx) => {
    const counts = { checked: 0, pushed: 0, unreachable: 0 };
    for (const workspaceId of await ctx.runQuery(internal.functions.workspaceObjectsRows.atHome, { home: "dual" })) {
      counts.checked += 1;
      const client = consoleWorkspaceClient(ctx, workspaceId);
      if (client === null) {
        counts.unreachable += 1;
        continue;
      }
      try {
        const [rows, rules, held, heldRules] = await Promise.all([
          convexRows(ctx, workspaceId, 0),
          convexRules(ctx, workspaceId),
          client.rows.digest() as Promise<{ rows: number; sha256: string }>,
          client.rules.get("member") as Promise<{ rules: HeldRules | null }>,
        ]);
        const digest = await rowsDigest(rows);
        if (digest.sha256 === held.sha256 && heldRules.rules?.accessVersion === rules.member.accessVersion) continue;
        await pushRows(ctx, workspaceId, client, "replace");
        counts.pushed += 1;
      } catch (error) {
        counts.unreachable += 1;
        console.warn(JSON.stringify({ event: "workspace_rows_sync_failed", workspaceId, ...failureOf(error) }));
      }
    }
    return counts;
  },
});

/** Two renderings of the rules, compared as the object holds them. */
const sameRules = (left: HeldRules | null | undefined, right: HeldRules | null | undefined) =>
  left !== null && left !== undefined && right !== null && right !== undefined &&
  left.accessVersion === right.accessVersion &&
  JSON.stringify(left.folders) === JSON.stringify(right.folders) &&
  JSON.stringify(left.notes) === JSON.stringify(right.notes);

async function visibilityParity(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  client: WorkspaceObjectClient,
  rows: ObjectRow[],
): Promise<{ principals: number; checked: number; differ: number }> {
  const readerRules = (await ctx.runQuery(internal.functions.nodesPrivacy.readerRules, { workspaceId })) as ReaderRules;
  const notes = noteRows(rows);
  const principals = samplePrincipals(readerRules);
  let checked = 0;
  let differ = 0;
  for (const principal of principals) {
    const expected = convexVisible(notes, readerRules, principal);
    for (let start = 0; start < notes.length; start += MAX_READ_IDS) {
      const chunk = notes.slice(start, start + MAX_READ_IDS);
      // `api.js` is plain JavaScript: its defaults type `groups` as an empty tuple, so the call is shaped by hand.
      const ask = { ids: chunk.map((row) => row.noteId as string), scope: principal.scope, groups: principal.groups } as unknown as Parameters<WorkspaceObjectClient["visible"]>[0];
      const seen = (await client.visible(ask)) as boolean[];
      chunk.forEach((_, index) => {
        checked += 1;
        if (seen[index] !== expected[start + index]) differ += 1;
      });
    }
  }
  return { principals: principals.length, checked, differ };
}

const parityCounts = v.object({
  workspaces: v.number(),
  clean: v.number(),
  differing: v.number(),
  unreachable: v.number(),
  bodiesDiffer: v.number(),
  rowsDiffer: v.number(),
  rulesDiffer: v.number(),
  visibilityDiffer: v.number(),
  refused: v.optional(v.string()),
  cursor: v.string(),
  done: v.boolean(),
});

/** The rows, rules and who-can-see half of one workspace's check, asked again after a sync tick when they differ. */
async function treeParity(ctx: ActionCtx, workspaceId: Id<"workspaces">, client: WorkspaceObjectClient) {
  const look = async () => {
    const rows = await convexRows(ctx, workspaceId, 0);
    const digest = await rowsDigest(rows);
    const held = (await client.rows.digest()) as { rows: number; sha256: string };
    const rules = await convexRules(ctx, workspaceId);
    const heldMember = ((await client.rules.get("member")) as { rules: HeldRules | null }).rules;
    const heldGuest = ((await client.rules.get("guest")) as { rules: HeldRules | null }).rules;
    return { rows, digest, held, rulesMatch: sameRules(rules.member, heldMember) && sameRules(rules.guest, heldGuest) };
  };
  let seen = await look();
  // In `dual` the object's rows trail Convex by up to one sync tick.
  if (seen.digest.sha256 !== seen.held.sha256 || !seen.rulesMatch) {
    await sleep(ROWS_RECHECK_MS);
    seen = await look();
  }
  const visibility = await visibilityParity(ctx, workspaceId, client, seen.rows);
  return {
    rows: { convex: seen.digest.rows, object: seen.held.rows, match: seen.digest.sha256 === seen.held.sha256 },
    rules: { match: seen.rulesMatch },
    visibility,
  };
}

/** One page of the parity check over every workspace that is not `bucket` (or one, by handle). Counts only. */
export const parity = internalAction({
  args: { cursor: v.optional(v.string()), only: v.optional(v.string()) },
  returns: parityCounts,
  handler: async (ctx, { cursor, only }) => {
    const counts = { workspaces: 0, clean: 0, differing: 0, unreachable: 0, bodiesDiffer: 0, rowsDiffer: 0, rulesDiffer: 0, visibilityDiffer: 0 };
    const state = await startState(ctx, cursor, only);
    if (state === "NO_WORKSPACE") return { ...counts, refused: "NO_WORKSPACE", cursor: "", done: true };
    const started = Date.now();
    const finishWorkspace = () => {
      state.queue.shift();
      state.check = undefined;
      state.found = undefined;
    };
    while (Date.now() - started < PAGE_BUDGET_MS) {
      const workspaceId = await nextWorkspace(ctx, state);
      if (workspaceId === null) return { ...counts, cursor: "", done: true };
      if (state.check === undefined) {
        const home = await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId });
        if (home === "bucket") {
          finishWorkspace();
          continue;
        }
        counts.workspaces += 1;
      }
      try {
        const bucket = await openBucket(ctx, workspaceId);
        const client = consoleWorkspaceClient(ctx, workspaceId);
        if (bucket === null || client === null) {
          counts.unreachable += 1;
          finishWorkspace();
          continue;
        }
        const page = await parityPage(bucket, client.bodies as unknown as BodyStore, {
          at: state.check ?? { side: 0, prefix: 0 },
          limit: KEYS_PER_PAGE,
          recheckMs: RECHECK_MS,
          sleep,
        });
        state.found = addCounts(state.found ?? emptyBodyParity(), page.parity);
        if (page.next !== null) {
          state.check = page.next;
          continue;
        }
        const bodies = state.found ?? emptyBodyParity();
        const tree = await treeParity(ctx, workspaceId, client);
        const result = { at: Date.now(), bodies, ...tree };
        await ctx.runMutation(internal.functions.workspaceObjectsRows.recordParity, { workspaceId, parity: result });
        const bodiesDiffer = bodies.missingInObject + bodies.extraInObject + bodies.differ > 0;
        if (bodiesDiffer) counts.bodiesDiffer += 1;
        if (!tree.rows.match) counts.rowsDiffer += 1;
        if (!tree.rules.match) counts.rulesDiffer += 1;
        if (tree.visibility.differ > 0) counts.visibilityDiffer += 1;
        if (bodiesDiffer || !tree.rows.match || !tree.rules.match || tree.visibility.differ > 0) counts.differing += 1;
        else counts.clean += 1;
      } catch (error) {
        counts.unreachable += 1;
        console.warn(JSON.stringify({ event: "workspace_parity_failed", workspaceId, ...failureOf(error) }));
      }
      finishWorkspace();
    }
    return { ...counts, cursor: JSON.stringify(state), done: false };
  },
});
