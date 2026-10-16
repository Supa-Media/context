import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";

/**
 * Settings › Vault (vault board 2): a person sees the keys given to them in a
 * workspace, with the one website each goes to and the AIs they said yes to,
 * and can cut an AI off. Never a value; never a key they were not given; never
 * a workspace they are not in.
 */

const VALUE = "fake-settings-value-0000001";
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  const stranger = await createUser(t, "stranger@example.test");
  const team = await createWorkspace(t, seyi, "team-vault", { kind: "shared" });
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
  return { t, seyi, sayo, stranger, team, backend };
}
type W = Awaited<ReturnType<typeof world>>;

async function save(w: W, name: string, proxy?: Record<string, unknown>) {
  const { token } = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "add" });
  await asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, {
    token,
    type: "secret",
    name,
    site: "",
    fields: [{ name: "KEY", perEnv: true, values: { dev: VALUE, prod: VALUE } }],
    ...(proxy ? { proxy } : {}),
  } as never);
}

/** Write a "yes" for an AI straight into the key, as the gateway's ask does. */
async function sayYes(w: W, clientId: string, name: string) {
  const listed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
  const entryId = listed.find((e: { proxy: unknown }) => e.proxy !== null)!.entryId;
  const { storeForBinding } = await import("../../mcp/src/store/factory.js");
  const { readMeta, writeMeta } = await import("../../mcp/src/vault/entries.js");
  const credential = await w.t.action(internal.functions.storage.getBindingForGateway, { workspaceId: w.team });
  const store = storeForBinding(credential!, undefined, {});
  const keys = await w.t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: w.team, create: false });
  const meta = (await readMeta(store, keys, String(w.team), entryId)) as { proxy: Record<string, unknown> };
  await writeMeta(store, keys, String(w.team), entryId, {
    ...meta,
    proxy: { ...meta.proxy, clients: [{ id: clientId, name, at: 1 }], once: [{ id: clientId, until: Date.now() + 60_000 }] },
  });
  return entryId;
}

