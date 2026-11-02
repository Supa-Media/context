/**
 * The copy of access into the objects (`functions/accessObjects.ts`,
 * `functions/accessObjectsExpected.ts`, `functions/lib/accessObjects/`;
 * decided by the owner, 2026-11-01; plan "Access lives in the objects").
 *
 * The contract is `apps/mcp/src/workspaceStore/access.js`: every row Convex
 * writes must pass its `check*Row`, and both sides compare with its
 * `accessDigest`. Invites and connections carry hashes, never a plaintext
 * token.
 *
 * Sabotage, each confirmed to fail a case here: make the last snapshot chunk
 * always `last: true` (the rows after it are never dropped), let a difference
 * count without being asked again, and set a person object's switch without
 * pinning its person first.
 */

import { describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import { accessDigest, checkConnectionRow, checkInviteRow, checkMemberRow, checkReachRow } from "../../mcp/src/workspaceStore/access.js";
import { writeTable, compareTables, type Expected, type TableParity } from "../functions/accessObjects";
import { accessDoor, type AccessDoor, type AccessTableDoor } from "../functions/lib/accessObjects/door";
import { hashToken } from "../functions/lib/crypto";

const NOW = 1_000_000;
const DAY = 24 * 60 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const hex = (char: string) => char.repeat(64);

/** A user with an account and, when asked, a personal workspace they own. */
async function person(t: ReturnType<typeof convexTest>, slug: string, withPersonal = true) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {} as never);
    const personalWorkspaceId = withPersonal
      ? await ctx.db.insert("workspaces", { slug, displayName: slug, createdBy: userId, kind: "personal", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never)
      : null;
    if (personalWorkspaceId !== null) await ctx.db.insert("workspaceMembers", { workspaceId: personalWorkspaceId, userId, role: "owner", joinedAt: 1 } as never);
    return { userId, personalWorkspaceId };
  });
}

/** A table door that records every snapshot call and answers digests from `stored`. */
function fakeDoor(stored: Partial<Record<string, unknown[]>> = {}) {
  const calls: { table: string; epoch: number; rows: unknown[]; last: boolean; mode: string }[] = [];
  const door = {
    table: (name: string) => ({
      snapshot: async (input: { epoch: number; rows: unknown[]; last: boolean; mode: string }) => {
        calls.push({ table: name, epoch: input.epoch, rows: [...input.rows], last: input.last, mode: input.mode });
        return undefined;
      },
      digest: async () => await accessDigest(name as never, stored[name] ?? []),
    }) as AccessTableDoor,
    setHome: async () => {},
  };
  return { door: door as unknown as AccessDoor, calls, stored };
}

const memberRow = (userId: string, at = NOW) => ({ userId, personalWorkspaceId: `p-${userId}`, role: "member", groups: [], at });

