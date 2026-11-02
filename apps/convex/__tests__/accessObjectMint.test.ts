/**
 * The AI client grants a switched person's object decides (`functions/lib/accessHandOff/objectMint.ts`), as the console
 * and card-key mints (`functions/agentGrant.ts`, `functions/cardsKey.ts`) and the Tex job grants (`functions/lib/texJobs.ts`)
 * issue them. Covers: an unswitched person still gets legacy tokens and an active row; a switched person's plain writes
 * to `oauthGrants` are refused by the rowWatch guard while the write-behind twins succeed; the twins refuse an
 * unswitched person; a switched mint that the object does not keep is revoked and fails; `keepConnection` hands the
 * object one row and revokes on an error answer or a throw; `objectPair` names its person object in both tokens; the
 * Tex job clients pass the guard and `claude` does not; the Convex and gateway lists of control-plane clients are equal.
 *
 * `t.run` skips the watched mutation wrapper, so the guard is exercised through a watched `internalMutation` defined
 * below (the same builder every production mutation uses) and its `_handler`. Every value is fake (example.com).
 *
 * Sabotage, each confirmed to fail a case here: drop `requireSwitched` from `applyConsoleGrantBehind`; skip the revoke
 * when the object does not keep the connection; drop `context_routines` from `CONVEX_ONLY_CLIENTS`; let `mintCardsKey`
 * mint legacy tokens for a switched person.
 */

import { describe, expect, test } from "vitest";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { keepConnection, objectPair } from "../functions/lib/accessHandOff/objectMint";
import { CONVEX_ONLY_CLIENTS } from "../functions/lib/accessHandOff/record";
import { internalMutation as watchedInternalMutation } from "../functions/lib/rowWatch/mutations";
import { applyTexJobGrant } from "../functions/lib/texJobs";
import { parseToken } from "../../mcp/src/workspaceStore/access.js";
import { CONTROL_PLANE_CLIENTS } from "../../mcp/src/workspaceStore/personRows.js";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";

const HOUR = 3_600_000;
const DEVICE = "phone-0000-aaaa";
const TEX_JOB_CLIENTS = ["context_routines", "context_heartbeat", "context_dreams", "context_housekeeping"];

async function world() {
  const t = setupTest();
  const alice = await createUser(t, "object-mint-alice@example.com");
  const aliceWs = await createWorkspace(t, alice, "object-mint-alice");
  return { t, alice, aliceWs };
}

/** Switch a person: their personal workspace's `personAccess` is `object`. */
async function switchPerson(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  await t.run((ctx) => ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, personAccess: "object", personAccessSince: 0 }));
}

const grantsFor = (t: TestConvex, clientId: string) =>
  t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).filter((grant) => grant.clientId === clientId));

const grantRow = (t: TestConvex, grantId: Id<"oauthGrants">) => t.run((ctx) => ctx.db.get(grantId));

async function consoleArgs(userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return {
    actorUserId: userId,
    workspaceId,
    hashedAccessToken: await hashToken("cat_fake-console-access-token-0001"),
    hashedRefreshToken: await hashToken("unissued_fake-console-refresh-0001"),
    expiresAt: Date.now() + HOUR,
  };
}

async function cardsArgs(userId: Id<"users">, workspaceId: Id<"workspaces">) {
  return {
    actorUserId: userId,
    workspaceId,
    deviceId: DEVICE,
    hashedAccessToken: await hashToken("cat_fake-cards-access-token-0001"),
    hashedRefreshToken: await hashToken("crt_fake-cards-refresh-token-0001"),
    expiresAt: Date.now() + HOUR,
  };
}

/** A switched person's console grant, written behind their object the way the mint does. */
async function switchedConsoleGrant(t: TestConvex, userId: Id<"users">, workspaceId: Id<"workspaces">): Promise<Id<"oauthGrants">> {
  await switchPerson(t, workspaceId);
  const { grantId } = await t.mutation(internal.functions.agentGrant.applyConsoleGrantBehind, await consoleArgs(userId, workspaceId));
  return grantId;
}