describe("the vault list in Settings", () => {
  test("shows each key's name, website and environments, never a value", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    await save(w, "Webhook secret");
    const listed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(listed.map((e: { name: string }) => e.name)).toEqual(["Stripe", "Webhook secret"]);
    expect(listed[0].proxy).toMatchObject({ host: "api.stripe.com", style: "bearer", ask: true, clients: [] });
    expect(listed[0].envs).toEqual(["dev", "prod"]);
    expect(listed[1].proxy).toBeNull();
    expect(JSON.stringify(listed).includes(VALUE)).toBe(false);
  });

  test("a member sees only keys given to them, and a stranger sees no workspace", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    expect(await asUser(w.t, w.sayo).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team })).toEqual([]);
    const error = await captureError(() => asUser(w.t, w.stranger).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team }));
    expect(errorCode(error)).toBe("WORKSPACE_NOT_FOUND");
  });

  test("lists the AIs said yes to, and keeps the one-time grants inside the key", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    await sayYes(w, "client_claude", "Claude Code");
    const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(entry.proxy!.clients).toEqual([{ id: "client_claude", name: "Claude Code", at: 1 }]);
    expect(JSON.stringify(entry).includes("until")).toBe(false);
  });

  test("Cut off removes one AI, and every AI with no client named, and is audited", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    const entryId = await sayYes(w, "client_claude", "Claude Code");
    const cut = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.cutOffVaultAI, { workspaceId: w.team, entryId, clientId: "client_other" });
    expect(cut.proxy!.clients).toHaveLength(1);
    const all = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.cutOffVaultAI, { workspaceId: w.team, entryId });
    expect(all.proxy!.clients).toEqual([]);
    const audit = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((row) => (row as { action?: string }).action === "vault.cut_off")).toBe(true);
  });

  test("someone not given the key can't cut its AIs off", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    const entryId = await sayYes(w, "client_claude", "Claude Code");
    const error = await captureError(() => asUser(w.t, w.sayo).action(api.functions.vaultSettings.cutOffVaultAI, { workspaceId: w.team, entryId }));
    expect(errorCode(error)).toBe("INVALID_ARGUMENT");
    const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(entry.proxy!.clients).toHaveLength(1);
  });

  test("New key is for editors and owners; a view link is made for the person and still checked when revealed", async () => {
    const w = await world();
    const refused = await captureError(() => asUser(w.t, w.sayo).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "add" }));
    expect(errorCode(refused)).toBe("FORBIDDEN");
    await save(w, "Stripe");
    const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    const { token } = await asUser(w.t, w.sayo).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "view", entryId: entry.entryId });
    const reveal = await captureError(() => asUser(w.t, w.sayo).action(api.functions.vault.revealVaultEntry, { token }));
    expect(reveal).not.toBeNull();
    const own = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "view", entryId: entry.entryId });
    const shown = await asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token: own.token });
    expect(shown.fields[0].values.prod).toBe(VALUE);
  });

  test("says each AI's uses and last call, who was told no, who waits, and who saved it", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    const entryId = await sayYes(w, "client_claude", "Claude Code");
    const { store, keys } = await bucket(w);
    const { readMeta, writeMeta } = await import("../../mcp/src/vault/entries.js");
    const meta = (await readMeta(store, keys, String(w.team), entryId)) as { proxy: Record<string, unknown> };
    await writeMeta(store, keys, String(w.team), entryId, {
      ...meta,
      proxy: {
        ...meta.proxy,
        uses: [{ id: "client_claude", name: "Claude Code", count: 31, at: 5, method: "GET", path: "/v1/customers" }],
        refused: [{ id: "client_gpt", name: "ChatGPT", at: 4 }],
      },
    });
    const ask = (clientId: string, userId: string, expiresAt: number) =>
      JSON.stringify({ id: `ask-${clientId}-${userId}`, kind: "vault_use", entry_id: entryId, actor: { userId, clientId }, expires_at: expiresAt });
    await store.put(".context/approvals/pending/a.json", ask("client_codex", String(w.seyi), Date.now() + 60_000));
    await store.put(".context/approvals/pending/b.json", ask("client_old", String(w.seyi), Date.now() - 1));
    await store.put(".context/approvals/pending/c.json", ask("client_x", String(w.sayo), Date.now() + 60_000));
    const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(entry.proxy!.uses).toEqual([{ id: "client_claude", name: "Claude Code", count: 31, at: 5, method: "GET", path: "/v1/customers" }]);
    expect(entry.proxy!.refused).toEqual([{ id: "client_gpt", name: "ChatGPT", at: 4 }]);
    expect(entry.proxy!.waiting).toBe(1);
    expect(entry.savedByYou).toBe(true);
    expect(entry.savedAt).toBeGreaterThan(0);
  });

  test("Allow lets an AI the person said no to use the key, and is audited", async () => {
    const w = await world();
    await save(w, "Stripe", { host: "api.stripe.com", style: "bearer", ask: true });
    const entryId = await sayYes(w, "client_claude", "Claude Code");
    const { store, keys } = await bucket(w);
    const { readMeta, writeMeta } = await import("../../mcp/src/vault/entries.js");
    const meta = (await readMeta(store, keys, String(w.team), entryId)) as { proxy: Record<string, unknown> };
    await writeMeta(store, keys, String(w.team), entryId, { ...meta, proxy: { ...meta.proxy, refused: [{ id: "client_gpt", name: "ChatGPT", at: 4 }] } });
    const stranger = await captureError(() =>
      asUser(w.t, w.sayo).action(api.functions.vaultSettings.allowVaultAI, { workspaceId: w.team, entryId, clientId: "client_gpt" }),
    );
    expect(errorCode(stranger)).toBe("INVALID_ARGUMENT");
    const allowed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.allowVaultAI, { workspaceId: w.team, entryId, clientId: "client_gpt" });
    expect(allowed.proxy!.clients.map((client: { id: string }) => client.id)).toEqual(["client_claude", "client_gpt"]);
    expect(allowed.proxy!.refused).toEqual([]);
    const unknown = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.allowVaultAI, { workspaceId: w.team, entryId, clientId: "client_never_asked" });
    expect(unknown.proxy!.clients).toHaveLength(2);
    const audit = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((row) => (row as { action?: string }).action === "vault.allowed")).toBe(true);
  });
});

/** The workspace's bucket and data key, as the gateway opens them. */
async function bucket(w: W) {
  const { storeForBinding } = await import("../../mcp/src/store/factory.js");
  const credential = await w.t.action(internal.functions.storage.getBindingForGateway, { workspaceId: w.team });
  const store = storeForBinding(credential!, undefined, {});
  const keys = await w.t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: w.team, create: false });
  return { store, keys };
}