describe("expected rows (accessObjectsExpected)", () => {
  test("membersPageOf: each member with a personal workspace is a checked row; one with none is skipped and counted", async () => {
    const t = convexTest(schema, modules);
    const a = await person(t, "ana");
    const b = await person(t, "ben");
    const c = await person(t, "cy", false);
    const workspaceId = await t.run(async (ctx) => {
      const createdBy = a.userId;
      const workspaceId = await ctx.db.insert("workspaces", { slug: "acme", displayName: "Acme", createdBy, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId, userId: a.userId, role: "editor", joinedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId, userId: b.userId, role: "member", joinedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId, userId: c.userId, role: "member", joinedAt: 1 } as never);
      const groupId = await ctx.db.insert("workspaceGroups", { workspaceId, name: "crew", createdBy, createdAt: 1 } as never);
      await ctx.db.insert("workspaceGroupMembers", { groupId, workspaceId, userId: b.userId, addedBy: createdBy, addedAt: 1 } as never);
      return workspaceId;
    });

    const page = await t.query(internal.functions.accessObjectsExpected.membersPageOf, { workspaceId, cursor: null, now: NOW });
    expect(page.next).toBeNull();
    expect(page.skipped).toBe(1);
    expect(page.rows).toHaveLength(2);
    const rows = page.rows as Record<string, unknown>[];
    const rowA = rows.find((row) => row.userId === String(a.userId));
    const rowB = rows.find((row) => row.userId === String(b.userId));
    expect(rowA).toEqual({ userId: String(a.userId), personalWorkspaceId: String(a.personalWorkspaceId), role: "editor", groups: [], at: NOW });
    expect(rowB).toEqual({ userId: String(b.userId), personalWorkspaceId: String(b.personalWorkspaceId), role: "member", groups: ["crew"], at: NOW });
    for (const row of rows) expect(() => checkMemberRow(row)).not.toThrow();
  });

  test("invites: pending and unexpired by email or handle, never the plaintext token; expired and revoked are left out", async () => {
    const t = convexTest(schema, modules);
    const owner = await person(t, "owner-x");
    const token = "live-invite-token-0123456789abcdefghijklmnop";
    const { workspaceId, emailId, nameId } = await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", { slug: "invites-co", displayName: "I", createdBy: owner.userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      const base = { workspaceId, invitedBy: owner.userId, createdAt: 1 };
      const emailId = await ctx.db.insert("workspaceInvitations", { ...base, inviteeKind: "email", invitee: "pat@example.com", role: "editor", token, status: "pending", expiresAt: NOW + DAY } as never);
      const nameId = await ctx.db.insert("workspaceInvitations", { ...base, inviteeKind: "name", invitee: "pat-handle", role: "member", token: "name-token-0123456789abcdefghijklmnopqrstuvw", status: "pending", expiresAt: NOW + DAY } as never);
      await ctx.db.insert("workspaceInvitations", { ...base, inviteeKind: "email", invitee: "old@example.com", role: "member", token: "expired-token-0123456789abcdefghijklmnopqrstu", status: "pending", expiresAt: NOW - 1 } as never);
      await ctx.db.insert("workspaceInvitations", { ...base, inviteeKind: "email", invitee: "gone@example.com", role: "member", token: "revoked-token-0123456789abcdefghijklmnopqrstu", status: "revoked", expiresAt: NOW + DAY } as never);
      return { workspaceId, emailId, nameId };
    });

    const { rows, skipped } = await t.query(internal.functions.accessObjectsExpected.invites, { workspaceId, now: NOW });
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(2);
    const email = (rows as Record<string, unknown>[]).find((row) => row.id === String(emailId))!;
    expect(Object.keys(email).sort()).toEqual(["at", "email", "expiresAt", "id", "invitedBy", "role", "tokenHash"]);
    expect(email).toEqual({ id: String(emailId), email: "pat@example.com", role: "editor", invitedBy: String(owner.userId), expiresAt: NOW + DAY, tokenHash: await hashToken(token), at: NOW });
    expect(email.tokenHash).toMatch(HEX64);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain("expired-token");
    expect(JSON.stringify(rows)).not.toContain("revoked-token");
    for (const row of rows) expect(() => checkInviteRow(row)).not.toThrow();

    const name = (rows as Record<string, unknown>[]).find((row) => row.id === String(nameId))!;
    expect(name.name).toBe("pat-handle");
    expect(name.email).toBeUndefined();
  });

  test("person: active and revoked connections are held, texting and Tex group grants are not; reach lists memberships", async () => {
    const t = convexTest(schema, modules);
    const me = await person(t, "dana");
    const other = await person(t, "eli");
    const { sharedId, grantActive, grantRevoked } = await t.run(async (ctx) => {
      const sharedId = await ctx.db.insert("workspaces", { slug: "shared-team", displayName: "T", createdBy: other.userId, kind: "shared", structureTemplate: "para", createdAt: 1, updatedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId: sharedId, userId: other.userId, role: "owner", joinedAt: 1 } as never);
      await ctx.db.insert("workspaceMembers", { workspaceId: sharedId, userId: me.userId, role: "member", joinedAt: 1 } as never);
      await ctx.db.insert("oauthClients", { clientId: "client_desktop", clientName: "Desktop App", redirectUris: [], hashedClientSecret: null, createdAt: 1 } as never);
      const textGroupId = await ctx.db.insert("textGroups", { groupKey: hex("c"), lastSeenAt: 1 } as never);
      const base = { userId: me.userId, workspaceId: me.personalWorkspaceId!, scopes: ["read"], hashedRefreshToken: hex("1"), createdAt: 1 };
      const grantActive = await ctx.db.insert("oauthGrants", { ...base, clientId: "client_desktop", hashedAccessToken: hex("2"), accessTokenExpiresAt: 9_999, status: "active", lastUsedAt: 5 } as never);
      const grantRevoked = await ctx.db.insert("oauthGrants", { ...base, clientId: "client_desktop", hashedRefreshToken: hex("3"), status: "revoked", revokedAt: 3 } as never);
      await ctx.db.insert("oauthGrants", { ...base, clientId: "context_texts", hashedAccessToken: hex("4"), accessTokenExpiresAt: 9_999, status: "active" } as never);
      await ctx.db.insert("oauthGrants", { ...base, clientId: "client_desktop", hashedRefreshToken: hex("5"), status: "active", texGroup: { groupId: textGroupId, coViewerIds: [], meterWorkspaceId: me.personalWorkspaceId! } } as never);
      return { sharedId, grantActive, grantRevoked };
    });

    const result = await t.query(internal.functions.accessObjectsExpected.person, { userId: me.userId, now: NOW });

    const connections = result.connections.rows as Record<string, unknown>[];
    expect(result.connections.skipped).toBe(0);
    expect(connections.map((row) => row.grantId).sort()).toEqual([String(grantActive), String(grantRevoked)].sort());
    const active = connections.find((row) => row.grantId === String(grantActive))!;
    expect(active).toEqual({
      grantId: String(grantActive),
      clientId: "client_desktop",
      clientName: "Desktop App",
      workspaceId: String(me.personalWorkspaceId),
      scopes: ["read"],
      tokenHash: hex("2"),
      refreshHash: hex("1"),
      previousRefreshHash: null,
      expiresAt: 9_999,
      status: "active",
      lastUsedAt: 5,
      at: NOW,
    });
    const revoked = connections.find((row) => row.grantId === String(grantRevoked))!;
    expect(revoked.status).toBe("revoked");
    expect(revoked.tokenHash).toBeNull();
    expect(revoked.expiresAt).toBe(0);
    expect(revoked.clientName).toBe("Desktop App");
    for (const row of connections) expect(() => checkConnectionRow(row)).not.toThrow();

    const reach = result.reach.rows as Record<string, unknown>[];
    expect(reach.map((row) => row.slug).sort()).toEqual(["dana", "shared-team"]);
    expect(reach.find((row) => row.slug === "dana")).toEqual({ workspaceId: String(me.personalWorkspaceId), slug: "dana", kind: "personal", role: "owner", groups: [], pinned: false, at: NOW });
    expect(reach.find((row) => row.workspaceId === String(sharedId))).toEqual({ workspaceId: String(sharedId), slug: "shared-team", kind: "shared", role: "member", groups: [], pinned: false, at: NOW });
    for (const row of reach) expect(() => checkReachRow(row)).not.toThrow();
  });
});

