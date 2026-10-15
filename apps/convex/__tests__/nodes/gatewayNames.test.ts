/**
 * `POST /gateway/tree/facts` with `ask: "names"`
 * (`functions/lib/nodes/gatewayNames.ts`): which names a gateway write would
 * land on, and how many notes there are, asked of the tree instead of the
 * bucket (step 3 of the convex-only plan).
 *
 * What is proved:
 *  - the answer is unfiltered (a private note's name is taken), so only a
 *    grant that may write here may ask: `owner` or `editor`, with
 *    `context:write`; every other caller gets `{ served: false }`;
 *  - names are drawn through pending moves, as every listing draws them;
 *  - the count counts notes only;
 *  - a bound workspace still on its first copy says `loading`, never "free".
 *
 * Sabotage (temporary local edits, reverted):
 *  - dropping the role check in `writableWorkspace`: the member is answered;
 *  - dropping the `context:write` check: the read-only grant is answered;
 *  - `treeTaken` ignoring pending moves: the moved-name case calls the old
 *    name taken and the new one free;
 *  - `namesFor` answering `NOT_SERVED` for a loading tree: the loading case
 *    loses `loading: true`.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { isNoteKey } from "../../functions/lib/noteCount";
import { gatewayPost, seedStorageBinding } from "../fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";

type T = ReturnType<typeof convexTest>;

const OWNER = token("names_owner");
const EDITOR = token("names_editor");
const MEMBER = token("names_member");
const READER = token("names_reader");
const OTHER = token("names_other");
const CLIENT = "mcp_client_names";

const RULES = {
  etag: "privacy-1",
  invalid: false,
  folders: [
    { prefix: "1-projects/", visibility: "team" },
    { prefix: "1-projects/secret/", visibility: "private" },
  ],
  notes: [],
};

const PATHS = ["privacy.md", "index.md", "1-projects/plan.md", "1-projects/secret/codes.md", "2-areas/photo.png"];

async function proved(t: T, workspaceId: Id<"workspaces">, paths: string[]) {
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId,
    at: 10,
    rows: paths.map((path) => ({ path, etag: `e-${path}`, size: path.length, uploaded: 1_000 })),
    gone: [],
    vanishedUnder: [],
  });
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId, mirror: RULES, at: 10 });
  await t.mutation(internal.functions.nodes.begin, { workspaceId, at: 5 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId, at: 20, files: paths.length });
  await t.mutation(internal.functions.nodes.saveParity, {
    workspaceId,
    parity: { checkedAt: 30, clearances: 2, mismatches: 0, privacyMatches: true },
  });
}

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const user = (email: string) => ctx.db.insert("users", { email, emailVerificationTime: now } as never);
    const ownerId = await user("owner@example.test");
    const editorId = await user("editor@example.test");
    const memberId = await user("member@example.test");
    const outsiderId = await user("outsider@example.test");
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
    const ws = await workspace("acme", ownerId);
    const other = await workspace("other", outsiderId);
    const fresh = await workspace("fresh", ownerId);
    const member = (workspaceId: Id<"workspaces">, userId: Id<"users">, role: "owner" | "editor" | "member") =>
      ctx.db.insert("workspaceMembers", { workspaceId, userId, role, joinedAt: now });
    await member(ws, ownerId, "owner");
    await member(ws, editorId, "editor");
    await member(ws, memberId, "member");
    await member(other, outsiderId, "owner");
    await member(fresh, ownerId, "owner");
    return { ws, other, fresh, ownerId, editorId, memberId, outsiderId };
  });
  await proved(t, ids.ws, PATHS);
  await proved(t, ids.other, ["privacy.md", "1-projects/theirs.md"]);
  await registerClient(t, CLIENT);
  const grant = (accessToken: string, userId: Id<"users">, workspaceId: Id<"workspaces">, scopes: string[]) =>
    seedConnectedClient(t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(OWNER, ids.ownerId, ids.ws, ["context:read", "context:write", "context:private"]);
  await grant(EDITOR, ids.editorId, ids.ws, ["context:read", "context:write"]);
  await grant(MEMBER, ids.memberId, ids.ws, ["context:read", "context:write"]);
  await grant(READER, ids.ownerId, ids.ws, ["context:read", "context:private"]);
  await grant(OTHER, ids.outsiderId, ids.other, ["context:read", "context:write", "context:private"]);
  return { t, ...ids };
}

async function names(t: T, body: Record<string, unknown>) {
  const response = await gatewayPost(t, "/gateway/tree/facts", { ask: "names", ...body });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

const ASKED = ["1-projects/plan.md", "1-projects/secret/codes.md", "1-projects/secret", "1-projects/free.md", "2-areas"];

describe("POST /gateway/tree/facts, ask: names", () => {
  test("a writer is told every name that is taken, including one it may not see", async () => {
    const { t, ws } = await fixture();
    for (const accessToken of [OWNER, EDITOR]) {
      expect(await names(t, { accessToken, expectedWorkspaceId: ws, paths: ASKED })).toEqual({
        served: true,
        files: ["1-projects/plan.md", "1-projects/secret/codes.md"],
        folders: ["1-projects/secret", "2-areas"],
      });
    }
  });

  test("anyone who may not write here is answered as a tree that does not serve", async () => {
    const { t, ws, other } = await fixture();
    for (const body of [
      { accessToken: MEMBER, expectedWorkspaceId: ws, paths: ASKED },
      { accessToken: READER, expectedWorkspaceId: ws, paths: ASKED },
      { accessToken: OTHER, expectedWorkspaceId: ws, paths: ASKED },
      { accessToken: OWNER, expectedWorkspaceId: other, paths: ["1-projects/theirs.md"] },
      { accessToken: token("names_unknown"), expectedWorkspaceId: ws, paths: ASKED },
      { accessToken: OWNER, expectedWorkspaceId: ws },
      { accessToken: OWNER, expectedWorkspaceId: ws, paths: Array.from({ length: 101 }, (_, i) => `n${i}.md`) },
      { accessToken: OWNER, expectedWorkspaceId: ws, paths: [""] },
    ]) {
      expect(await names(t, body), JSON.stringify(body)).toEqual({ served: false });
    }
  });

  test("a name a pending move is carrying is drawn where the move puts it", async () => {
    const { t, ws } = await fixture();
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("moveQueue", {
        workspaceId: ws,
        from: "1-projects/plan.md",
        to: "3-resources/plan.md",
        kind: "file",
        state: "moving",
        scope: "private",
        grantedNames: [],
        total: 1,
        moved: 0,
        added: { folders: [], notes: [] },
        attempts: 0,
        nextAt: now + 60_000,
        createdAt: now,
        updatedAt: now,
      });
    });
    expect(
      await names(t, { accessToken: OWNER, expectedWorkspaceId: ws, paths: ["1-projects/plan.md", "3-resources/plan.md", "3-resources"] }),
    ).toEqual({ served: true, files: ["3-resources/plan.md"], folders: ["3-resources"] });
  });

  test("the count counts notes, for the free plan's cap", async () => {
    const { t, ws } = await fixture();
    const answer = await names(t, { accessToken: OWNER, expectedWorkspaceId: ws, count: true });
    // The photo is not a note; whatever `isNoteKey` calls one is.
    expect(answer).toEqual({ served: true, files: [], folders: [], notes: PATHS.filter(isNoteKey).length });
    expect(PATHS.filter(isNoteKey)).not.toContain("2-areas/photo.png");
  });

  test("a bound workspace still on its first copy says it is loading, never that a name is free", async () => {
    const { t, fresh, ownerId } = await fixture();
    await seedStorageBinding(t, { workspaceId: fresh, boundBy: ownerId, status: "connected" });
    await seedConnectedClient(t, {
      workspaceId: fresh,
      userId: ownerId,
      clientId: CLIENT,
      accessToken: token("names_fresh"),
      scopes: ["context:read", "context:write", "context:private"],
    });
    expect(await names(t, { accessToken: token("names_fresh"), expectedWorkspaceId: fresh, paths: ["1-projects/x.md"] })).toEqual({
      served: false,
      loading: true,
    });
  });
});
