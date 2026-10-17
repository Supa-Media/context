import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, drainScheduled, seedStorageBinding, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";
import { MANAGED_R2_ACCOUNT_ID_ENV_VAR, managedBucketName } from "../functions/lib/managedStorage";
import { SETUP_ASK_TTL_MS } from "../functions/textSetup";
import { APP_REVIEW_PHONE } from "../functions/lib/reviewerAccount";

/**
 * SETTING SOMEBODY UP BY TEXT (Dev2, 2026-10-17: onboarding happens by text,
 * handle first).
 *
 * The sending number is the proof, the same one phone sign-in takes, so the
 * properties that matter are about who it may and may not act for:
 *
 *  - a phone let in off the waitlist gets an account, a personal workspace
 *    with the handle it asked for, and a link, and nothing before it was asked;
 *  - a handle is held to the app's rules (format, reserved, taken);
 *  - a phone confirmed on an account sets up *that* account, never a second
 *    one, and only while it owns no personal workspace;
 *  - an account that owns one, a paused phone, an account linked to another
 *    number, the review phone and a stranger are never set up or linked.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `whoMaySetUp` ignoring `isPhoneAdmitted`                              1
 *   `whoMaySetUp` ignoring an owned personal workspace                    1
 *   `whoMaySetUp` ignoring a "This wasn't me" pause                       1
 *   `whoMaySetUp` ignoring a link to another number                       1
 *   the review phone allowed                                              1
 *   the asked row not required before a handle is taken                   8
 *   `checkAvailability` skipped                                           2
 *   a held phone given a new account                                      1
 *   the `texts.phone.linked` audit dropped                                1
 *   the layout run on any bucket, not only our own                        1
 *   the layout ignoring what the probe found                              1
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const setup = async (t: T, candidate?: string, phone = PHONE) =>
  (await agentPost(t, "/agent-texts/setup", candidate === undefined ? { phone } : { phone, candidate })).body;

async function admit(t: T, phone = PHONE) {
  await t.run((ctx) => ctx.db.insert("waitlist", { phone, status: "admitted", joinedAt: 1, source: "login" }));
}

async function heldBy(t: T, email: string, phone = PHONE): Promise<Id<"users">> {
  const userId = await createUser(t, email);
  await t.run((ctx) => ctx.db.patch(userId, { phone, phoneVerificationTime: Date.now() }));
  return userId;
}

async function counts(t: T) {
  return await t.run(async (ctx) => ({
    users: (await ctx.db.query("users").collect()).length,
    workspaces: (await ctx.db.query("workspaces").collect()).length,
    links: (await ctx.db.query("phoneLinks").collect()).length,
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the door", () => {
  // The first request in a file compiles the HTTP router, which can take a few seconds cold.
  test("refuses without the agent worker's own secret", async () => {
    const t = setupTest();
    await admit(t);
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
      expect((await agentPost(t, "/agent-texts/setup", { phone: PHONE }, secret)).status).toBe(401);
    }
    expect(await counts(t)).toEqual({ users: 0, workspaces: 0, links: 0 });
  }, 20_000);

  test("refuses a candidate that is not one short string", async () => {
    const t = setupTest();
    for (const candidate of [42, "", "a".repeat(65)]) {
      expect((await agentPost(t, "/agent-texts/setup", { phone: PHONE, candidate })).status).toBe(400);
    }
  });
});

describe("a phone let in off the waitlist", () => {
  test("is asked first, and a one-word first text is never taken as the handle", async () => {
    const t = setupTest();
    await admit(t);
    expect(await setup(t, "ada")).toEqual({ status: "ask" });
    expect(await counts(t)).toEqual({ users: 0, workspaces: 0, links: 0 });
  });

  test("gets an account, a personal workspace with that handle, and a link", async () => {
    const t = setupTest();
    await admit(t);
    await setup(t);
    const answer = await setup(t, "Ada");
    expect(answer).toEqual({ status: "set_up", handle: "ada", storage: "none", url: "https://app.context.invalid/console/ada" });

    const { user, workspace, members, link, audit, asked } = await t.run(async (ctx) => {
      const user = await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", PHONE)).unique();
      const workspace = await ctx.db.query("workspaces").unique();
      return {
        user,
        workspace,
        members: await ctx.db.query("workspaceMembers").collect(),
        link: await ctx.db.query("phoneLinks").unique(),
        audit: await ctx.db.query("auditEvents").collect(),
        asked: await ctx.db.query("textSetups").collect(),
      };
    });
    // The phone is confirmed on the new account, as a texted sign-in code would.
    expect(user?.phoneVerificationTime).toBeDefined();
    expect(workspace).toMatchObject({ slug: "ada", kind: "personal", createdBy: user?._id });
    expect(members).toEqual([expect.objectContaining({ userId: user?._id, role: "owner" })]);
    expect(link).toMatchObject({ userId: user?._id, phone: PHONE });
    expect(asked).toEqual([]);
    // Every creation under the person who texted, through Tex, with the last four digits only.
    for (const action of ["texts.setup.account_created", "texts.setup.workspace_created", "texts.phone.linked"]) {
      expect(audit).toContainEqual(
        expect.objectContaining({ action, workspaceId: workspace?._id, actorUserId: user?._id, actorClientId: "context_texts" }),
      );
    }
    expect(JSON.stringify(audit)).not.toContain("5555550100");

    // The next text is an ordinary linked session.
    expect((await agentPost(t, "/agent-texts/session", { phone: PHONE })).body.status).toBe("linked");
    expect(await setup(t, "other")).toEqual({ status: "not_eligible" });
  });

  test("is held to the app's handle rules, and asked again", async () => {
    const t = setupTest();
    await admit(t);
    const taken = await createUser(t, "taken@example.invalid");
    await createWorkspace(t, taken, "taken-name", { kind: "personal" });
    await setup(t);
    expect(await setup(t, "admin")).toMatchObject({ status: "rejected", reason: "reserved" });
    expect(await setup(t, "tex")).toMatchObject({ status: "rejected", reason: "reserved" });
    expect(await setup(t, "a")).toMatchObject({ status: "rejected", reason: "too_short" });
    expect(await setup(t, "ada_l")).toMatchObject({ status: "rejected", reason: "invalid_characters" });
    expect(await setup(t, "xn--80ak6aa92e")).toMatchObject({ status: "rejected", reason: "reserved_label_form" });
    expect(await setup(t, "taken-name")).toMatchObject({ status: "rejected", reason: "taken" });
    expect(await setup(t)).toEqual({ status: "rejected", reason: "not_a_handle" });
    expect((await counts(t)).users).toBe(1);
    expect((await setup(t, "ada")).status).toBe("set_up");
  });

  test("an unanswered question lapses, and is asked again", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      await admit(t);
      await setup(t);
      vi.setSystemTime(Date.now() + SETUP_ASK_TTL_MS + 1);
      expect(await setup(t, "ada")).toEqual({ status: "ask" });
      expect((await counts(t)).workspaces).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("is limited per phone, and a refusal creates nothing", async () => {
    const t = setupTest();
    await admit(t);
    await setup(t);
    for (let i = 0; i < 19; i++) await setup(t, "admin");
    expect(await setup(t, "ada")).toEqual({ status: "too_many" });
    expect(await counts(t)).toEqual({ users: 0, workspaces: 0, links: 0 });
  });
});

describe("a phone that may not be set up", () => {
  test("a stranger, a removed row and the review phone get the sign-in link", async () => {
    const t = setupTest();
    await t.run((ctx) => ctx.db.insert("waitlist", { phone: "+15555550122", status: "removed", joinedAt: 1, source: "login" }));
    await t.run((ctx) => ctx.db.insert("waitlist", { phone: "+15555550133", status: "waiting", joinedAt: 1, source: "login" }));
    await admit(t, APP_REVIEW_PHONE);
    for (const phone of [PHONE, "+15555550122", "+15555550133", APP_REVIEW_PHONE, "not-a-phone"]) {
      expect(await setup(t, undefined, phone)).toEqual({ status: "not_eligible" });
      expect(await setup(t, "ada", phone)).toEqual({ status: "not_eligible" });
    }
    expect(await counts(t)).toEqual({ users: 0, workspaces: 0, links: 0 });
    expect(await t.run((ctx) => ctx.db.query("textSetups").collect())).toEqual([]);
  });

  test("an account that already owns a personal workspace is never set up or linked by a text", async () => {
    // A number its carrier gave someone else must not start answering from these notes.
    const t = setupTest();
    const owner = await heldBy(t, "o@example.invalid");
    await createWorkspace(t, owner, "owner-notes", { kind: "personal" });
    await admit(t);
    expect(await setup(t)).toEqual({ status: "not_eligible" });
    expect(await setup(t, "ada")).toEqual({ status: "not_eligible" });
    expect(await counts(t)).toEqual({ users: 1, workspaces: 1, links: 0 });
    expect((await agentPost(t, "/agent-texts/session", { phone: PHONE })).body.status).toBe("unlinked");
  });

  test("a phone paused by \"This wasn't me\" is not set up", async () => {
    const t = setupTest();
    const held = await heldBy(t, "p@example.invalid");
    await t.run((ctx) => ctx.db.insert("phoneSignInPauses", { userId: held, pausedAt: Date.now() }));
    expect(await setup(t)).toEqual({ status: "not_eligible" });
  });

  test("an account linked to another number is not moved onto this one", async () => {
    const t = setupTest();
    const held = await heldBy(t, "l@example.invalid");
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: held, phone: "+15555550199", linkedAt: 1 }));
    expect(await setup(t)).toEqual({ status: "not_eligible" });
  });

  test("a linked phone never runs setup", async () => {
    const t = setupTest();
    const held = await heldBy(t, "k@example.invalid");
    await t.run((ctx) => ctx.db.insert("phoneLinks", { userId: held, phone: PHONE, linkedAt: 1 }));
    expect(await setup(t)).toEqual({ status: "not_eligible" });
  });
});

describe("a phone confirmed on an account with no workspace yet", () => {
  test("sets up that account and no other, and mails its emails", async () => {
    const t = setupTest();
    const held = await heldBy(t, "h@example.invalid");
    await setup(t);
    expect((await setup(t, "holder")).status).toBe("set_up");
    const { users, workspace, link, audit, jobs } = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      workspace: await ctx.db.query("workspaces").unique(),
      link: await ctx.db.query("phoneLinks").unique(),
      audit: await ctx.db.query("auditEvents").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    expect(users.map((u) => u._id)).toEqual([held]);
    expect(workspace?.createdBy).toBe(held);
    expect(link?.userId).toBe(held);
    expect(audit.map((row) => row.action)).not.toContain("texts.setup.account_created");
    expect(jobs.some((job) => job.name.includes("signInAlerts"))).toBe(true);
  });

  test("someone who came in through a work domain needs a personal email first, as in the app", async () => {
    const t = setupTest();
    const held = await heldBy(t, "w@work.example");
    const shared = await createUser(t, "s@work.example");
    const workspaceId = await createWorkspace(t, shared, "work-team", { kind: "shared" });
    await t.run((ctx) =>
      ctx.db.insert("workspaceMembers", { workspaceId, userId: held, role: "member", joinedAt: 1, viaDomain: "work.example" }),
    );
    expect(await setup(t)).toEqual({ status: "not_eligible" });
  });
});

describe("storage", () => {
  test("starts the free managed bucket where it is offered, and lays out the folders once it answers", async () => {
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    const t = setupTest();
    await admit(t);
    await setup(t);
    expect(await setup(t, "ada")).toMatchObject({ status: "set_up", storage: "on_the_way" });
    const { workspaceId, userId, plan, row } = await t.run(async (ctx) => {
      const workspace = (await ctx.db.query("workspaces").unique())!;
      return {
        workspaceId: workspace._id,
        userId: workspace.createdBy,
        plan: await ctx.db.query("workspacePlans").unique(),
        row: await ctx.db.query("textSetups").unique(),
      };
    });
    expect(plan).toMatchObject({ freeManaged: true, managedStorage: true });
    expect(row).toMatchObject({ stage: "layout", workspaceId, userId });
    expect(row?.phone).toBeUndefined();
    await drainScheduled(t);

    await seedStorageBinding(t, { workspaceId, boundBy: userId, status: "unverified", bucket: managedBucketName(workspaceId) });
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      actorUserId: userId,
      ok: true,
      capabilities: { conditionalWrite: true },
      scaffoldReason: "empty",
    });
    const after = await t.run(async (ctx) => ({
      audit: await ctx.db.query("auditEvents").collect(),
      rows: await ctx.db.query("textSetups").collect(),
    }));
    expect(after.audit).toContainEqual(
      expect.objectContaining({ action: "workspace.structure_applied", actorUserId: userId, details: { template: "para", folderCount: 0 } }),
    );
    expect(after.rows).toEqual([]);
    await drainScheduled(t);
  });

  test("never lays out a bucket that is not our own, or one not seen empty", async () => {
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, ACCOUNT_ID);
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    for (const [bucket, scaffoldReason] of [["their-own-bucket", "empty"], [null, "existing-context"], [null, "not-attempted"]] as const) {
      const t = setupTest();
      await admit(t);
      await setup(t);
      await setup(t, "ada");
      await drainScheduled(t);
      const { workspaceId, userId } = await t.run(async (ctx) => {
        const workspace = (await ctx.db.query("workspaces").unique())!;
        return { workspaceId: workspace._id, userId: workspace.createdBy };
      });
      await seedStorageBinding(t, { workspaceId, boundBy: userId, status: "unverified", bucket: bucket ?? managedBucketName(workspaceId) });
      await t.mutation(internal.functions.storage.recordVerification, {
        workspaceId,
        actorUserId: userId,
        ok: true,
        capabilities: { conditionalWrite: true },
        scaffoldReason,
      });
      const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
      expect(audit.map((row) => row.action)).not.toContain("workspace.structure_applied");
      await drainScheduled(t);
    }
  });

  test("starts nothing where free storage is not offered", async () => {
    const t = setupTest();
    await admit(t);
    await setup(t);
    expect(await setup(t, "ada")).toMatchObject({ status: "set_up", storage: "none" });
    expect(await t.run((ctx) => ctx.db.query("textSetups").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("workspacePlans").collect())).toEqual([]);
  });
});

describe("cleanup", () => {
  test("the hourly sweep removes questions nobody answered", async () => {
    vi.useFakeTimers();
    try {
      const t = setupTest();
      await admit(t);
      await setup(t);
      vi.setSystemTime(Date.now() + SETUP_ASK_TTL_MS + 1);
      await t.mutation(internal.functions.textSetup.purgeTextSetups, {});
      expect(await t.run((ctx) => ctx.db.query("textSetups").collect())).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
