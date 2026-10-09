import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { isAdmitted } from "../functions/lib/waitlist";
import { normalizeDomain } from "../functions/lib/emailDomains";

/**
 * A SHARED WORKSPACE OPENED TO AN EMAIL DOMAIN (boards s3/s4).
 *
 * The owner adds a domain they sign in with; people with a confirmed address
 * there join when they open the workspace's link, with the role the owner
 * picked; everybody else is told exactly what they were told before — that
 * there is no such workspace. Personal mail services are never a domain, a
 * personal workspace is never opened, and dropping the address means leaving.
 */

afterEach(() => vi.unstubAllEnvs());

async function world(t: TestConvex) {
  const seyi = await createUser(t, "seyi@publicworship.org");
  const team = await createWorkspace(t, seyi, "pw", { kind: "shared" });
  return { seyi, team };
}

const add = (t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">, domain: string) =>
  asUser(t, userId).mutation(api.functions.workspaceDomains.addWorkspaceDomain, { workspaceId, domain });

const join = (t: TestConvex, userId: Id<"users">, slug: string) =>
  asUser(t, userId).mutation(api.functions.workspaceDomains.joinWithDomain, { slug });

async function membership(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspaceId).eq("userId", userId))
      .first(),
  );
}

describe("the owner's card", () => {
  test("adds a domain they sign in with; Can read by default; lists what else could be added", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("signInEmails", { userId: seyi, email: "seyi@gmail.com", addedAt: Date.now() });
    });
    await add(t, seyi, team, "@PublicWorship.org");
    const card = await asUser(t, seyi).query(api.functions.workspaceDomains.listWorkspaceDomains, {
      workspaceId: team,
    });
    expect(card.domains).toEqual([{ domain: "publicworship.org", role: "member", enabled: true, joined: 0 }]);
    expect(card.offer).toEqual([
      { domain: "publicworship.org", email: "seyi@publicworship.org", status: "added" },
      { domain: "gmail.com", email: "seyi@gmail.com", status: "personal" },
    ]);
  });

  test("refuses a domain the owner does not sign in with, a personal mail service, and a personal workspace", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    expect(errorCode(await captureError(() => add(t, seyi, team, "supa.media")))).toBe("NOT_YOUR_DOMAIN");
    const gmail = await createUser(t, "someone@gmail.com");
    const theirs = await createWorkspace(t, gmail, "gteam", { kind: "shared" });
    expect(errorCode(await captureError(() => add(t, gmail, theirs, "gmail.com")))).toBe("PERSONAL_DOMAIN");
    const own = await createWorkspace(t, seyi, "seyi", { kind: "personal" });
    expect(errorCode(await captureError(() => add(t, seyi, own, "publicworship.org")))).toBe("NOT_SHARED");
    expect(errorCode(await captureError(() => add(t, seyi, team, "not a domain")))).toBe("INVALID_DOMAIN");
  });

  test("only the owner manages domains", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    const editor = await createUser(t, "ed@publicworship.org");
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", { workspaceId: team, userId: editor, role: "editor", joinedAt: Date.now() }),
    );
    expect(await captureError(() => add(t, editor, team, "publicworship.org"))).toBeDefined();
    await add(t, seyi, team, "publicworship.org");
    expect(
      await captureError(() =>
        asUser(t, editor).mutation(api.functions.workspaceDomains.updateWorkspaceDomain, {
          workspaceId: team,
          domain: "publicworship.org",
          role: "editor",
        }),
      ),
    ).toBeDefined();
  });
});

