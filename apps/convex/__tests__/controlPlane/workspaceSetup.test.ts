/**
 * `/gateway/workspaces/*` — SETTING A WORKSPACE UP THROUGH AN AGENT, AS THE
 * PERSON AND NEVER AS ANYONE ELSE (Dev2, 2026-10-17;
 * `docs/decisions/gateway-protocol/workspace-setup.md`).
 *
 * What is proved here:
 *
 *  1. A grant without `context:write` sets nothing up: no workspace, no layout,
 *     no link, and the same bare `null` as a token that resolves to nothing.
 *  2. One tenant cannot create, check a name, lay out or connect through a
 *     workspace that is another's: `expectedWorkspaceId` only selects inside
 *     the grant's own reach.
 *  3. The workspace an agent creates is owned by the grant's person, whatever
 *     the body says, is shared, and has no other member.
 *  4. The name rules and the reserved words are the app's, because the handler
 *     is the app's.
 *  5. A non-owner cannot choose the layout of a workspace they are in, and a
 *     stranger cannot touch one they are not in.
 *  6. Google is offered only to the owner of a personal workspace, as a page
 *     in the app (never an authorize URL), and only where it is switched on.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `clear` skipping the `context:write` check                       3
 *   `clear` acting on a workspace outside the grant's reach           3
 *   the layout route skipping its owner check                         0
 *     (the handler's own `requireWorkspaceRole` still refuses: the
 *     route's check is the courtesy, the handler's the control)
 *   ...and `applyStructureHandler` asking only for a member, too      1
 *   connect-google skipping the personal-workspace check              1
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { createWorkspace, gatewayPost } from "../fixtures.helpers";
import { fixture } from "../files/fixtures.helpers";
import { MANAGED_R2_ACCOUNT_ID_ENV_VAR } from "../../functions/lib/managedStorage";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

// Every test builds a whole bucket-backed workspace first; the first is a cold start.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CLIENT = "mcp_client_setup";
const OWNER = token("setup_owner");
const OWNER_READONLY = token("setup_owner_ro");
const EDITOR = token("setup_editor");
const STRANGER = token("setup_stranger");
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
  const workspaceCount = () => f.t.run(async (ctx) => (await ctx.db.query("workspaces").collect()).length);
  return { ...f, strangerHome, workspaceCount };
}

/** Whether the Convex tree holds a live row at `path` (bytes are kept by note id, names are rows). */
async function aboutInTree(w: Awaited<ReturnType<typeof world>>, path: string): Promise<boolean> {
  const rows = await w.t.run((ctx) =>
    ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.workspaceId).eq("path", path))
      .collect(),
  );
  return rows.some((row) => row.goneAt === undefined);
}

const post = async (t: Awaited<ReturnType<typeof world>>["t"], path: string, body: Record<string, unknown>) =>
  bodyOf(await gatewayPost(t, path, body));