/** A watched internal mutation running `applyTexJobGrant` with the client id it is given. */
const grantTexJob = watchedInternalMutation({
  args: { clientId: v.string(), userId: v.id("users"), workspaceId: v.id("workspaces") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await applyTexJobGrant(ctx, {
      clientId: args.clientId,
      userId: args.userId,
      workspaceId: args.workspaceId,
      scopes: ["context:read"],
      token: { hashedAccessToken: "a".repeat(64), hashedRefreshToken: "b".repeat(64) },
      expiresAt: Date.now() + HOUR,
      now: Date.now(),
    });
    return null;
  },
});

/** The watched mutation's handler, run inside `t.run` so the guard wrapper is the one that answers. */
type Raw = { _handler: (ctx: unknown, args: unknown) => Promise<unknown> };
const runTexJob = (t: TestConvex, clientId: string, userId: Id<"users">, workspaceId: Id<"workspaces">) =>
  t.run((ctx) => (grantTexJob as unknown as Raw)._handler(ctx, { clientId, userId, workspaceId }));

describe("an unswitched person", () => {
  test("mintConsoleGrant returns a legacy access token and an active row", async () => {
    const { t, alice, aliceWs } = await world();
    const minted = await asUser(t, alice).action(api.functions.agentGrant.mintConsoleGrant, { workspaceId: aliceWs });
    expect(minted.accessToken).toMatch(/^cat_/);
    expect(parseToken(minted.accessToken)).toEqual({ format: "legacy", kind: "access" });
    const rows = await grantsFor(t, "context_console");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "active", userId: alice, workspaceId: aliceWs });
  });

  test("mintCardsKey returns a legacy access and refresh token and an active row", async () => {
    const { t, alice, aliceWs } = await world();
    const key = await asUser(t, alice).action(api.functions.cardsKey.mintCardsKey, { workspaceId: aliceWs, deviceId: DEVICE });
    expect(key.accessToken).toMatch(/^cat_/);
    expect(parseToken(key.refreshToken)).toEqual({ format: "legacy", kind: "refresh" });
    const rows = await grantsFor(t, "context_cards");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
  });

  test("applyConsoleGrantBehind and applyCardsKeyBehind refuse with NOT_SWITCHED", async () => {
    const { t, alice, aliceWs } = await world();
    const console_ = await captureError(async () => t.mutation(internal.functions.agentGrant.applyConsoleGrantBehind, await consoleArgs(alice, aliceWs)));
    expect(errorCode(console_)).toBe("NOT_SWITCHED");
    const cards = await captureError(async () => t.mutation(internal.functions.cardsKey.applyCardsKeyBehind, await cardsArgs(alice, aliceWs)));
    expect(errorCode(cards)).toBe("NOT_SWITCHED");
    expect(await grantsFor(t, "context_console")).toEqual([]);
    expect(await grantsFor(t, "context_cards")).toEqual([]);
  });
});

describe("a switched person", () => {
  test("the plain console apply is refused by the guard, and the behind twin writes the active row", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const refused = await captureError(async () => t.mutation(internal.functions.agentGrant.applyConsoleGrant, await consoleArgs(alice, aliceWs)));
    expect(errorCode(refused)).toBe("workspace_switched");
    expect(await grantsFor(t, "context_console")).toEqual([]);

    const { granted, grantId } = await t.mutation(internal.functions.agentGrant.applyConsoleGrantBehind, await consoleArgs(alice, aliceWs));
    expect(granted.length).toBeGreaterThan(0);
    expect(await grantRow(t, grantId)).toMatchObject({ status: "active", clientId: "context_console" });
  });

  test("the plain cards apply is refused by the guard, and the behind twin writes the active row", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const refused = await captureError(async () => t.mutation(internal.functions.cardsKey.applyCardsKey, await cardsArgs(alice, aliceWs)));
    expect(errorCode(refused)).toBe("workspace_switched");
    expect(await grantsFor(t, "context_cards")).toEqual([]);

    const { granted, grantId } = await t.mutation(internal.functions.cardsKey.applyCardsKeyBehind, await cardsArgs(alice, aliceWs));
    expect(granted.length).toBeGreaterThan(0);
    expect(await grantRow(t, grantId)).toMatchObject({ status: "active", clientId: "context_cards" });
  });

  test("mintConsoleGrant fails CONNECTION_NOT_KEPT in the test env and leaves its row revoked", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const error = await captureError(() => asUser(t, alice).action(api.functions.agentGrant.mintConsoleGrant, { workspaceId: aliceWs }));
    expect(errorCode(error)).toBe("CONNECTION_NOT_KEPT");
    const rows = await grantsFor(t, "context_console");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("revoked");
  });

  test("mintCardsKey fails CONNECTION_NOT_KEPT in the test env and leaves its row revoked", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const error = await captureError(() => asUser(t, alice).action(api.functions.cardsKey.mintCardsKey, { workspaceId: aliceWs, deviceId: DEVICE }));
    expect(errorCode(error)).toBe("CONNECTION_NOT_KEPT");
    const rows = await grantsFor(t, "context_cards");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("revoked");
  });
});

