/**
 * Every write a mutation makes to a workspace's tree rows or their access, noticed where it happens.
 *
 * A workspace whose notes live in its object (`workspaceObjectHomes.home === "object"`) is judged there: the
 * object holds a copy of its rows and access rules and decides every read by them
 * (`docs/decisions/storage-and-credentials/workspace-objects.md`). Convex still takes the writes, from 30-odd
 * places, and a query or mutation cannot call the object. So no writer is trusted to remember to tell it: every
 * mutation's database is wrapped (`./mutations.ts`), each write to `nodes`, `nodeAccess` or `nodeAccessState` is
 * recorded here, and when the mutation's handler returns, one outbox entry per object-mode workspace it touched is
 * written in the same transaction and a push to the object is scheduled (`../../workspaceObjectPush.ts`). A write
 * that rolls back takes its entry with it.
 *
 * A CI test (`__tests__/rowWatchGuard.test.ts`) refuses any file that builds a mutation from `_generated/server`
 * directly, so a new writer cannot step around this.
 */

import type { GenericId } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { ACCESS_TABLES, mayMatter, type AccessSource, type AccessWrite } from "../accessHandOff/record";

/** The tables whose writes change what a workspace object must hold. */
export const WATCHED_TABLES = ["nodes", "nodeAccess", "nodeAccessState"] as const;
type Watched = (typeof WATCHED_TABLES)[number];

/** Fields of a `nodes` row that only say which version of the bytes it is at: no rule changes with them. */
const BYTES_ONLY = new Set(["etag", "size", "uploaded", "observedAt", "idCopy", "keyedFrom", "storageKey", "noteId"]);

/** What one workspace's writes in this mutation amount to. */
export type WorkspaceChange = {
  /** `nodes` rows written: pushed as they stand when the push reads them, or removed if gone. */
  nodeIds: Set<Id<"nodes">>;
  /** Whether the access rules may have changed, so the push renders and sends them. */
  access: boolean;
};

export type RowWatch = {
  db: MutationCtx["db"];
  changes: Map<Id<"workspaces">, WorkspaceChange>;
  /** Writes to who may reach what (`../accessHandOff/record.ts`), for `../accessHandOff/flush.ts`. */
  accessWrites: AccessWrite[];
};

function tableOf(db: MutationCtx["db"], id: string): Watched | null {
  for (const table of WATCHED_TABLES) {
    if (db.normalizeId(table, id) !== null) return table;
  }
  return null;
}

function accessTableOf(db: MutationCtx["db"], id: string): AccessSource | null {
  for (const table of ACCESS_TABLES) {
    if (db.normalizeId(table, id) !== null) return table;
  }
  return null;
}

function changeFor(changes: Map<Id<"workspaces">, WorkspaceChange>, workspaceId: Id<"workspaces">): WorkspaceChange {
  let change = changes.get(workspaceId);
  if (change === undefined) {
    change = { nodeIds: new Set(), access: false };
    changes.set(workspaceId, change);
  }
  return change;
}

type Doc = Record<string, unknown> & { workspaceId?: Id<"workspaces"> };

/**
 * Record one write. `fields` is what a patch named (`null` for an insert, a replace or a delete, which may change
 * anything). A row with no workspace is not a workspace's and is ignored.
 */
function record(
  changes: Map<Id<"workspaces">, WorkspaceChange>,
  table: Watched,
  id: string,
  doc: Doc | null,
  fields: string[] | null,
): void {
  const workspaceId = doc?.workspaceId;
  if (typeof workspaceId !== "string") return;
  const change = changeFor(changes, workspaceId);
  if (table === "nodeAccess" || table === "nodeAccessState") {
    change.access = true;
    return;
  }
  const nodeId = id as Id<"nodes">;
  change.nodeIds.add(nodeId);
  // A folder whose path changed is pushed as one row; the object rewrites everything under it (`ws.rows.put`).
  // Rules are keyed by path and carry each row's own access, so anything but a bytes-only patch may change them.
  if (fields === null || fields.some((field) => !BYTES_ONLY.has(field))) change.access = true;
}

