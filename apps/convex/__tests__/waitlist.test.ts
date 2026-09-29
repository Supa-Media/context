/**
 * INVITE-ONLY SIGN-IN — `functions/waitlist.ts`, `functions/lib/waitlist.ts`,
 * the waitlist half of `functions/admin.ts`, and the `admission` wiring in
 * `auth.ts`.
 *
 * The property that matters is on the server: an address that has not been
 * let in is never mailed a code and never given an account, whatever the page
 * draws. The rest is that nobody already here is locked out, and that the
 * list itself behaves (one row and one mail per address, staff only).
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are failures in this file.
 *
 *   `admission` removed from `auth.ts`                                 2
 *   `isAdmitted` skipping the existing-account lookup                  2
 *   `isAdmitted` ignoring invitation expiry                            1
 *   `describe` overwriting an existing answer                          1
 *   `admitRow` scheduling mail without claiming `admittedMailAt`       1
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { isAdmitted, mayCreateUser, OPEN_SIGNUP_ENV_VAR } from "../functions/lib/waitlist";
import { WAITLIST_JOINS_PER_HOUR } from "../functions/waitlist";
import { setupTest, type TestConvex } from "./fixtures.helpers";

const STAFF = "staff@context.invalid";
const ENV_KEYS = [
  ADMIN_EMAILS_ENV_VAR,
  OPEN_SIGNUP_ENV_VAR,
  "RESEND_API_KEY",
  "SITE_URL",
  "CONVEX_SITE_URL",
  "JWT_PRIVATE_KEY",
] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;

beforeEach(async () => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[ADMIN_EMAILS_ENV_VAR] = STAFF;
  delete process.env[OPEN_SIGNUP_ENV_VAR];
  delete process.env.RESEND_API_KEY;
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.SITE_URL = "https://context.invalid";
  process.env.CONVEX_SITE_URL = "https://context.invalid";
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access attempted");
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    const was = previous.get(key);
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
});

async function seedUser(t: TestConvex, email: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { email, emailVerificationTime: Date.now() } as never),
  );
}

async function staff(t: TestConvex) {
  return t.withIdentity({ subject: await seedUser(t, STAFF) });
}

async function row(t: TestConvex, email: string) {
  return t.run(async (ctx) =>
    ctx.db.query("waitlist").withIndex("by_email", (q) => q.eq("email", email)).unique(),
  );
}

async function admitted(t: TestConvex, email: string) {
  return t.run(async (ctx) => isAdmitted(ctx.db, email));
}

describe("the one email field", () => {
  test("a stranger joins once, and hears 'already' after that", async () => {
    const t = setupTest();
    expect(await t.mutation(api.functions.waitlist.enter, { email: " Jon@Studio.test " })).toEqual({
      status: "joined",
    });
    expect((await row(t, "jon@studio.test"))?.status).toBe("waiting");
    expect(await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" })).toEqual({
      status: "already",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("waitlist").collect());
    expect(rows).toHaveLength(1);
  });

  test("an address that is not one is refused and writes nothing", async () => {
    const t = setupTest();
    await expect(t.mutation(api.functions.waitlist.enter, { email: "not an email" })).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("waitlist").collect())).toHaveLength(0);
  });

  test("somebody with an account is let straight in, whatever case they type", async () => {
    const t = setupTest();
    await seedUser(t, "maya@acme.test");
    await seedUser(t, "Old@Acme.test");
    expect(await t.mutation(api.functions.waitlist.enter, { email: "MAYA@acme.test" })).toEqual({
      status: "admitted",
    });
    expect(await admitted(t, "Old@Acme.test")).toBe(true);
    expect(await row(t, "maya@acme.test")).toBeNull();
  });

  test("staff and a pending, unexpired invitation admit; an expired one does not", async () => {
    const t = setupTest();
    expect(await admitted(t, STAFF)).toBe(true);
    const inviter = await seedUser(t, "owner@acme.test");
    await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        slug: "acme",
        displayName: "Acme",
        createdBy: inviter,
        kind: "shared",
        structureTemplate: "para",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never);
      for (const [invitee, expiresAt] of [
        ["invited@acme.test", Date.now() + 60_000],
        ["expired@acme.test", Date.now() - 1],
      ] as const) {
        await ctx.db.insert("workspaceInvitations", {
          workspaceId,
          inviteeKind: "email",
          invitee,
          role: "member",
          invitedBy: inviter,
          token: `t-${invitee}`,
          status: "pending",
          expiresAt,
          createdAt: Date.now(),
        });
      }
    });
    expect(await admitted(t, "invited@acme.test")).toBe(true);
    expect(await admitted(t, "expired@acme.test")).toBe(false);
  });

  test("OPEN_SIGNUP=true admits everyone", async () => {
    const t = setupTest();
    expect(await admitted(t, "anyone@else.test")).toBe(false);
    process.env[OPEN_SIGNUP_ENV_VAR] = "true";
    expect(await admitted(t, "anyone@else.test")).toBe(true);
  });

  test("the answer is written once and only for somebody waiting", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    await t.mutation(api.functions.waitlist.describe, { email: "jon@studio.test", useFor: "  agency notes " });
    await t.mutation(api.functions.waitlist.describe, { email: "jon@studio.test", useFor: "rewritten" });
    expect((await row(t, "jon@studio.test"))?.useFor).toBe("agency notes");
    await t.mutation(api.functions.waitlist.describe, { email: "nobody@studio.test", useFor: "x" });
    expect(await row(t, "nobody@studio.test")).toBeNull();
  });

  test("new rows are capped per hour across every caller", async () => {
    const t = setupTest();
    await t.run(async (ctx) =>
      ctx.db.insert("rateLimits", { key: "waitlist.join", windowStartedAt: Date.now(), count: WAITLIST_JOINS_PER_HOUR }),
    );
    await expect(t.mutation(api.functions.waitlist.enter, { email: "late@studio.test" })).rejects.toThrow(
      /Too many requests/,
    );
    await seedUser(t, "maya@acme.test");
    expect(await t.mutation(api.functions.waitlist.enter, { email: "maya@acme.test" })).toEqual({
      status: "admitted",
    });
  });
});

describe("the server refuses a stranger, whatever the page draws", () => {
  test("no code is sent to an address that is not let in", async () => {
    const t = setupTest();
    await expect(
      t.action(api.auth.signIn, { provider: "email", params: { email: "stranger@else.test" } }),
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("users").collect())).toHaveLength(0);
  });

  test("nor through the public magic-link provider", async () => {
    const t = setupTest();
    await expect(
      t.action(api.auth.signIn, { provider: "magic-link", params: { email: "stranger@else.test" } }),
    ).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("authVerificationCodes").collect())).toHaveLength(0);
  });

  test("an admitted address gets a code and an account", async () => {
    const t = setupTest();
    const as = await staff(t);
    await as.mutation(api.functions.admin.addToWaitlist, { emails: "new@person.test" });
    await t.action(api.auth.signIn, { provider: "email", params: { email: "new@person.test" } });
    const codes = await t.run(async (ctx) => ctx.db.query("authVerificationCodes").collect());
    expect(codes).toHaveLength(1);
  });

  test("the new-account check refuses strangers and passes fixed test accounts", async () => {
    const t = setupTest();
    await t.run(async (ctx) => {
      expect(await mayCreateUser(ctx.db, { provider: "email", email: "stranger@else.test" })).toBe(false);
      expect(await mayCreateUser(ctx.db, { provider: "magic-link", email: "stranger@else.test" })).toBe(false);
      expect(await mayCreateUser(ctx.db, { provider: "test-email", email: "agent@else.test" })).toBe(true);
      expect(await mayCreateUser(ctx.db, { provider: "email" })).toBe(false);
    });
  });

  test("the code check the auth hook runs agrees with the rule", async () => {
    const t = setupTest();
    expect(await t.query(internal.functions.waitlist.admitted, { email: "stranger@else.test" })).toBe(false);
    expect(await t.query(internal.functions.waitlist.admitted, { email: STAFF })).toBe(true);
  });
});

describe("the staff Waitlist", () => {
  test("strangers cannot read or change it", async () => {
    const t = setupTest();
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    const id = (await row(t, "jon@studio.test"))!._id;
    const stranger = t.withIdentity({ subject: await seedUser(t, "who@else.test") });
    await expect(stranger.query(api.functions.admin.listWaitlist, { status: "waiting" })).rejects.toThrow();
    await expect(stranger.mutation(api.functions.admin.admitWaitlist, { ids: [id] })).rejects.toThrow();
    await expect(t.mutation(api.functions.admin.addToWaitlist, { emails: "me@else.test" })).rejects.toThrow();
    expect((await row(t, "jon@studio.test"))?.status).toBe("waiting");
  });

  test("Let in admits, claims one mail, and the field then says admitted", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    const listed = await as.query(api.functions.admin.listWaitlist, { status: "waiting" });
    expect(listed.rows.map((r) => r.email)).toEqual(["jon@studio.test"]);
    expect(listed.counts).toEqual({ waiting: 1, admitted: 0 });

    const id = listed.rows[0]!.id;
    expect(await as.mutation(api.functions.admin.admitWaitlist, { ids: [id, id] })).toEqual({ changed: 1 });
    const after = await row(t, "jon@studio.test");
    expect(after?.status).toBe("admitted");
    const claimedAt = after?.admittedMailAt;
    expect(claimedAt).toBeTypeOf("number");
    await as.mutation(api.functions.admin.admitWaitlist, { ids: [id] });
    expect((await row(t, "jon@studio.test"))?.admittedMailAt).toBe(claimedAt);

    expect(await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" })).toEqual({
      status: "admitted",
    });
  });

  test("Remove takes somebody off without telling them", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" });
    const id = (await row(t, "jon@studio.test"))!._id;
    await as.mutation(api.functions.admin.removeFromWaitlist, { ids: [id] });
    expect(await t.mutation(api.functions.waitlist.enter, { email: "jon@studio.test" })).toEqual({
      status: "already",
    });
    expect(await admitted(t, "jon@studio.test")).toBe(false);
  });

  test("Add emails lets pasted addresses in and hands back the ones that are not", async () => {
    const t = setupTest();
    const as = await staff(t);
    await t.mutation(api.functions.waitlist.enter, { email: "waiting@studio.test" });
    const result = await as.mutation(api.functions.admin.addToWaitlist, {
      emails: "a@one.test, B@two.test\nwaiting@studio.test nope",
    });
    expect(result).toEqual({ changed: 3, invalid: ["nope"] });
    for (const email of ["a@one.test", "b@two.test", "waiting@studio.test"]) {
      expect(await admitted(t, email)).toBe(true);
    }
  });
});
