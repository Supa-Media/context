import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";

/**
 * A VAULT LINK IS SPENT BY A WRITE THAT LANDED, NOT BY A PRESS.
 *
 * The link is one-use, and it used to be spent before the bucket write: a
 * storage hiccup left the person with a spent link and nothing saved, and
 * their retry was told the link had expired. Now the link is checked, the
 * entry written, and only then spent, so a failed write is a "try again" on
 * the same link, and a second save after a good one is still refused.
 */

type T = ReturnType<typeof setupTest>;
const SAVE = { name: "Netflix", site: "netflix.com", username: "ada@example.test", password: "fake-password-1" };

afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  await t.run((ctx) => ctx.db.insert("names", { name: "sayo", kind: "user", userId: sayo, claimedBy: sayo, claimedAt: Date.now() }));
  const team = await createWorkspace(t, seyi, "team-retry", { kind: "shared" });
  await addMember(t, team, sayo, "member", seyi);
  const bucket = { refusing: false };
  const backend = memoryS3(FAKE_STORAGE.bucket, {
    refuseWrite: (key) => bucket.refusing && key.startsWith(".context/vault/"),
  });
  vi.stubGlobal("fetch", backend.fetchImpl);
  await seedStorageBinding(t, {
    workspaceId: team,
    boundBy: seyi,
    status: "connected",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  });
  const vaultKeys = () => [...backend.objects.keys()].filter((key) => key.startsWith(".context/vault/"));
  return { t, seyi, sayo, team, bucket, backend, vaultKeys };
}

async function issue(
  t: T,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; kind: "add" | "share"; entryId?: string; handle?: string },
) {
  const token = "tok-" + Math.random();
  expect(await t.mutation(internal.functions.vault.issueVaultRequest, { ...args, hashedToken: await hashToken(token) })).toBe("issued");
  return token;
}

async function audits(t: T, action: string) {
  return (await t.run((ctx) => ctx.db.query("auditEvents").collect())).filter((row) => row.action === action);
}

describe("saving through a vault link", () => {
  test("a failed write leaves the link usable: a reload still describes it, a retry saves, a second save is refused", async () => {
    const w = await world();
    const me = asUser(w.t, w.seyi);
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });

    w.bucket.refusing = true;
    const failed = await captureError(() => me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE }));
    expect(errorCode(failed)).toBe("VAULT_STORAGE_FAILED");
    expect(w.vaultKeys()).toEqual([]);
    expect(await audits(w.t, "vault.saved")).toHaveLength(0);
    // The storage's own words never reach the person.
    expect(JSON.stringify((failed as { data?: unknown }).data)).not.toMatch(/AccessDenied|signature|r2\.cloudflarestorage/i);

    // A reload still opens the page on the same link.
    expect((await me.action(api.functions.vault.describeVaultRequest, { token })).kind).toBe("add");

    w.bucket.refusing = false;
    expect(await me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE })).toEqual({ name: "Netflix", site: "netflix.com" });
    expect(w.vaultKeys()).toHaveLength(1);
    expect(await audits(w.t, "vault.saved")).toHaveLength(1);

    // Spent by the save that landed, and only by that one.
    expect(errorCode(await captureError(() => me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE })))).toBe("VAULT_LINK_DEAD");
    expect(errorCode(await captureError(() => me.action(api.functions.vault.describeVaultRequest, { token })))).toBe("VAULT_LINK_DEAD");
    expect(w.vaultKeys()).toHaveLength(1);
  });

  test("two saves at once spend the link once and write one entry", async () => {
    const w = await world();
    const me = asUser(w.t, w.seyi);
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    const results = await Promise.allSettled([
      me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE }),
      me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(errorCode(refused.reason)).toBe("VAULT_LINK_DEAD");
    expect(w.vaultKeys()).toHaveLength(1);
    expect(await audits(w.t, "vault.saved")).toHaveLength(1);
  });

  test("a retry after a failed write saves to the entry the link reserved, not a second one", async () => {
    const w = await world();
    const me = asUser(w.t, w.seyi);
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    w.bucket.refusing = true;
    await captureError(() => me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE }));
    const [reserved] = await w.t.run((ctx) => ctx.db.query("vaultRequests").collect());
    expect(reserved.entryId).toMatch(/^v[0-9a-f]{24}$/);
    expect(reserved.usedAt).toBeUndefined();
    w.bucket.refusing = false;
    await me.action(api.functions.vault.saveVaultLogin, { token, ...SAVE });
    expect(w.vaultKeys()).toEqual([`.context/vault/${reserved.entryId}.json`]);
  });
});

describe("the entry an add link writes", () => {
  test("is never somebody else's: a row naming another person's entry overwrites nothing", async () => {
    const w = await world();
    await asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, {
      token: await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" }),
      ...SAVE,
    });
    const [key] = w.vaultKeys();
    const before = w.backend.snapshot()[key];
    const seyisEntry = /(v[0-9a-f]{24})\.json$/.exec(key)![1];

    // Sayo's add link, pointed at Seyi's entry: no code path writes this, so
    // the row is forged directly, as a future change could forge it.
    const token = await issue(w.t, { workspaceId: w.team, userId: w.sayo, kind: "add" });
    await w.t.run(async (ctx) => {
      const row = (await ctx.db.query("vaultRequests").collect()).find((r) => r.userId === w.sayo)!;
      await ctx.db.patch(row._id, { entryId: seyisEntry });
    });
    const sayo = asUser(w.t, w.sayo);
    const refused = await captureError(() => sayo.action(api.functions.vault.saveVaultLogin, { token, ...SAVE, password: "fake-takeover" }));
    expect(errorCode(refused)).toBe("VAULT_LINK_DEAD");
    expect(w.backend.snapshot()[key]).toBe(before);
    expect(w.vaultKeys()).toEqual([key]);
  });
});

describe("sharing through a vault link", () => {
  test("a failed write leaves the share link usable, and it is spent by the share that lands", async () => {
    const w = await world();
    const me = asUser(w.t, w.seyi);
    await me.action(api.functions.vault.saveVaultLogin, { token: await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" }), ...SAVE });
    const entryId = /(v[0-9a-f]{24})\.json$/.exec(w.vaultKeys()[0])![1];
    const token = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "share", entryId, handle: "sayo" });

    w.bucket.refusing = true;
    expect(errorCode(await captureError(() => me.action(api.functions.vault.confirmVaultShare, { token })))).toBe("VAULT_STORAGE_FAILED");
    expect(await audits(w.t, "vault.shared")).toHaveLength(0);
    expect((await me.action(api.functions.vault.describeVaultRequest, { token })).kind).toBe("share");

    w.bucket.refusing = false;
    expect(await me.action(api.functions.vault.confirmVaultShare, { token })).toEqual({ name: "Netflix", grantee: "sayo" });
    expect(await audits(w.t, "vault.shared")).toHaveLength(1);
    expect(errorCode(await captureError(() => me.action(api.functions.vault.confirmVaultShare, { token })))).toBe("VAULT_LINK_DEAD");
  });
});
