import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";

/**
 * THE VAULT'S HUMAN HALF. An agent can ask for a link; only the person whose
 * grant asked, signed in, can spend it, once, and a share names a member of
 * the workspace (decided by the owner, 2026-10-10).
 */

type T = ReturnType<typeof setupTest>;
const ENTRY = "v0123456789abcdef01234567";

async function claimHandle(t: T, userId: Id<"users">, name: string) {
  await t.run((ctx) => ctx.db.insert("names", { name, kind: "user", userId, claimedBy: userId, claimedAt: Date.now() }));
}

async function world(t: T) {
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  const stranger = await createUser(t, "stranger@example.test");
  await claimHandle(t, sayo, "sayo");
  await claimHandle(t, stranger, "stranger");
  const team = await createWorkspace(t, seyi, "team-vault", { kind: "shared" });
  await addMember(t, team, sayo, "member", seyi);
  const personal = await createWorkspace(t, seyi, "seyi-vault", { kind: "personal" });
  return { seyi, sayo, stranger, team, personal };
}

async function issue(t: T, args: { workspaceId: Id<"workspaces">; userId: Id<"users">; kind: "add" | "share"; entryId?: string; handle?: string }, token = "tok-" + Math.random()) {
  const status = await t.mutation(internal.functions.vault.issueVaultRequest, { ...args, hashedToken: await hashToken(token) });
  return { status, token };
}

describe("asking for a vault link", () => {
  test("a share names a member of a shared workspace, never a stranger or a personal login", async () => {
    const t = setupTest();
    const w = await world(t);
    expect((await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId: ENTRY, handle: "sayo" })).status).toBe("issued");
    expect((await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId: ENTRY, handle: "stranger" })).status).toBe("refused");
    expect((await issue(t, { workspaceId: w.personal, userId: w.seyi, kind: "share", entryId: ENTRY, handle: "sayo" })).status).toBe("refused");
    expect((await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId: "../x", handle: "sayo" })).status).toBe("refused");
  });

  test("a request row holds ids and times, nothing of a login", async () => {
    const t = setupTest();
    const w = await world(t);
    await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    const rows = await t.run((ctx) => ctx.db.query("vaultRequests").collect());
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["_creationTime", "_id", "expiresAt", "hashedToken", "kind", "userId", "workspaceId"].sort(),
    );
  });
});

describe("spending a vault link", () => {
  test("only the person who asked can spend it, and only once", async () => {
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId: ENTRY, handle: "sayo" });
    const hashedToken = await hashToken(token);
    // Sayo is the grantee, and still cannot confirm a share of a login to herself.
    expect(errorCode(await captureError(() => t.mutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId: w.sayo, kind: "share" })))).toBe("VAULT_LINK_NOT_YOURS");
    const spent = await t.mutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId: w.seyi, kind: "share" });
    expect(spent.granteeUserId).toBe(w.sayo);
    expect(errorCode(await captureError(() => t.mutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId: w.seyi, kind: "share" })))).toBe("VAULT_LINK_DEAD");
  });

  test("an expired link, or one whose grantee has left, is dead", async () => {
    const t = setupTest();
    const w = await world(t);
    const expired = await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("vaultRequests").collect())[0];
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    const expiredHash = await hashToken(expired.token);
    expect(errorCode(await captureError(() => t.mutation(internal.functions.vault.consumeVaultRequest, { hashedToken: expiredHash, userId: w.seyi, kind: "add" })))).toBe("VAULT_LINK_DEAD");

    const share = await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId: ENTRY, handle: "sayo" });
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", w.team).eq("userId", w.sayo))
        .unique();
      await ctx.db.delete(membership!._id);
    });
    expect(errorCode(await captureError(() => hashToken(share.token).then((hashedToken) => t.mutation(internal.functions.vault.consumeVaultRequest, { hashedToken, userId: w.seyi, kind: "share" }))))).toBe("VAULT_LINK_DEAD");
  });

  test("the page refuses a signed-out visitor and anyone but the person who asked", async () => {
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    expect(errorCode(await captureError(() => t.action(api.functions.vault.describeVaultRequest, { token })))).toBe("NOT_AUTHENTICATED");
    expect(errorCode(await captureError(() => asUser(t, w.sayo).action(api.functions.vault.describeVaultRequest, { token })))).toBe("VAULT_LINK_NOT_YOURS");
    const described = await asUser(t, w.seyi).action(api.functions.vault.describeVaultRequest, { token });
    expect(described.kind).toBe("add");
    expect(described.workspace.handle).toBe("team-vault");
    expect(errorCode(await captureError(() => asUser(t, w.sayo).action(api.functions.vault.saveVaultLogin, { token, name: "Netflix", site: "netflix.com", username: "u", password: "p" })))).toBe("VAULT_LINK_NOT_YOURS");
  });
});
