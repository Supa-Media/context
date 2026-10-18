import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
import { isAdmitted, isAdmittedWithoutReferral } from "../functions/lib/waitlist";

/**
 * A DOMAIN OPENED TO A SHARED WORKSPACE ADMITS ITS ADDRESSES (lib/waitlist.ts).
 *
 * An address at a domain that some live, shared workspace is open to is let
 * in, so a person who opens a shared note can sign up. Only that: a switched
 * off row, a personal workspace's row, a workspace that no longer exists, a
 * personal mail service, and a look-alike of the domain admit nobody.
 */

afterEach(() => vi.unstubAllEnvs());

const DOMAIN = "publicworship.life";

async function openDomain(t: TestConvex, domain: string, enabled = true) {
  const owner = await createUser(t, `owner@${DOMAIN}`);
  const team = await createWorkspace(t, owner, "pw", { kind: "shared" });
  await t.run((ctx) =>
    ctx.db.insert("workspaceDomains", {
      workspaceId: team,
      domain,
      role: "member",
      enabled,
      addedBy: owner,
      addedAt: Date.now(),
    }),
  );
  return { owner, team };
}

async function admitted(t: TestConvex, email: string): Promise<boolean> {
  return await t.run((ctx) => isAdmitted(ctx.db, email));
}

/** `count` switched-off rows on one domain, each on its own shared workspace. */
async function closedRows(ctx: MutationCtx, owner: Id<"users">, count: number) {
  for (let i = 0; i < count; i++) {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: `closed-${i}`,
      displayName: `closed ${i}`,
      createdBy: owner,
      kind: "shared",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("workspaceDomains", {
      workspaceId,
      domain: DOMAIN,
      role: "member",
      enabled: false,
      addedBy: owner,
      addedAt: Date.now(),
    });
  }
}

describe("admission through an open domain", () => {
  test("an enabled row on a shared workspace admits its addresses, in any case", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    await openDomain(t, DOMAIN);
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(true);
    expect(await admitted(t, "Kid@PublicWorship.Life")).toBe(true);
  });

  test("a switched-off row admits nobody", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    await openDomain(t, DOMAIN, false);
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(false);
  });

  test("a row on a personal workspace admits nobody", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    const owner = await createUser(t, `owner@${DOMAIN}`);
    const mine = await createWorkspace(t, owner, "kept-own", { kind: "personal" });
    await t.run((ctx) =>
      ctx.db.insert("workspaceDomains", {
        workspaceId: mine,
        domain: DOMAIN,
        role: "member",
        enabled: true,
        addedBy: owner,
        addedAt: Date.now(),
      }),
    );
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(false);
  });

  test("a row whose workspace was deleted admits nobody", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    const { team } = await openDomain(t, DOMAIN);
    await t.run((ctx) => ctx.db.delete(team));
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(false);
  });

  test("a personal mail service admits nobody, even with a row for it", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    await openDomain(t, "gmail.com");
    expect(await admitted(t, "kid@gmail.com")).toBe(false);
  });

  test("look-alike domains admit nobody", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    await openDomain(t, DOMAIN);
    expect(await admitted(t, `kid@sub.${DOMAIN}`)).toBe(false);
    expect(await admitted(t, `kid@${DOMAIN}.evil.com`)).toBe(false);
    expect(await admitted(t, `kid@evil-${DOMAIN}`)).toBe(false);
  });

  test("the sharing path (without a referral) admits the same addresses", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    await openDomain(t, DOMAIN);
    const ok = await t.run((ctx) => isAdmittedWithoutReferral(ctx.db, `kid@${DOMAIN}`));
    expect(ok).toBe(true);
  });

  test("the lookup reads up to 100 rows for a domain, and no further", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    const owner = await createUser(t, `owner@${DOMAIN}`);
    const within = await createWorkspace(t, owner, "pw", { kind: "shared" });
    await t.run(async (ctx) => {
      // 50 closed rows come first, then an open one still inside the bound.
      await closedRows(ctx, owner, 50);
      await ctx.db.insert("workspaceDomains", {
        workspaceId: within,
        domain: DOMAIN,
        role: "member",
        enabled: true,
        addedBy: owner,
        addedAt: Date.now(),
      });
    });
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(true);
  });

  test("rows past the 100th for a domain are not read", async () => {
    const t = setupTest();
    vi.stubEnv("OPEN_SIGNUP", "");
    const owner = await createUser(t, `owner@${DOMAIN}`);
    const beyond = await createWorkspace(t, owner, "pw", { kind: "shared" });
    await t.run(async (ctx) => {
      // 100 closed rows come first, so the open one is past the bound.
      await closedRows(ctx, owner, 100);
      await ctx.db.insert("workspaceDomains", {
        workspaceId: beyond,
        domain: DOMAIN,
        role: "member",
        enabled: true,
        addedBy: owner,
        addedAt: Date.now(),
      });
    });
    expect(await admitted(t, `kid@${DOMAIN}`)).toBe(false);
  });
});