/**
 * The mutation's database, with every write to a watched table recorded in `changes`. Reads, `system`, and writes
 * to any other table pass straight through.
 */
export function watchDb(db: MutationCtx["db"]): RowWatch {
  const changes = new Map<Id<"workspaces">, WorkspaceChange>();
  const accessWrites: AccessWrite[] = [];
  const watched = Object.create(db) as MutationCtx["db"];
  const noteAccess = (table: AccessSource, id: string, doc: unknown, op: AccessWrite["op"]) => {
    if (doc !== null && typeof doc === "object") accessWrites.push({ table, id, op, doc: doc as Record<string, unknown> });
  };
  // Before and after: a patch that moves a row to another person or workspace changes both.
  const accessBefore = async (id: string, fields: string[] | null) => {
    const table = accessTableOf(db, id);
    if (table === null || !mayMatter(table, fields)) return null;
    noteAccess(table, id, await db.get(id as GenericId<AccessSource>), "before");
    return table;
  };

  // Both of Convex's call shapes: `(table, id, value)` and `(id, value)`.
  const split = (args: unknown[]): { id: string; rest: unknown[] } =>
    args.length >= 3 || (args.length === 2 && typeof args[1] === "string")
      ? { id: args[1] as string, rest: args.slice(2) }
      : { id: args[0] as string, rest: args.slice(1) };

  Object.assign(watched, {
    async insert(table: string, value: Doc) {
      const id = await (db.insert as (table: string, value: unknown) => Promise<GenericId<string>>)(table, value);
      if ((WATCHED_TABLES as readonly string[]).includes(table)) record(changes, table as Watched, id, value, null);
      if ((ACCESS_TABLES as readonly string[]).includes(table)) noteAccess(table as AccessSource, String(id), value, "insert");
      return id;
    },
    async patch(...args: unknown[]) {
      const { id, rest } = split(args);
      const value = rest[0];
      const fields = value !== null && typeof value === "object" ? Object.keys(value) : null;
      const access = await accessBefore(id, fields);
      await (db.patch as (...a: unknown[]) => Promise<void>)(...args);
      if (access !== null) noteAccess(access, id, await db.get(id as GenericId<AccessSource>), "after");
      const table = tableOf(db, id);
      if (table === null) return;
      record(changes, table, id, (await db.get(id as GenericId<Watched>)) as Doc | null, fields);
    },
    async replace(...args: unknown[]) {
      const { id } = split(args);
      const access = await accessBefore(id, null);
      await (db.replace as (...a: unknown[]) => Promise<void>)(...args);
      if (access !== null) noteAccess(access, id, await db.get(id as GenericId<AccessSource>), "after");
      const table = tableOf(db, id);
      if (table === null) return;
      record(changes, table, id, (await db.get(id as GenericId<Watched>)) as Doc | null, null);
    },
    async delete(...args: unknown[]) {
      const { id } = split(args);
      const table = tableOf(db, id);
      // Read before it goes: the workspace, and the access row's note, are on the row.
      const before = table === null ? null : ((await db.get(id as GenericId<Watched>)) as Doc | null);
      await accessBefore(id, null);
      await (db.delete as (...a: unknown[]) => Promise<void>)(...args);
      if (table !== null) record(changes, table, id, before, null);
    },
    // `db.table(name)`'s writers go through the same four, so its shape is no way around them.
    table(name: string) {
      const inner = (db as unknown as { table: (name: string) => object }).table(name);
      const self = watched as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return Object.assign(Object.create(inner), {
        insert: (value: unknown) => self.insert(name, value),
        patch: (id: string, value: unknown) => self.patch(name, id, value),
        replace: (id: string, value: unknown) => self.replace(name, id, value),
        delete: (id: string) => self.delete(name, id),
      });
    },
  });
  return { db: watched, changes, accessWrites };
}