describe("/gateway/workspaces/create", () => {
  test("creates a shared workspace owned by the grant's person alone", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/create", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      slug: "Acme-Studio",
      name: "Acme Studio",
      // Ignored: the person is read off the grant, never the body.
      actorUserId: w.stranger,
    });
    expect(body.workspace).toEqual({ ok: true, slug: "acme-studio", storage: "none" });
    const { row, members, audit } = await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", "acme-studio"))
        .unique())!;
      const members = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", row._id))
        .collect();
      const audit = await ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", row._id))
        .collect();
      return { row, members, audit };
    });
    expect(row.kind).toBe("shared");
    expect(row.createdBy).toBe(w.owner);
    expect(members.map((m) => [m.userId, m.role])).toEqual([[w.owner, "owner"]]);
    expect(audit.map((a) => [a.action, a.actorUserId, a.actorClientId])).toEqual([
      ["workspace.created", w.owner, CLIENT],
    ]);
  });

  test("starts the free bucket Context runs where this deployment offers one", async () => {
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, "0123456789abcdef0123456789abcdef");
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/create", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      slug: "acme-free",
      name: "Acme",
    });
    expect(body.workspace).toEqual({ ok: true, slug: "acme-free", storage: "starting" });
    const plan = await w.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("workspaces")
        .withIndex("by_slug", (q) => q.eq("slug", "acme-free"))
        .unique())!;
      return await ctx.db
        .query("workspacePlans")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", row._id))
        .unique();
    });
    expect(plan?.freeManaged).toBe(true);
  });

  test("a grant without context:write creates nothing and is told nothing", async () => {
    const w = await world();
    const before = await w.workspaceCount();
    for (const dryRun of [false, true]) {
      const body = await post(w.t, "/gateway/workspaces/create", {
        accessToken: OWNER_READONLY,
        expectedWorkspaceId: w.workspaceId,
        slug: "readonly-made",
        name: "Nope",
        dryRun,
      });
      expect(body.workspace).toBeNull();
    }
    expect(await w.workspaceCount()).toBe(before);
  });

  test("one tenant cannot create or check names through another's workspace", async () => {
    const w = await world();
    const before = await w.workspaceCount();
    for (const dryRun of [false, true]) {
      const body = await post(w.t, "/gateway/workspaces/create", {
        accessToken: STRANGER,
        expectedWorkspaceId: w.workspaceId,
        slug: "hijack",
        name: "Hijack",
        dryRun,
      });
      expect(body.workspace).toBeNull();
    }
    const unknownToken = await post(w.t, "/gateway/workspaces/create", {
      accessToken: token("setup_nobody"),
      expectedWorkspaceId: w.workspaceId,
      slug: "hijack",
      name: "Hijack",
    });
    expect(unknownToken.workspace).toBeNull();
    expect(await w.workspaceCount()).toBe(before);
  });

  test("a dry run says whether a name is free and claims nothing", async () => {
    const w = await world();
    const before = await w.workspaceCount();
    const check = async (slug: string) =>
      (
        await post(w.t, "/gateway/workspaces/create", {
          accessToken: OWNER,
          expectedWorkspaceId: w.workspaceId,
          slug,
          dryRun: true,
        })
      ).workspace as { available: boolean; normalized: string; message?: string };
    expect(await check("Fresh-Name")).toMatchObject({ available: true, normalized: "fresh-name" });
    expect(await check("atlas")).toMatchObject({ available: false });
    expect(await check("brain")).toMatchObject({ available: false });
    expect(await check("workspace")).toMatchObject({ available: false });
    expect((await check("x")).message).toEqual(expect.any(String));
    expect(await w.workspaceCount()).toBe(before);
  });

  test("the app's name rules refuse a reserved, taken or malformed name with its sentence", async () => {
    const w = await world();
    const before = await w.workspaceCount();
    for (const slug of ["context", "brain", "atlas", "x", "no spaces here"]) {
      const body = await post(w.t, "/gateway/workspaces/create", {
        accessToken: OWNER,
        expectedWorkspaceId: w.workspaceId,
        slug,
        name: "Anything",
      });
      expect(body.workspace).toMatchObject({ ok: false, message: expect.any(String) });
    }
    expect(await w.workspaceCount()).toBe(before);
  });
});

