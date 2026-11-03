/** Shared fixtures for the object access mirror tests (`objectAccessMirror*.test.ts`). */
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { nodeAt } from "../functions/lib/nodes/paths";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { parentRows } from "./nodes/treeRows.helpers";


export type T = ReturnType<typeof makeTest>;
export const makeTest = () => convexTest(schema, modules);

export const PLAN = "1-projects/plan.md";
export const GROUP_VIEW = "1-projects/group.md";

export interface World {
  t: T;
  ws: Id<"workspaces">;
  other: Id<"workspaces">;
  owner: Id<"users">;
  leads: Id<"workspaceGroups">;
}

/** A shared workspace with an owner, a group, and two notes under `1-projects`, and no access state yet. */
export async function world(): Promise<World> {
  const t = makeTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const owner = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const shared = (slug: string) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy: owner,
        kind: "shared",
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await shared("acme");
    const other = await shared("beta");
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: owner, role: "owner", joinedAt: now });
    const leads = await ctx.db.insert("workspaceGroups", { workspaceId: ws, name: "acme-leads", createdBy: owner, createdAt: now });
    for (const path of ["1-projects", PLAN, GROUP_VIEW]) {
      await ctx.db.insert("nodes", {
        workspaceId: ws,
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: path.endsWith(".md") ? "file" : "folder",
        observedAt: 1,
      });
    }
    await parentRows(ctx, ws);
    return { ws, other, owner, leads };
  });
  return { t, ...ids };
}

export const rowOf = (t: T, ws: Id<"workspaces">, path: string) => t.run((ctx) => nodeAt(ctx.db, ws, path));

export async function rowIdOf(t: T, ws: Id<"workspaces">, path: string): Promise<string> {
  const row = await rowOf(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return row._id;
}

export async function stateOf(t: T, ws: Id<"workspaces">) {
  return await t.run(async (ctx) =>
    await ctx.db
      .query("nodeAccessState")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
      .unique(),
  );
}

export async function grantsOn(t: T, ws: Id<"workspaces">, path: string) {
  const row = await rowOf(t, ws, path);
  if (row === null) throw new Error(`no row at ${path}`);
  return await t.run(async (ctx) =>
    await ctx.db
      .query("nodeAccess")
      .withIndex("by_node", (q) => q.eq("nodeId", row._id))
      .collect(),
  );
}

export const auditOf = (t: T, action: string) => t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((event) => event.action === action));
export const outbox = (t: T) => t.run(async (ctx) => await ctx.db.query("workspaceObjectOutbox").collect());

/** The object's copy of the workspace is at `version`: Convex holds the same access state the object does. */
export async function seedState(t: T, ws: Id<"workspaces">, version: number) {
  await t.run((ctx) => ctx.db.insert("nodeAccessState", { workspaceId: ws, version, orphans: [], pending: [] }));
}

/** Marks `ws` as an object-home workspace, as the flip does (after the setup writes, which are not the mirror's). */
export async function objectHome(t: T, ws: Id<"workspaces">) {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId: ws, home: "object", since: 0 }));
}

export type AccessRecord = {
  rowId: string;
  noteId: string | null;
  path: string;
  kind: "file" | "folder";
  base: "private" | "team" | null;
  grantees: { kind: "user" | "group" | "email" | "members" | "accounts"; id: string; role: "view" | "edit" }[];
  baseChanged: boolean;
  listChanged: boolean;
  added: AccessRecord["grantees"];
  removed: AccessRecord["grantees"];
  baseVersion: number;
  version: number;
  actorUserId?: string;
  clientId?: string;
};

export type Grantee = AccessRecord["grantees"][number];

/** A record the object would send for `PLAN` (`accessWrite.js` `change.record`). */
export function recordFor(rowId: string, extra: Partial<AccessRecord> = {}): AccessRecord {
  const grantees = extra.grantees ?? [];
  return {
    rowId,
    noteId: null,
    path: PLAN,
    kind: "file",
    base: "private",
    grantees,
    baseChanged: true,
    // A list named here is the object's change: every grantee in it added (`accessWrite.js` `added`).
    listChanged: extra.grantees !== undefined,
    added: grantees,
    removed: [],
    baseVersion: 3,
    version: 4,
    ...extra,
  };
}
