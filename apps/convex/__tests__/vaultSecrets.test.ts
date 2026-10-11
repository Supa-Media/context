import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";

/**
 * SECRETS AND ENV VARIABLES. A person saves named fields, most with one
 * value each for dev, staging and prod (decided by the owner, 2026-10-10),
 * and sees them only on a page an agent can ask for and never open.
 */

type T = ReturnType<typeof setupTest>;
const DEV = "sk_test_fake_dev_0000";
const PROD = "sk_live_fake_prod_9999";

afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  const team = await createWorkspace(t, seyi, "team-secrets", { kind: "shared" });
  await addMember(t, team, sayo, "member", seyi);
  const backend = memoryS3(FAKE_STORAGE.bucket);
  vi.stubGlobal("fetch", backend.fetchImpl);
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId: team });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: team,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: seyi,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { t, seyi, sayo, team, backend };
}

async function issue(t: T, args: { workspaceId: Id<"workspaces">; userId: Id<"users">; kind: "add" | "share" | "view"; entryId?: string }) {
  const token = "tok-" + Math.random();
  const status = await t.mutation(internal.functions.vault.issueVaultRequest, { ...args, hashedToken: await hashToken(token) });
  return { status, token };
}

async function saveStripe(w: Awaited<ReturnType<typeof world>>) {
  const { token } = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
  await asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, {
    token,
    type: "secret",
    name: "Stripe",
    site: "",
    fields: [
      { name: "STRIPE_SECRET_KEY", perEnv: true, values: { dev: DEV, staging: "", prod: PROD } },
      { name: "Account number", perEnv: false, values: { _: "acct_fake_42" } },
    ],
  });
  const keys = [...w.backend.objects.keys()].filter((key) => key.startsWith(".context/vault/"));
  expect(keys).toHaveLength(1);
  return /\.context\/vault\/(v[0-9a-f]{24})\.json$/.exec(keys[0])![1];
}

describe("a secret with values per environment", () => {
  test("is saved sealed: the bucket holds no value and no field name", async () => {
    const w = await world();
    await saveStripe(w);
    const raw = JSON.stringify(w.backend.snapshot());
    for (const plain of [DEV, PROD, "acct_fake_42", "STRIPE_SECRET_KEY", "Stripe"]) expect(raw.includes(plain)).toBe(false);
  });

  test("a view page names fields without values, and only a reveal by the person who asked shows them", async () => {
    const w = await world();
    const entryId = await saveStripe(w);
    const { token, status } = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "view", entryId });
    expect(status).toBe("issued");

    const described = await asUser(w.t, w.seyi).action(api.functions.vault.describeVaultRequest, { token });
    expect(described.entry).toMatchObject({ type: "secret", name: "Stripe", sites: [] });
    expect(described.entry?.fields).toEqual([
      { name: "STRIPE_SECRET_KEY", perEnv: true, set: ["dev", "prod"] },
      { name: "Account number", perEnv: false, set: ["_"] },
    ]);
    expect(JSON.stringify(described).includes(DEV)).toBe(false);

    expect(errorCode(await captureError(() => asUser(w.t, w.sayo).action(api.functions.vault.revealVaultEntry, { token })))).toBe("VAULT_LINK_NOT_YOURS");
    expect(errorCode(await captureError(() => w.t.action(api.functions.vault.revealVaultEntry, { token })))).toBe("NOT_AUTHENTICATED");

    // Not spent by a look: the person can come back to it while it lives.
    for (let i = 0; i < 2; i += 1) {
      const shown = await asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token });
      expect(shown.fields[0]).toEqual({ name: "STRIPE_SECRET_KEY", perEnv: true, values: { dev: DEV, prod: PROD } });
      expect(shown.fields[1].values).toEqual({ _: "acct_fake_42" });
    }
    const audits = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audits.filter((row) => row.action === "vault.viewed")).toHaveLength(2);
  });

  test("a member it was never given cannot have a view link made for it", async () => {
    const w = await world();
    const entryId = await saveStripe(w);
    const { token } = await issue(w.t, { workspaceId: w.team, userId: w.sayo, kind: "view", entryId });
    expect(errorCode(await captureError(() => asUser(w.t, w.sayo).action(api.functions.vault.describeVaultRequest, { token })))).toBe("VAULT_LINK_DEAD");
    expect(errorCode(await captureError(() => asUser(w.t, w.sayo).action(api.functions.vault.revealVaultEntry, { token })))).toBe("VAULT_LINK_DEAD");
  });

  test("an expired view link, or an add link, reveals nothing", async () => {
    const w = await world();
    const entryId = await saveStripe(w);
    const view = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "view", entryId });
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query("vaultRequests").collect()) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(errorCode(await captureError(() => asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token: view.token })))).toBe("VAULT_LINK_DEAD");
    const add = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
    expect(errorCode(await captureError(() => asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token: add.token })))).toBe("VAULT_LINK_DEAD");
    expect((await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "view", entryId: "../x" })).status).toBe("refused");
  });

  test("a secret needs a value, and a field named twice is refused", async () => {
    const w = await world();
    for (const fields of [[{ name: "K", perEnv: true, values: { dev: "" } }], [{ name: "K", perEnv: false, values: { _: "1" } }, { name: "k", perEnv: false, values: { _: "2" } }]]) {
      const { token } = await issue(w.t, { workspaceId: w.team, userId: w.seyi, kind: "add" });
      expect(errorCode(await captureError(() => asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, { token, type: "secret", name: "X", site: "", fields })))).toBe("INVALID_ARGUMENT");
    }
  });
});