describe("pure helpers", () => {
  test("writeTable: no rows is one empty last snapshot; 2500 rows are three chunks under one epoch, only the last marked", async () => {
    const empty = fakeDoor();
    await writeTable(empty.door, "members", [], 7);
    expect(empty.calls).toEqual([{ table: "members", epoch: 7, rows: [], last: true, mode: "replace" }]);

    const many = fakeDoor();
    const rows = Array.from({ length: 2500 }, (_, index) => memberRow(`u${index}`));
    await writeTable(many.door, "members", rows, 9);
    expect(many.calls.map((call) => call.rows.length)).toEqual([1000, 1000, 500]);
    expect(many.calls.map((call) => call.epoch)).toEqual([9, 9, 9]);
    expect(many.calls.map((call) => call.last)).toEqual([false, false, true]);
    expect(many.calls.every((call) => call.mode === "replace")).toBe(true);
    expect(many.calls.flatMap((call) => call.rows)).toEqual(rows);
  });
});

describe("compareTables", () => {
  const expected = (members: unknown[]): Expected => ({ tables: { members, invites: [] }, skipped: 0 });

  test("equal rows: every table matches and the wait is never called", async () => {
    const rows = [memberRow("u1"), memberRow("u2")];
    const { door } = fakeDoor({ members: rows, invites: [] });
    const wait = vi.fn(async () => {});
    const read = vi.fn(async () => expected(rows));
    const results = await compareTables("workspace", read, door, { recheckMs: 5000, wait });
    expect(results.every((result: TableParity) => result.match)).toBe(true);
    expect(results.find((result) => result.table === "members")).toEqual({ table: "members", convex: 2, object: 2, match: true });
    expect(wait).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("differing rows: the wait is called once with recheckMs and both sides are read again", async () => {
    const { door } = fakeDoor({ members: [memberRow("u1")], invites: [] });
    const wait = vi.fn(async () => {});
    const read = vi.fn(async () => expected([memberRow("u1"), memberRow("u2")]));
    const results = await compareTables("workspace", read, door, { recheckMs: 5000, wait });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(5000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(results.find((result) => result.table === "members")).toEqual({ table: "members", convex: 2, object: 1, match: false });
    expect(results.find((result) => result.table === "invites")?.match).toBe(true);
  });

  test("a difference that heals on the second read counts as a match", async () => {
    const stored: Partial<Record<string, unknown[]>> = { members: [], invites: [] };
    const { door } = fakeDoor(stored);
    const rows = [memberRow("u1")];
    // The mirrored change lands while the check waits.
    const wait = vi.fn(async () => {
      stored.members = [...rows];
    });
    const read = vi.fn(async () => expected(rows));
    const results = await compareTables("workspace", read, door, { recheckMs: 5000, wait });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(results.find((result) => result.table === "members")?.match).toBe(true);
    expect(results.every((result) => result.match)).toBe(true);
  });
});

describe("accessDoor", () => {
  const table = () => ({ snapshot: async () => undefined, digest: async () => ({ count: 0, sha: "" }) });

  test("workspace scope is null without members and invites", () => {
    expect(accessDoor(null, "workspace")).toBeNull();
    expect(accessDoor({}, "workspace")).toBeNull();
    expect(accessDoor({ members: { ...table(), setHome: async () => {} } }, "workspace")).toBeNull();
  });

  test("person scope is null without reach, sharedToMe, connections, pin or setHome", () => {
    expect(accessDoor(null, "person")).toBeNull();
    expect(accessDoor({}, "person")).toBeNull();
    const tables = { reach: table(), sharedToMe: table(), connections: table() };
    expect(accessDoor({ access: tables }, "person")).toBeNull();
    expect(accessDoor({ access: { ...tables, setHome: async () => {} } }, "person")).toBeNull();
    expect(accessDoor({ access: { ...tables, pin: async () => {} } }, "person")).toBeNull();
  });

  test("person setHome(object) pins the person before switching; the pin is never skipped", async () => {
    const log: string[] = [];
    const tables = { reach: table(), sharedToMe: table(), connections: table() };
    const client = {
      access: {
        ...tables,
        pin: async (userId: string) => {
          log.push(`pin:${userId}`);
        },
        setHome: async (home: string) => {
          log.push(`setHome:${home}`);
        },
      },
    };
    const door = accessDoor(client, "person")!;
    await door.setHome("object", "u1");
    expect(log).toEqual(["pin:u1", "setHome:object"]);

    await expect(door.setHome("object", null)).rejects.toThrow();
    expect(log).toEqual(["pin:u1", "setHome:object"]);

    log.length = 0;
    await door.setHome("convex", null);
    expect(log).toEqual(["setHome:convex"]);
  });
});

describe("objectRefusal: the object decides only after a clean, fresh, complete check", () => {
  const all = (match: boolean) => ["reach", "sharedToMe", "connections"].map((table) => ({ table, convex: 1, object: 1, match }));
  const NOW_MS = 10_000_000;
  test("each missing step refuses, in order", async () => {
    const { objectRefusal } = await import("../functions/accessObjects");
    expect(objectRefusal({ home: "convex", backfilledAt: 1, parity: { at: NOW_MS, tables: all(true) } }, "person", NOW_MS)).toBe("NOT_ARMED");
    expect(objectRefusal({ home: "dual", parity: { at: NOW_MS, tables: all(true) } }, "person", NOW_MS)).toBe("NOT_BACKFILLED");
    expect(objectRefusal({ home: "dual", backfilledAt: 1 }, "person", NOW_MS)).toBe("PARITY_STALE");
    expect(objectRefusal({ home: "dual", backfilledAt: 1, parity: { at: NOW_MS - 61 * 60 * 1000, tables: all(true) } }, "person", NOW_MS)).toBe("PARITY_STALE");
    expect(objectRefusal({ home: "dual", backfilledAt: 1, parity: { at: NOW_MS, tables: all(false) } }, "person", NOW_MS)).toBe("PARITY_DIFFERS");
    // A check that left a table out is not a clean check of the scope.
    expect(objectRefusal({ home: "dual", backfilledAt: 1, parity: { at: NOW_MS, tables: all(true).slice(1) } }, "person", NOW_MS)).toBe("PARITY_DIFFERS");
    expect(objectRefusal({ home: "dual", backfilledAt: 1, parity: { at: NOW_MS, tables: all(true) } }, "person", NOW_MS)).toBeNull();
    expect(objectRefusal({ home: "dual", backfilledAt: 1, parity: { at: NOW_MS, tables: all(true) } }, "workspace", NOW_MS)).toBe("PARITY_DIFFERS");
  });
});
