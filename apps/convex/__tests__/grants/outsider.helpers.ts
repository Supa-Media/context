/**
 * Shared setup for the outsider read path (`functions/lib/grants/outsider.ts`,
 * `functions/lib/shares/grantedRead.ts`).
 *
 * An outsider is an account that is **not** a member of the workspace and holds
 * a grant on one of its rows, by account (`granteeKind: "user"`) or by a
 * confirmed address (`granteeKind: "email"`). The workspace "acme" is real end to
 * end: a bucket behind the credential barrier (`memoryS3`), its tree copied from
 * that bucket, and its rows in `rows` mode. "globex" has no bucket at all — its
 * tree is observed directly, because the only thing a test asks of it is which
 * grants reach whom.
 *
 * Fake values only: fixture addresses are `*.invalid`, and every note body
 * carries a marker string that could only have come from that note, so a leak
 * is a test failure rather than a coincidence.
 */

import { vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import {
  addMember,
  asUser,
  copyTree,
  createUser,
  createWorkspace,
  FAKE_STORAGE,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

export const PLAN = "1-projects/plan.md";
export const SECRET = "1-projects/private/secret.md";
export const HELD = "1-projects/held.md";
export const GONE = "1-projects/gone.md";
export const SALARIES = "2-areas/salaries.md";
/** Open to every member of the workspace, and inside a folder an outsider was granted. */
export const TEAM_NOTE = "1-projects/team-note.md";
export const TEAM_MARKER = "zzq-member-visible-body-marker-7c02";
export const PLAN_MARKER = "zzq-granted-plan-body-marker-7c02";
export const SECRET_MARKER = "zzq-private-subfolder-body-marker-7c02";
export const HELD_MARKER = "zzq-held-back-body-marker-7c02";
export const GONE_MARKER = "zzq-trashed-body-marker-7c02";
export const SALARIES_MARKER = "zzq-private-area-body-marker-7c02";

export interface World {
  t: TestConvex;
  owner: Id<"users">;
  /** Not a member of `ws`: the outsider every test grants to. */
  kola: Id<"users">;
  /** A member of `ws`. */
  bob: Id<"users">;
  /** A member of `ws` who is later removed (`outsiderRemoval.test.ts`). */
  mia: Id<"users">;
  /** Neither a member nor granted anything. */
  carol: Id<"users">;
  ownerB: Id<"users">;
  /** The workspace the outsider reads from. Shared, with a bucket and a tree. */
  ws: Id<"workspaces">;
  /** A second workspace, observed rows only (no bucket). */
  beta: Id<"workspaces">;
  backend: MemoryS3;
}

/** Insert a user the way sign-up leaves one, with no proof of the address. */
export async function unverifiedUser(t: TestConvex, email: string): Promise<Id<"users">> {
  return await t.run((ctx) => ctx.db.insert("users", { email, createdAt: Date.now() }));
}

/** Put a confirmed sign-in address on an account (`signInEmails`). */
export async function attachEmail(t: TestConvex, userId: Id<"users">, email: string): Promise<void> {
  await t.run((ctx) => ctx.db.insert("signInEmails", { userId, email, addedAt: Date.now() }));
}

export async function world(): Promise<World> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const kola = await createUser(t, "kola@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const mia = await createUser(t, "mia@example.invalid");
  const carol = await createUser(t, "carol@example.invalid");
  const ownerB = await createUser(t, "ownerb@example.invalid");

  const ws = await createWorkspace(t, owner, "acme", { kind: "shared", displayName: "Acme" });
  await addMember(t, ws, bob, "member", owner);
  await addMember(t, ws, mia, "member", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed("index.md", "# Context\n");
  backend.seed(PLAN, `# Plan\n\n${PLAN_MARKER}\n`);
  backend.seed(SECRET, `# Secret\n\n${SECRET_MARKER}\n`);
  backend.seed(HELD, `# Held\n\n${HELD_MARKER}\n`);
  backend.seed(GONE, `# Gone\n\n${GONE_MARKER}\n`);
  backend.seed(SALARIES, `# Salaries\n\n${SALARIES_MARKER}\n`);
  backend.seed(TEAM_NOTE, `# Team\n\n${TEAM_MARKER}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId: ws });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: ws,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  await copyTree(t, ws);
  // Production's shape: the access rows are the authority the engine judges notes by (`nodesPrivacy.heldFor`),
  // so a grant's token reaches `canSee` inside the bucket read. `files/memberEditRows.helpers.ts` does the same.
  await t.run(async (ctx) => {
    const migration = await ctx.db.query("nodeMigration").first();
    const flags = { accessSource: "rows" as const, privacyAuthority: true };
    if (migration === null) await ctx.db.insert("nodeMigration", { paused: false, updatedAt: 1, ...flags });
    else await ctx.db.patch(migration._id, flags);
    const privacy = await ctx.db
      .query("nodePrivacy")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", ws))
      .first();
    const authorityRow = { etag: "e1", invalid: false, folders: [], notes: [] };
    if (privacy === null) await ctx.db.insert("nodePrivacy", { workspaceId: ws, observedAt: 1, ...authorityRow });
    else await ctx.db.patch(privacy._id, authorityRow);
  });

  const beta = await createWorkspace(t, ownerB, "globex", { kind: "shared", displayName: "Globex" });
  await observeRows(t, beta, ["1-projects/", PLAN]);
  return { t, owner, kola, bob, mia, carol, ownerB, ws, beta, backend };
}

/** Rows for a workspace with no bucket: what `observe`, `begin` and `finish` leave behind. */
async function observeRows(t: TestConvex, workspace: Id<"workspaces">, paths: string[]): Promise<void> {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId: workspace,
    at: 10,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: 1 })),
    gone: [],
    vanishedUnder: [],
  });
  await t.mutation(internal.functions.nodes.begin, { workspaceId: workspace, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId: workspace, at: 20, files: paths.length });
}

/** The node row at a path, from the tree. */
export async function nodeOf(w: World, path: string, workspace = w.ws): Promise<Doc<"nodes">> {
  return await w.t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspace).eq("path", path))
      .unique();
    if (row === null) throw new Error(`no row at ${path}`);
    return row;
  });
}

/** The stable id a grant names a row by (`rowAccess.ts`). */
export async function noteIdOf(w: World, path: string, workspace = w.ws): Promise<string> {
  const row = await nodeOf(w, path, workspace);
  return row.noteId ?? row._id;
}

/** Set a row's access list to exactly these account grants, with a `private` base. */
export async function setListFor(
  w: World,
  path: string,
  grantees: { kind: "user"; userId: Id<"users">; role: "view" | "edit" }[],
  workspace = w.ws,
): Promise<void> {
  const result = await w.t.run(async (ctx) =>
    await setAccessRow(ctx as unknown as MutationCtx, {
      workspaceId: workspace,
      path,
      base: "private",
      grantees,
      actor: { userId: w.owner, role: "owner" },
    }),
  );
  if (!result.ok) throw new Error(`setAccessRow refused: ${result.code}`);
}

/** Set a row's base and leave its list as it is: `team` is what the members can see. */
export async function setBase(w: World, path: string, base: "private" | "team", workspace = w.ws): Promise<void> {
  const result = await w.t.run(async (ctx) =>
    await setAccessRow(ctx as unknown as MutationCtx, {
      workspaceId: workspace,
      path,
      base,
      actor: { userId: w.owner, role: "owner" },
    }),
  );
  if (!result.ok) throw new Error(`setAccessRow refused: ${result.code}`);
}

/** Grant an account view of a row (a note, or a folder and its subtree). */
export async function grantUser(w: World, path: string, userId: Id<"users">, workspace = w.ws): Promise<void> {
  await setListFor(w, path, [{ kind: "user", userId, role: "view" }], workspace);
}

/** Name an address the owner typed: the public write, the one an outsider is named by. */
export async function grantEmail(w: World, path: string, email: string, workspace = w.ws): Promise<void> {
  const answer = await asUser(w.t, w.owner).mutation(api.functions.nodesAccess.setGrantees, {
    workspaceId: workspace,
    path,
    grantees: [{ email, role: "view" }] as never,
  });
  if (!answer.ok) throw new Error(`setGrantees refused: ${answer.code}`);
}

/** Take every grant on a row back. */
export async function revokeAll(w: World, path: string, workspace = w.ws): Promise<void> {
  await setListFor(w, path, [], workspace);
}

/** Trash a note through the same barrier the console uses. */
export async function trashNote(w: World, path: string, workspace = w.ws): Promise<void> {
  const node = await nodeOf(w, path, workspace);
  await w.t.action(internal.functions.files.runFileOperation, {
    workspaceId: workspace,
    scope: "private",
    operation: { kind: "trash", path, expectedEtag: node.etag as string },
  });
}

/** The outsider's read, addressed by the grant's stable id. */
export function readByNoteId(w: World, who: Id<"users">, noteId: string, workspace = w.ws) {
  return asUser(w.t, who).action(api.functions.shares.readGrantedNote, { workspaceId: workspace, noteId });
}

/** The outsider's read, addressed by a path under the grant. */
export function readByPath(w: World, who: Id<"users">, path: string, workspace = w.ws) {
  return asUser(w.t, who).action(api.functions.shares.readGrantedNote, { workspaceId: workspace, path });
}

export function listByPath(w: World, who: Id<"users">, path: string, workspace = w.ws) {
  return asUser(w.t, who).action(api.functions.shares.listGrantedFolder, { workspaceId: workspace, path });
}

/**
 * What a refusal looks like to the person who got it: its code and message,
 * serialised. Two refusals are "the same" exactly when these strings match.
 */
export function refusalOf(error: unknown): string {
  const data = (error as { data?: unknown } | undefined)?.data;
  return JSON.stringify(data ?? { thrown: String(error) });
}
