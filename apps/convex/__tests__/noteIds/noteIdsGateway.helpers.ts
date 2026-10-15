/**
 * The id-copy gateway routes' harness (`POST /gateway/note-ids/lookup` and
 * `POST /gateway/note-ids/wrote`): one workspace whose tree is served, the
 * grants each route is asked with, and rows that carry note ids and copies.
 *
 * The tree is proved served the same way `__tests__/nodes/gatewayFacts.test.ts`
 * proves it, so the lookup's privacy filter runs over the real mirror.
 */

import type { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { setupTest } from "../fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";

export type T = ReturnType<typeof convexTest>;

export const OWNER = token("ids_owner");
export const MEMBER = token("ids_member");
export const EDITOR = token("ids_editor");
export const OUTSIDER = token("ids_outsider");
const CLIENT = "mcp_client_note_ids";

/** `1-projects/` is team, `1-projects/secret/` private: a team reader is not shown the secret note's copy. */
const RULES = {
  etag: "privacy-ids-1",
  invalid: false,
  folders: [
    { prefix: "1-projects/", visibility: "team" },
    { prefix: "1-projects/secret/", visibility: "private" },
  ],
  notes: [],
};

export const PLAN = "1-projects/plan.md";
export const SECRET = "1-projects/secret/codes.md";
export const PICTURE = "1-projects/pic.PNG";
export const STALE = "1-projects/stale.md";
export const NO_COPY = "1-projects/nocopy.md";
export const GONE = "1-projects/gone.md";
export const ORPHAN = "1-projects/orphan.md";
export const MISSING = "1-projects/never-existed.md";

export const NOTE_IDS = {
  plan: "0190c0de-0000-7000-8000-00000000a001",
  secret: "0190c0de-0000-7000-8000-00000000a002",
  picture: "0190c0de-0000-7000-8000-00000000a003",
  stale: "0190c0de-0000-7000-8000-00000000a004",
  noCopy: "0190c0de-0000-7000-8000-00000000a005",
  gone: "0190c0de-0000-7000-8000-00000000a006",
} as const;

const PATHS = [PLAN, SECRET, PICTURE, STALE, NO_COPY, GONE, ORPHAN];

export interface Fixture {
  t: T;
  ws: Id<"workspaces">;
  other: Id<"workspaces">;
}

async function observe(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId,
    at: 10,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: path.length, uploaded: 1_000 })),
    gone: [],
    vanishedUnder: [],
  });
}

async function proved(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await observe(t, workspaceId, paths);
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId, mirror: RULES, at: 10 });
  await t.mutation(internal.functions.nodes.begin, { workspaceId, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId, at: 20, files: paths.length });
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId,
    parity: { checkedAt: 30, clearances: 2, mismatches: 0, privacyMatches: true },
  });
}

/**
 * Two workspaces. In `ws` an owner (private clearance), a member and an editor
 * (team clearance, the editor with write). In `other` an outsider who is its
 * owner and nothing of `ws`'s.
 */
export async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const ownerId = await user("ids-owner@example.test");
    const memberId = await user("ids-member@example.test");
    const editorId = await user("ids-editor@example.test");
    const outsiderId = await user("ids-outsider@example.test");
    const workspace = (slug: string, createdBy: Id<"users">) =>
      ctx.db.insert("workspaces", {
        slug,
        displayName: slug,
        createdBy,
        kind: "shared",
        structureTemplate: "para",
        createdAt: now,
        updatedAt: now,
      });
    const ws = await workspace("ids-acme", ownerId);
    const other = await workspace("ids-other", outsiderId);
    const member = (workspaceId: Id<"workspaces">, userId: Id<"users">, role: "owner" | "editor" | "member") =>
      ctx.db.insert("workspaceMembers", { workspaceId, userId, role, joinedAt: now });
    await member(ws, ownerId, "owner");
    await member(ws, memberId, "member");
    await member(ws, editorId, "editor");
    await member(other, outsiderId, "owner");
    return { ws, other, ownerId, memberId, editorId, outsiderId };
  });
  await proved(t, ids.ws, PATHS);
  await proved(t, ids.other, ["privacy.md", "1-projects/theirs.md"]);
  await registerClient(t, CLIENT);
  const grant = (accessToken: string, userId: Id<"users">, workspaceId: Id<"workspaces">, scopes: string[]) =>
    seedConnectedClient(t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(OWNER, ids.ownerId, ids.ws, ["context:read", "context:write", "context:private"]);
  await grant(MEMBER, ids.memberId, ids.ws, ["context:read", "context:write"]);
  await grant(EDITOR, ids.editorId, ids.ws, ["context:read", "context:write"]);
  await grant(OUTSIDER, ids.outsiderId, ids.other, ["context:read", "context:write", "context:private"]);
  return { t, ws: ids.ws, other: ids.other };
}

/** Patch the row at `path` in place (the tree assigned its id on insert; these tests pin it). */
export async function patchRow(t: T, workspaceId: Id<"workspaces">, path: string, fields: Record<string, unknown>) {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique();
    if (row === null) throw new Error("fixture row missing");
    await ctx.db.patch(row._id, fields as never);
  });
}

export async function rowOf(t: T, workspaceId: Id<"workspaces">, path: string) {
  return await t.run((ctx) =>
    ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
      .unique(),
  );
}

/**
 * The rows the lookup is asked about, in a known state:
 *  - PLAN: a copy made from its current etag (fresh);
 *  - STALE: a copy made from an older etag (not fresh);
 *  - NO_COPY: an id and no copy;
 *  - GONE: trashed (`goneAt`), with a copy that must not be answered;
 *  - ORPHAN: no id yet;
 *  - SECRET: a copy at a private folder, fresh;
 *  - PICTURE: a fresh copy under files/ with its lowercased extension.
 * MISSING has no row at all.
 */
export async function seedCopies(f: Fixture): Promise<void> {
  const etagOf = async (path: string) => (await rowOf(f.t, f.ws, path))!.etag!;
  await patchRow(f.t, f.ws, PLAN, {
    noteId: NOTE_IDS.plan,
    idCopy: { key: `notes/${NOTE_IDS.plan}.md`, etag: await etagOf(PLAN), copiedAt: 1 },
  });
  await patchRow(f.t, f.ws, SECRET, {
    noteId: NOTE_IDS.secret,
    idCopy: { key: `notes/${NOTE_IDS.secret}.md`, etag: await etagOf(SECRET), copiedAt: 1 },
  });
  await patchRow(f.t, f.ws, PICTURE, {
    noteId: NOTE_IDS.picture,
    idCopy: { key: `files/${NOTE_IDS.picture}.png`, etag: await etagOf(PICTURE), copiedAt: 1 },
  });
  await patchRow(f.t, f.ws, STALE, {
    noteId: NOTE_IDS.stale,
    idCopy: { key: `notes/${NOTE_IDS.stale}.md`, etag: "an-older-etag", copiedAt: 1 },
  });
  await patchRow(f.t, f.ws, NO_COPY, { noteId: NOTE_IDS.noCopy });
  await patchRow(f.t, f.ws, GONE, {
    noteId: NOTE_IDS.gone,
    goneAt: 5,
    idCopy: { key: `notes/${NOTE_IDS.gone}.md`, etag: await etagOf(GONE), copiedAt: 1 },
  });
  await patchRow(f.t, f.ws, ORPHAN, { noteId: undefined });
}
