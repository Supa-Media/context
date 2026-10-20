/**
 * `/gateway/workspaces/invite`, and `invitations` on `/gateway/workspaces/create`:
 * TEX INVITES PEOPLE INTO A SHARED WORKSPACE, AS ITS OWNER AND THROUGH THE
 * APP'S OWN HANDLER (the owner, 2026-10-20;
 * `docs/decisions/gateway-protocol/workspace-setup.md`).
 *
 * What is proved here:
 *
 *  1. A create with `invitations` makes the workspace and the invitations in
 *     one transaction, each audited with the agent's client; a refusal for one
 *     string makes nothing at all, workspace included.
 *  2. Inviting into an existing shared workspace needs its owner: an editor is
 *     refused in words, a read-only grant and a stranger get the bare `null`.
 *  3. A personal workspace is never opened to somebody else from an agent.
 *  4. The answer is the same whoever the strings name, as `inviteMember`'s
 *     `null` is: an agent's invite is not an existence oracle either.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   the invite route skipping its owner check                        0
 *     (`inviteMemberHandler`'s own `requireWorkspaceRole` still refuses:
 *     the route's check is the courtesy, the handler's the control)
 *   ...and the handler's owner check removed too                     1
 *   the invite route skipping its personal-workspace check           1
 *   `createShared` ignoring `invitations`                            2
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { addMember, createUser, gatewayPost } from "../fixtures.helpers";
import { fixture } from "../files/fixtures.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CLIENT = "mcp_client_invite";
const OWNER = token("invite_owner");
const OWNER_READONLY = token("invite_owner_ro");
const EDITOR = token("invite_editor");
const STRANGER = token("invite_stranger");
const WRITE = ["context:read", "context:write"];

async function world() {
  const f = await fixture();
  const strangerHome = await f.t.run(async (ctx) =>
    (await ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", "elsewhere"))
      .unique())!._id,
  );
  await registerClient(f.t, CLIENT);
  const grant = (accessToken: string, userId: Id<"users">, workspaceId: Id<"workspaces">, scopes = WRITE) =>
    seedConnectedClient(f.t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(OWNER, f.owner, f.workspaceId, [...WRITE, "context:private"]);
  await grant(OWNER_READONLY, f.owner, f.workspaceId, ["context:read"]);
  await grant(EDITOR, f.editor, f.workspaceId);
  await grant(STRANGER, f.stranger, strangerHome);
  return { ...f, strangerHome };
}

const post = async (t: Awaited<ReturnType<typeof world>>["t"], path: string, body: Record<string, unknown>) =>
  bodyOf(await gatewayPost(t, path, body));

async function workspaceBySlug(w: Awaited<ReturnType<typeof world>>, slug: string) {
  return await w.t.run(async (ctx) =>
    ctx.db
      .query("workspaces")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
  );
}

async function invitationsOf(w: Awaited<ReturnType<typeof world>>, workspaceId: Id<"workspaces">) {
  return await w.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("workspaceInvitations")
      .withIndex("by_workspace_status", (q) => q.eq("workspaceId", workspaceId).eq("status", "pending"))
      .collect();
    const audit = await ctx.db
      .query("auditEvents")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    return {
      rows: rows.map((row) => [row.invitee, row.role, row.invitedBy]),
      invited: audit.filter((a) => a.action === "member.invited").map((a) => [a.actorUserId, a.actorClientId]),
    };
  });
}

/** A shared workspace the owner made through the route, with nobody invited yet. */
async function sharedWorkspace(w: Awaited<ReturnType<typeof world>>, slug: string) {
  const made = await post(w.t, "/gateway/workspaces/create", {
    accessToken: OWNER,
    expectedWorkspaceId: w.workspaceId,
    slug,
    name: slug,
  });
  expect(made.workspace).toMatchObject({ ok: true, slug });
  return (await workspaceBySlug(w, slug))!._id;
}