describe("keepConnection", () => {
  test("a put that answers kept leaves the grant active and sends the object exactly one row for it", async () => {
    const { t, alice, aliceWs } = await world();
    const grantId = await switchedConsoleGrant(t, alice, aliceWs);
    const received: Array<Array<{ grantId?: unknown }>> = [];
    const open = () => async (rows: unknown[]) => {
      received.push(rows as Array<{ grantId?: unknown }>);
      return { kept: 1 };
    };
    await t.action(async (ctx) => keepConnection(ctx, aliceWs, grantId, alice, open));
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0]?.[0]?.grantId).toBe(String(grantId));
    expect((await grantRow(t, grantId))?.status).toBe("active");
  });

  test.each([
    ["an error answer", async () => ({ error: "x" })],
    ["a throw", async (): Promise<unknown> => { throw new Error("object unreachable"); }],
  ])("%s from the object revokes the grant and fails with CONNECTION_NOT_KEPT", async (_name, answer) => {
    const { t, alice, aliceWs } = await world();
    const grantId = await switchedConsoleGrant(t, alice, aliceWs);
    const open = () => answer;
    const error = await captureError(() => t.action(async (ctx) => keepConnection(ctx, aliceWs, grantId, alice, open)));
    expect(errorCode(error)).toBe("CONNECTION_NOT_KEPT");
    expect((await grantRow(t, grantId))?.status).toBe("revoked");
  });
});

describe("objectPair", () => {
  test("both tokens name the person object, and two calls give different tokens", async () => {
    const { aliceWs } = await world();
    const pair = objectPair(aliceWs);
    expect(parseToken(pair.accessToken)).toEqual({ format: "object", kind: "access", personalWorkspaceId: String(aliceWs) });
    expect(parseToken(pair.refreshToken)).toEqual({ format: "object", kind: "refresh", personalWorkspaceId: String(aliceWs) });
    const again = objectPair(aliceWs);
    expect(again.accessToken).not.toBe(pair.accessToken);
    expect(again.refreshToken).not.toBe(pair.refreshToken);
  });
});

describe("the Tex job carve-out", () => {
  test.each(TEX_JOB_CLIENTS)("%s's grant is written for a switched person, through the guard", async (clientId) => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    await runTexJob(t, clientId, alice, aliceWs);
    expect(await grantsFor(t, clientId)).toHaveLength(1);
  });

  test("the same write for claude is refused for a switched person and leaves no row", async () => {
    const { t, alice, aliceWs } = await world();
    await switchPerson(t, aliceWs);
    const error = await captureError(() => runTexJob(t, "claude", alice, aliceWs));
    expect(errorCode(error)).toBe("workspace_switched");
    expect(await grantsFor(t, "claude")).toEqual([]);
  });
});

describe("the control-plane client lists", () => {
  test("CONVEX_ONLY_CLIENTS and CONTROL_PLANE_CLIENTS hold exactly the same strings", () => {
    expect([...CONVEX_ONLY_CLIENTS].sort()).toEqual([...CONTROL_PLANE_CLIENTS].sort());
    expect(CONVEX_ONLY_CLIENTS.size).toBe(CONTROL_PLANE_CLIENTS.size);
    for (const clientId of TEX_JOB_CLIENTS) expect(CONVEX_ONLY_CLIENTS.has(clientId)).toBe(true);
  });
});