describe("joining", () => {
  test("someone at the domain joins with the role picked, and is counted", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    const kayla = await createUser(t, "kayla@publicworship.org");
    expect(await asUser(t, kayla).query(api.functions.workspaceDomains.myDomainWorkspaces, {})).toEqual([
      { slug: "pw", name: "pw", domain: "publicworship.org" },
    ]);
    expect(await join(t, kayla, "@pw")).toEqual({ slug: "pw", name: "pw", domain: "publicworship.org", role: "member" });
    expect((await membership(t, team, kayla))?.role).toBe("member");
    expect((await membership(t, team, kayla))?.viaDomain).toBe("publicworship.org");
    expect(await asUser(t, kayla).query(api.functions.workspaceDomains.myDomainWorkspaces, {})).toEqual([]);
    const card = await asUser(t, seyi).query(api.functions.workspaceDomains.listWorkspaceDomains, { workspaceId: team });
    expect(card.domains[0]!.joined).toBe(1);
  });

  test("Can edit, when the owner picks it", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    await asUser(t, seyi).mutation(api.functions.workspaceDomains.updateWorkspaceDomain, {
      workspaceId: team,
      domain: "publicworship.org",
      role: "editor",
    });
    const kayla = await createUser(t, "kayla@publicworship.org");
    await join(t, kayla, "pw");
    expect((await membership(t, team, kayla))?.role).toBe("editor");
  });

  test("everybody else is told there is no such workspace, the same way", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    const eve = await createUser(t, "eve@elsewhere.example");
    expect(await asUser(t, eve).query(api.functions.workspaceDomains.myDomainWorkspaces, {})).toEqual([]);
    const open = await captureError(() => join(t, eve, "pw"));
    const missing = await captureError(() => join(t, eve, "nothing-here"));
    expect(errorCode(open)).toBe("WORKSPACE_NOT_FOUND");
    expect(errorCode(missing)).toBe("WORKSPACE_NOT_FOUND");
    expect(await membership(t, team, eve)).toBeNull();
  });

  test("an address that was never confirmed does not count", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    const unconfirmed = await t.run((ctx) => ctx.db.insert("users", { email: "x@publicworship.org" }));
    expect(errorCode(await captureError(() => join(t, unconfirmed, "pw")))).toBe("WORKSPACE_NOT_FOUND");
  });

  test("switched off: nobody new joins, the people already in stay", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    const kayla = await createUser(t, "kayla@publicworship.org");
    await join(t, kayla, "pw");
    await asUser(t, seyi).mutation(api.functions.workspaceDomains.updateWorkspaceDomain, {
      workspaceId: team,
      domain: "publicworship.org",
      enabled: false,
    });
    const kenzie = await createUser(t, "kenzie@publicworship.org");
    expect(errorCode(await captureError(() => join(t, kenzie, "pw")))).toBe("WORKSPACE_NOT_FOUND");
    expect(await membership(t, team, kayla)).not.toBeNull();
  });

  test("an added work email is enough, and removing it means leaving", async () => {
    const t = setupTest();
    const { seyi, team } = await world(t);
    await add(t, seyi, team, "publicworship.org");
    const kayla = await createUser(t, "kayla@gmail.com");
    await t.run(async (ctx) => {
      await ctx.db.insert("signInEmails", { userId: kayla, email: "kayla@publicworship.org", addedAt: Date.now() });
    });
    await join(t, kayla, "pw");
    expect(await membership(t, team, kayla)).not.toBeNull();
    await asUser(t, kayla).mutation(api.functions.signInEmails.removeEmail, { email: "kayla@publicworship.org" });
    expect(await membership(t, team, kayla)).toBeNull();
  });

  test("an invited member is not removed when an address goes", async () => {
    const t = setupTest();
    const { team } = await world(t);
    const kayla = await createUser(t, "kayla@gmail.com");
    await t.run(async (ctx) => {
      await ctx.db.insert("signInEmails", { userId: kayla, email: "kayla@publicworship.org", addedAt: Date.now() });
      await ctx.db.insert("workspaceMembers", { workspaceId: team, userId: kayla, role: "member", joinedAt: Date.now() });
    });
    await asUser(t, kayla).mutation(api.functions.signInEmails.removeEmail, { email: "kayla@publicworship.org" });
    expect(await membership(t, team, kayla)).not.toBeNull();
  });
});

describe("the invite-only gate", () => {
  test("lets in an address at an open domain, and nobody at a closed one", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    const { seyi, team } = await world(t);
    await t.run(async (ctx) => {
      expect(await isAdmitted(ctx.db, "kayla@publicworship.org")).toBe(false);
    });
    await add(t, seyi, team, "publicworship.org");
    await t.run(async (ctx) => {
      expect(await isAdmitted(ctx.db, "Kayla@PublicWorship.org")).toBe(true);
      expect(await isAdmitted(ctx.db, "kayla@publicworship.org.evil.example")).toBe(false);
    });
    await asUser(t, seyi).mutation(api.functions.workspaceDomains.updateWorkspaceDomain, {
      workspaceId: team,
      domain: "publicworship.org",
      enabled: false,
    });
    await t.run(async (ctx) => {
      expect(await isAdmitted(ctx.db, "kayla@publicworship.org")).toBe(false);
    });
  });
});

describe("domains as typed", () => {
  test("normalizes, and refuses what is not a domain", () => {
    expect(normalizeDomain("@PublicWorship.org.")).toBe("publicworship.org");
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("a b.org")).toBeNull();
    expect(normalizeDomain("-x.org")).toBeNull();
  });
});