describe("/gateway/workspaces/create with invitations", () => {
  test("makes the workspace and invites them in one go, audited with the agent's client", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/create", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      slug: "woodshop",
      name: "Woodshop",
      invitations: [
        { invitee: "ada@example.invalid", role: "editor" },
        { invitee: "@elsewhere", role: "member" },
      ],
    });
    expect(body.workspace).toEqual({ ok: true, slug: "woodshop", storage: "none", invited: 2 });
    const workspaceId = (await workspaceBySlug(w, "woodshop"))!._id;
    const { rows, invited } = await invitationsOf(w, workspaceId);
    expect(rows).toEqual([
      ["ada@example.invalid", "editor", w.owner],
      ["elsewhere", "member", w.owner],
    ]);
    expect(invited).toEqual([
      [w.owner, CLIENT],
      [w.owner, CLIENT],
    ]);
  });

  test("a refusal for one string makes nothing, the workspace included", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/create", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      slug: "half-made",
      name: "Half Made",
      invitations: [
        { invitee: "ada@example.invalid", role: "editor" },
        { invitee: "not a valid identifier!", role: "editor" },
      ],
    });
    expect(body.workspace).toMatchObject({ ok: false });
    expect(await workspaceBySlug(w, "half-made")).toBeNull();
  });

  test("an owner role, or anything that is not a list of invitations, is the bare null", async () => {
    const w = await world();
    for (const invitations of [[{ invitee: "ada@example.invalid", role: "owner" }], "ada@example.invalid", [{ role: "editor" }]]) {
      const body = await post(w.t, "/gateway/workspaces/create", {
        accessToken: OWNER,
        expectedWorkspaceId: w.workspaceId,
        slug: "shape-check",
        name: "Shape",
        invitations,
      });
      expect(body.workspace).toBeNull();
    }
    expect(await workspaceBySlug(w, "shape-check")).toBeNull();
  });
});

describe("/gateway/workspaces/invite", () => {
  test("the owner invites into a shared workspace, and the answer never says who exists", async () => {
    const w = await world();
    const workspaceId = await sharedWorkspace(w, "bookclub");
    await createUser(w.t, "real@example.invalid");
    const real = await post(w.t, "/gateway/workspaces/invite", {
      accessToken: OWNER,
      expectedWorkspaceId: workspaceId,
      invitations: [{ invitee: "real@example.invalid", role: "editor" }],
    });
    const nobody = await post(w.t, "/gateway/workspaces/invite", {
      accessToken: OWNER,
      expectedWorkspaceId: workspaceId,
      invitations: [{ invitee: "nobody@example.invalid", role: "editor" }],
    });
    expect(real).toEqual({ invite: { ok: true, invited: 1 } });
    expect(nobody).toEqual(real);
    const { rows, invited } = await invitationsOf(w, workspaceId);
    expect(rows.map(([invitee]) => invitee)).toEqual(["real@example.invalid", "nobody@example.invalid"]);
    expect(invited).toEqual([
      [w.owner, CLIENT],
      [w.owner, CLIENT],
    ]);
  });

  test("a personal workspace is never opened to somebody else from an agent", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/invite", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      invitations: [{ invitee: "ada@example.invalid", role: "editor" }],
    });
    expect(body.invite).toEqual({ ok: false, message: expect.stringMatching(/shared workspace/) });
    expect((await invitationsOf(w, w.workspaceId)).rows).toEqual([]);
  });

  test("only its owner invites: an editor is told so, a read-only grant and a stranger get null", async () => {
    const w = await world();
    const workspaceId = await sharedWorkspace(w, "studio-team");
    await addMember(w.t, workspaceId, w.editor, "editor", w.owner);
    const invitations = [{ invitee: "ada@example.invalid", role: "editor" }];

    const editor = await post(w.t, "/gateway/workspaces/invite", { accessToken: EDITOR, expectedWorkspaceId: workspaceId, invitations });
    expect(editor.invite).toEqual({ ok: false, message: expect.stringMatching(/owner/) });
    for (const accessToken of [OWNER_READONLY, STRANGER]) {
      const body = await post(w.t, "/gateway/workspaces/invite", { accessToken, expectedWorkspaceId: workspaceId, invitations });
      expect(body).toEqual({ invite: null });
    }
    expect((await invitationsOf(w, workspaceId)).rows).toEqual([]);
  });

  test("more than ten at once is refused in words, and nothing is sent", async () => {
    const w = await world();
    const workspaceId = await sharedWorkspace(w, "big-list");
    const invitations = Array.from({ length: 11 }, (_, i) => ({ invitee: `p${i}@example.invalid`, role: "member" }));
    const body = await post(w.t, "/gateway/workspaces/invite", { accessToken: OWNER, expectedWorkspaceId: workspaceId, invitations });
    expect(body.invite).toEqual({ ok: false, message: expect.stringMatching(/at most 10/) });
    expect((await invitationsOf(w, workspaceId)).rows).toEqual([]);
  });
});
