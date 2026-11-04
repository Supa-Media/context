import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { createUser, createWorkspace, setupTest, type TestConvex } from "./fixtures.helpers";
import { objectRecord, REFRESH_MS } from "../functions/textingObjects";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";
import { textingPhoneHash } from "../../mcp/src/agent/textingPhone.js";

/**
 * A TEXT'S SESSION OPENED BY THE PERSON OBJECT (`functions/textingObjects.ts`,
 * docs/decisions/texting-assistant/texting-in-objects.md).
 *
 * What must hold: the record carries phones only as keyed hashes; a session the object opened is copied here only for
 * a switched person and only while that phone is still linked to them and texting is not paused; anyone else's phone,
 * or a workspace that is not theirs, is "unlinked"; and only a switched person's workspace is named to the Worker.
 */

const PHONE = "+15555550100";
const OTHER = "+15555550199";
const SECRET = "a-test-gateway-secret-of-length";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function person(t: TestConvex, { switched = true, phone = PHONE, email = "ada@home.example", slug = "ada" } = {}) {
  const userId = await createUser(t, email);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  await t.run(async (ctx) => {
    await ctx.db.insert("phoneLinks", { userId, phone, linkedAt: Date.now() });
    await ctx.db.insert("workspaceObjectHomes", {
      workspaceId,
      home: "object",
      since: Date.now(),
      personAccess: "object",
      ...(switched ? { texting: "object" as const, textingSince: Date.now(), textingPushedAt: Date.now() } : {}),
    });
  });
  return { userId, workspaceId };
}

const opened = (personalWorkspaceId: Id<"workspaces">, phone = PHONE, hash = "a") => ({
  personalWorkspaceId,
  phone,
  hashedAccessToken: hash.repeat(64),
  hashedRefreshToken: "b".repeat(64),
  expiresAt: Date.now() + 15 * 60 * 1000,
});

describe("the record", () => {
  test("keeps phones as keyed hashes, never the number, with the scopes, zone, style and identity", async () => {
    const t = setupTest();
    const { workspaceId } = await person(t);
    const record = await t.query(internal.functions.textingObjects.recordFor, { workspaceId });
    expect(record?.phones).toEqual([PHONE]);
    expect(record?.paused).toBe(false);
    expect(record?.scopes.length).toBeGreaterThan(0);
    const kept = await objectRecord(SECRET, record!, 10);
    expect(kept.phoneHashes).toEqual([await textingPhoneHash(SECRET, PHONE)]);
    expect(JSON.stringify({ phoneHashes: kept.phoneHashes })).not.toContain("5555550100");
  });

  test("the hash matches the gateway's own vector, so both sides key one phone the same way", async () => {
    expect(await textingPhoneHash(SECRET, PHONE)).toBe("d98dc104c427289014f707f6544084189bf388eeeaf7ca46a53687a9a6220f46");
  });
});

describe("a session the object opened", () => {
  test("is copied for a switched person whose phone is linked, with the token's hash", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    expect(await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId))).toBe("linked");
    const grants = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    const texting = grants.filter((grant) => grant.clientId === TEXTS_CLIENT_ID && grant.userId === userId);
    expect(texting).toHaveLength(1);
    expect(texting[0].hashedAccessToken).toBe("a".repeat(64));
  });

  test("ATTACK: another person's phone, sent with my workspace, is unlinked and copies nothing", async () => {
    const t = setupTest();
    const me = await person(t);
    await person(t, { phone: OTHER, email: "eve@home.example", slug: "eve" });
    expect(await t.mutation(internal.functions.textingObjects.keepOpened, opened(me.workspaceId, OTHER))).toBe("unlinked");
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toEqual([]);
  });

  test("ATTACK: a person not switched gets nothing here, even with their own phone", async () => {
    const t = setupTest();
    const { workspaceId } = await person(t, { switched: false });
    expect(await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId))).toBe("unlinked");
  });

  test("ATTACK: a pause or an unlink the object has not caught up on still refuses the session", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t);
    await t.run((ctx) => ctx.db.insert("phoneSignInPauses", { userId, pausedAt: Date.now() }));
    expect(await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId))).toBe("unlinked");
    await t.run(async (ctx) => {
      for (const pause of await ctx.db.query("phoneSignInPauses").collect()) await ctx.db.delete(pause._id);
      for (const link of await ctx.db.query("phoneLinks").collect()) await ctx.db.delete(link._id);
    });
    expect(await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId))).toBe("unlinked");
  });

  test("a stale record is pushed again behind the copy, a fresh one is not", async () => {
    const t = setupTest();
    const { workspaceId } = await person(t);
    await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId));
    const scheduled = async () => (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((job) => job.name.includes("textingObjects") && job.name.includes("push"));
    expect(await scheduled()).toHaveLength(0);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("workspaceObjectHomes").first();
      await ctx.db.patch(row!._id, { textingPushedAt: Date.now() - REFRESH_MS - 1 });
    });
    await t.mutation(internal.functions.textingObjects.keepOpened, opened(workspaceId, PHONE, "c"));
    expect(await scheduled()).toHaveLength(1);
  });
});

describe("the Worker is told whose object to ask", () => {
  test("only for a switched person", async () => {
    const t = setupTest();
    const { workspaceId } = await person(t);
    expect(await t.mutation(internal.functions.textingObjects.sessionHint, { phone: PHONE })).toBe(workspaceId);
    const t2 = setupTest();
    await person(t2, { switched: false });
    expect(await t2.mutation(internal.functions.textingObjects.sessionHint, { phone: PHONE })).toBeNull();
    expect(await t2.mutation(internal.functions.textingObjects.sessionHint, { phone: OTHER })).toBeNull();
  });

  test("the switch turns on only for a person whose connections their object decides", async () => {
    const t = setupTest();
    const { workspaceId } = await person(t, { switched: false });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("workspaceObjectHomes").first();
      await ctx.db.patch(row!._id, { personAccess: "dual" });
    });
    await t.mutation(internal.functions.textingObjects.markPushed, { workspaceId, at: 1, switchOn: true });
    expect((await t.query(internal.functions.textingObjects.textingHome, { workspaceId })).object).toBe(false);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("workspaceObjectHomes").first();
      await ctx.db.patch(row!._id, { personAccess: "object" });
    });
    await t.mutation(internal.functions.textingObjects.markPushed, { workspaceId, at: 2, switchOn: true });
    expect((await t.query(internal.functions.textingObjects.textingHome, { workspaceId })).object).toBe(true);
  });
});