describe("/gateway/workspaces/layout", () => {
  test("an owner lays out a business workspace: the five plus clients and teams", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/layout", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      template: "business",
    });
    expect(body.layout).toEqual({
      ok: true,
      queued: true,
      folders: ["0-inbox", "1-projects", "2-areas", "3-resources", "4-clients", "5-teams", "9-archive"],
    });
    const row = await w.t.run((ctx) => ctx.db.get(w.workspaceId));
    expect(row?.structureTemplate).toBe("custom");
  });

  test("an editor cannot choose the layout, and nothing is queued", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/layout", {
      accessToken: EDITOR,
      expectedWorkspaceId: w.workspaceId,
      template: "para",
    });
    expect(body.layout).toMatchObject({ ok: false, message: expect.stringMatching(/owner/i) });
    const binding = await w.t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", w.workspaceId))
        .unique(),
    );
    expect(binding?.scaffoldQueuedAt).toBeUndefined();
  });

  test("a stranger, or a grant without context:write, gets the bare null", async () => {
    const w = await world();
    for (const accessToken of [STRANGER, OWNER_READONLY]) {
      for (const ask of [{ template: "para" }, { role: "clients" }]) {
        const body = await post(w.t, "/gateway/workspaces/layout", {
          accessToken,
          expectedWorkspaceId: w.workspaceId,
          ...ask,
        });
        expect(body.layout).toBeNull();
      }
    }
    const binding = await w.t.run((ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", w.workspaceId))
        .unique(),
    );
    expect(binding?.scaffoldQueuedAt).toBeUndefined();
    expect(await aboutInTree(w, "4-clients/about.md")).toBe(false);
  });

  test("an editor of a private personal workspace is refused a root folder it could not see, as in the app", async () => {
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/layout", {
      accessToken: EDITOR,
      expectedWorkspaceId: w.workspaceId,
      role: "clients",
    });
    expect(body.layout).toMatchObject({ ok: false });
    expect(await aboutInTree(w, "4-clients/about.md")).toBe(false);
  });

  test("an owner adds one built-in folder under its fixed name, once", async () => {
    const w = await world();
    const ask = { accessToken: OWNER, expectedWorkspaceId: w.workspaceId, role: "clients" };
    expect((await post(w.t, "/gateway/workspaces/layout", ask)).layout).toEqual({ ok: true, folders: ["4-clients"] });
    expect(await aboutInTree(w, "4-clients/about.md")).toBe(true);
    expect((await post(w.t, "/gateway/workspaces/layout", ask)).layout).toMatchObject({
      ok: false,
      message: expect.stringMatching(/already/i),
    });
  });

  test("a body that names both, neither, or an unknown layout is refused", async () => {
    const w = await world();
    for (const ask of [{}, { template: "para", role: "clients" }, { template: "everything" }]) {
      const body = await post(w.t, "/gateway/workspaces/layout", {
        accessToken: OWNER,
        expectedWorkspaceId: w.workspaceId,
        ...ask,
      });
      expect(body.layout).toBeNull();
    }
  });
});

describe("/gateway/workspaces/connect-google", () => {
  test("the owner of a personal workspace gets the app's Connected apps page, never Google's URL", async () => {
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const w = await world();
    const body = await post(w.t, "/gateway/workspaces/connect-google", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      kind: "gmail",
    });
    expect(body.google).toEqual({
      ok: true,
      url: "https://app.context.invalid/console/@atlas?settings=integrations",
    });
  });

  test("not in a shared workspace, not for an editor, and not where it is switched off", async () => {
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const w = await world();
    const shared = await createWorkspace(w.t, w.owner, "atlas-team", { kind: "shared" });
    const SHARED = token("setup_shared");
    await seedConnectedClient(w.t, { workspaceId: shared, userId: w.owner, clientId: CLIENT, accessToken: SHARED, scopes: WRITE });
    for (const [accessToken, expectedWorkspaceId] of [
      [SHARED, shared],
      [EDITOR, w.workspaceId],
    ] as const) {
      const body = await post(w.t, "/gateway/workspaces/connect-google", { accessToken, expectedWorkspaceId, kind: "gmail" });
      expect(body.google).toMatchObject({ ok: false, message: expect.stringMatching(/personal/i) });
    }
    const off = await post(w.t, "/gateway/workspaces/connect-google", {
      accessToken: OWNER,
      expectedWorkspaceId: w.workspaceId,
      kind: "calendar",
    });
    expect(off.google).toMatchObject({ ok: false, message: expect.stringMatching(/not switched on/i) });
  });

  test("a stranger, or a grant without context:write, gets the bare null", async () => {
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const w = await world();
    for (const accessToken of [STRANGER, OWNER_READONLY]) {
      const body = await post(w.t, "/gateway/workspaces/connect-google", {
        accessToken,
        expectedWorkspaceId: w.workspaceId,
        kind: "gmail",
      });
      expect(body.google).toBeNull();
    }
  });
});
