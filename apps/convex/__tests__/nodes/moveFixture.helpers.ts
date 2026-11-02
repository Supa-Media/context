/**
 * A served workspace and an in-memory R2 for the queued-move tests (phase 4
 * of `docs/decisions/app-and-console/convex-tree.md`): the real Convex
 * functions through `convex-test`, an owner and a member, and a tree seeded
 * from its bucket so it serves.
 */

import { expect } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { clearanceOf } from "../../functions/lib/clearance";
import type { FileStore } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { startRowMove } from "../../functions/lib/nodes/rowMoveStart";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { renderPrivacyManifest, setFolderVisibility, translateSeededRules } from "../seededRules.helpers";
import { pathObjectsOf, seedTreeRows } from "../fixtures.helpers";
import { withSession } from "../session.helpers";

export type T = ReturnType<typeof convexTest>;
export type Store = MemoryStore & FileStore;

export const OWNER = clearanceOf("private");
export const TEAM = clearanceOf("team");
export const ADMIN = "staff@example.test";

/** An action context that runs the real functions through `convex-test`; the scheduler records only. */
export type Call = (ref: unknown, args: unknown) => Promise<unknown>;

export function bridge(t: T): ActionCtx {
  return {
    runQuery: t.query as unknown as Call,
    runMutation: t.mutation as unknown as Call,
    runAction: async () => null,
    scheduler: { runAfter: async () => "job", runAt: async () => "job" },
  } as unknown as ActionCtx;
}

/** R2 as measured by default; `s3` honours `If-Match` on DELETE, as production stores do behind their marker layer. */
export async function bucket(kind: "r2" | "s3" = "r2"): Promise<Store> {
  const store = memoryStore({ conditional: true, ignoreIfMatchOnDelete: kind === "r2" }) as Store;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/launch/brief.md", "# Brief\n");
  store.seed("1-projects/launch/plan.md", "# Plan\n\nSee [the brief](brief.md).\n");
  store.seed("1-projects/launch/pic.png", "png");
  store.seed("1-projects/launch/sub/deep.md", "# Deep\n");
  store.seed("1-projects/secret/codes.md", "# Codes\n");
  store.seed("1-projects/keep.md", "# Keep\n");
  store.seed("3-resources/r.md", "# R\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/secret", visibility: "private", clearance: OWNER });
  return store;
}

export async function fixture(kind: "r2" | "s3" = "r2") {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const ownerId = await user("owner@example.test");
    const memberId = await user("member@example.test");
    const staffId = await user(ADMIN);
    const ws = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "Acme",
      createdBy: ownerId,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: ownerId, role: "owner", joinedAt: now });
    await ctx.db.insert("workspaceMembers", { workspaceId: ws, userId: memberId, role: "member", joinedAt: now });
    return { ws, ownerId, memberId, staffId };
  });
  const store = await bucket(kind);
  const ctx = bridge(t);
  // The tree's rows are written by the product's seam for each object in the bucket, served as a finished copy would leave them.
  await seedTreeRows(t, ids.ws, pathObjectsOf(store));
  // The seeded rules become rows. The store keeps its copy: the store-level suites here read the rules from it.
  await translateSeededRules(t, ids.ws, {
    text: async () => (await store.get(PRIVACY_KEY))?.text() ?? null,
    remove: async () => {},
  });
  return {
    t,
    ctx,
    store,
    ws: ids.ws,
    ownerId: ids.ownerId,
    memberId: ids.memberId,
    owner: withSession(t, ids.ownerId),
    member: withSession(t, ids.memberId),
    staff: withSession(t, ids.staffId),
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;

export async function listed(who: Fixture["owner"], ws: Id<"workspaces">, path: string): Promise<string[]> {
  const listing = await who.query(api.functions.nodesListing.listFolder, { workspaceId: ws, path });
  expect(listing).not.toBeNull();
  return listing!.entries.map((entry: { path: string }) => entry.path).sort();
}

/** A keyed folder or note move: a row change, answered in the call (there is no queue to wait on). */
export const start = (f: Fixture, from: string, to: string, clearance = OWNER) =>
  startRowMove(f.ctx, { workspaceId: f.ws, store: f.store, from, to, clearance, now: Date.now() });

/** Kept for callers written when moves queued: keyed moves finish inside `start`, so there is nothing to drain. */
export async function drain(_f: Fixture): Promise<void> {}

export const bucketKeys = (store: Store) => Object.keys(store.snapshot()).filter((key) => !key.startsWith(".")).sort();
