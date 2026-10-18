import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";

/**
 * Giving a vault key (the vault sharing boards, 2026-10-17; the owner: "make
 * sure we can share with groups, people or the whole workspace"). A key is
 * given to a person, a group or everyone in a shared workspace, for their AIs
 * to use or for them to see too; taking it back takes their AIs with it.
 *
 * Sabotage record (each broken by hand, the named test failed, then restored):
 *  - `mayManage` answering true for anybody who may use the key → "somebody
 *    given a key for their AIs can't pass it on" fails.
 *  - `takeKey` skipping `pruneRecords` → "taking a key back takes that
 *    person's AIs with it" fails.
 *  - the group-owner check removed from `giveVaultKey` → "a group is given a
 *    key by an owner only" fails.
 */

const VALUE = "fake-sharing-value-0000002";
afterEach(() => vi.unstubAllGlobals());

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  const kola = await createUser(t, "kola@example.test");
  const editor = await createUser(t, "editor@example.test");
  const stranger = await createUser(t, "stranger@example.test");
  const team = await createWorkspace(t, seyi, "team-sharing", { kind: "shared" });
  await addMember(t, team, sayo, "member", seyi);
  await addMember(t, team, kola, "member", seyi);
  await addMember(t, team, editor, "editor", seyi);
  const leads = await t.run(async (ctx) => {
    const now = Date.now();
    const group = await ctx.db.insert("workspaceGroups", { workspaceId: team, name: "team-sharing-leads", createdBy: seyi, createdAt: now });
    await ctx.db.insert("workspaceGroupMembers", { groupId: group, workspaceId: team, userId: sayo, addedBy: seyi, addedAt: now });
    return group;
  });
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
  const { token } = await asUser(t, seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: team, kind: "add" });
  await asUser(t, seyi).action(api.functions.vault.saveVaultLogin, {
    token,
    type: "secret",
    name: "Convex read-only",
    site: "",
    fields: [{ name: "KEY", perEnv: false, values: { _: VALUE } }],
    proxy: { host: "api.convex.example", style: "bearer", ask: true },
  } as never);
  const [entry] = await asUser(t, seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: team });
  return { t, seyi, sayo, kola, editor, stranger, team, leads, entryId: entry.entryId as string };
}
type W = Awaited<ReturnType<typeof world>>;

const listed = (w: W, who: Id<"users">) => asUser(w.t, who).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
const give = (w: W, who: Id<"users">, to: string, level: "use" | "see") =>
  asUser(w.t, who).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId: w.entryId, to, level });
const takeBack = (w: W, who: Id<"users">, to: string) =>
  asUser(w.t, who).action(api.functions.vaultSettings.takeBackVaultKey, { workspaceId: w.team, entryId: w.entryId, to });
async function reveal(w: W, who: Id<"users">) {
  const { token } = await asUser(w.t, who).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "view", entryId: w.entryId });
  return await asUser(w.t, who).action(api.functions.vault.revealVaultEntry, { token });
}

/** The key's sealed meta, straight from the bucket. */
async function rawMeta(w: W) {
  const { storeForBinding } = await import("../../mcp/src/store/factory.js");
  const { readMeta, writeMeta } = await import("../../mcp/src/vault/entries.js");
  const credential = await w.t.action(internal.functions.storage.getBindingForGateway, { workspaceId: w.team });
  const store = storeForBinding(credential!, undefined, {});
  const keys = await w.t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: w.team, create: false });
  const read = async () => (await readMeta(store, keys, String(w.team), w.entryId)) as Record<string, any>;
  const write = async (meta: Record<string, unknown>) => writeMeta(store, keys, String(w.team), w.entryId, meta);
  return { read, write };
}

describe("giving a vault key", () => {
  test("given to a person for their AIs, they have it but can't see it", async () => {
    const w = await world();
    expect(await listed(w, w.sayo)).toEqual([]);
    const shown = await give(w, w.seyi, String(w.sayo), "use");
    expect(shown.people.map((row: { kind: string; level: string }) => `${row.kind}:${row.level}`)).toEqual(["person:see", "person:use"]);
    const [theirs] = await listed(w, w.sayo);
    expect(theirs).toMatchObject({ level: "use", manage: false, givenToYou: true, savedByYou: false, people: [] });
    expect(theirs.givenBy).toBe("seyi");
    expect(await captureError(() => reveal(w, w.sayo))).not.toBeNull();
    expect(JSON.stringify(theirs).includes(VALUE)).toBe(false);
  });

  test("given to see, they can open it", async () => {
    const w = await world();
    await give(w, w.seyi, String(w.sayo), "see");
    const shown = await reveal(w, w.sayo);
    expect(shown.fields[0].values._).toBe(VALUE);
  });

  test("a group's key reaches its members only", async () => {
    const w = await world();
    await give(w, w.seyi, "@team-sharing-leads", "use");
    expect(await listed(w, w.sayo)).toHaveLength(1);
    expect(await listed(w, w.kola)).toEqual([]);
    const [own] = await listed(w, w.seyi);
    const group = own.people.find((row: { kind: string }) => row.kind === "group");
    expect(group).toMatchObject({ to: "@team-sharing-leads", count: 1, level: "use" });
  });

  test("a group is given a key by an owner only", async () => {
    const w = await world();
    await give(w, w.seyi, String(w.editor), "see");
    const refused = await captureError(() => give(w, w.editor, "@team-sharing-leads", "use"));
    expect(errorCode(refused)).toBe("FORBIDDEN");
    // An editor who sees it may give it to a person, or to everyone.
    await give(w, w.editor, String(w.kola), "use");
    expect(await listed(w, w.kola)).toHaveLength(1);
  });

  test("everyone means every member, people who join later included", async () => {
    const w = await world();
    await give(w, w.seyi, "*", "use");
    expect(await listed(w, w.kola)).toHaveLength(1);
    const late = await createUser(w.t, "late@example.test");
    await addMember(w.t, w.team, late, "member", w.seyi);
    expect(await listed(w, late)).toHaveLength(1);
    const [own] = await listed(w, w.seyi);
    expect(own.people.find((row: { kind: string }) => row.kind === "everyone")).toMatchObject({ to: "*", count: 5, level: "use" });
    expect(await listed(w, w.stranger).catch((error: unknown) => errorCode(error))).toBe("WORKSPACE_NOT_FOUND");
  });

  test("somebody given a key for their AIs can't pass it on, an editor included", async () => {
    const w = await world();
    await give(w, w.seyi, String(w.sayo), "see");
    await give(w, w.seyi, String(w.editor), "use");
    expect(errorCode(await captureError(() => give(w, w.sayo, String(w.kola), "use")))).toBe("FORBIDDEN");
    expect(errorCode(await captureError(() => give(w, w.editor, String(w.kola), "use")))).toBe("FORBIDDEN");
    expect(errorCode(await captureError(() => takeBack(w, w.editor, String(w.sayo))))).toBe("FORBIDDEN");
    expect(await listed(w, w.kola)).toEqual([]);
  });

  test("only members and the workspace's own groups can be given a key, never in a personal workspace", async () => {
    const w = await world();
    expect(errorCode(await captureError(() => give(w, w.seyi, String(w.stranger), "use")))).toBe("INVALID_ARGUMENT");
    expect(errorCode(await captureError(() => give(w, w.seyi, "@someone-elses-group", "use")))).toBe("INVALID_ARGUMENT");
    expect(errorCode(await captureError(() => give(w, w.seyi, String(w.seyi), "use")))).toBe("INVALID_ARGUMENT");
    const outsider = await captureError(() =>
      asUser(w.t, w.stranger).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId: w.entryId, to: "*", level: "see" }),
    );
    expect(errorCode(outsider)).toBe("WORKSPACE_NOT_FOUND");
    const own = await createWorkspace(w.t, w.seyi, "seyi-own", { kind: "personal" });
    const personal = await captureError(() =>
      asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: own, entryId: w.entryId, to: "*", level: "use" }),
    );
    expect(errorCode(personal)).toBe("FORBIDDEN");
  });

  test("giving is audited by kind and level, never by value", async () => {
    const w = await world();
    await give(w, w.seyi, "@team-sharing-leads", "see");
    const audit = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    const row = audit.find((r) => (r as { action?: string }).action === "vault.shared") as { details?: Record<string, unknown> } | undefined;
    expect(row?.details).toMatchObject({ changed: "a group, see" });
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });
});

describe("taking a vault key back", () => {
  test("taking a key back takes that person's AIs with it, and keeps everyone else's", async () => {
    const w = await world();
    await give(w, w.seyi, String(w.sayo), "use");
    const raw = await rawMeta(w);
    const meta = await raw.read();
    await raw.write({
      ...meta,
      proxy: {
        ...meta.proxy,
        clients: [
          { id: "client_claude", name: "Claude Code", at: 1, by: String(w.seyi) },
          { id: "client_claude", name: "Claude Code", at: 2, by: String(w.sayo) },
        ],
        uses: [{ id: "client_claude", name: "Claude Code", at: 2, count: 3, by: String(w.sayo) }],
      },
    });
    // Before it is taken back, sayo sees only their own AI; the saver sees both.
    const [theirs] = await listed(w, w.sayo);
    expect(theirs.proxy!.clients.map((c: { by: string }) => c.by)).toEqual([String(w.sayo)]);
    const [own] = await listed(w, w.seyi);
    expect(own.proxy!.clients).toHaveLength(2);
    const after = await takeBack(w, w.seyi, String(w.sayo));
    expect(after!.proxy!.clients.map((c: { by: string }) => c.by)).toEqual([String(w.seyi)]);
    expect(after!.proxy!.uses).toEqual([]);
    expect(await listed(w, w.sayo)).toEqual([]);
    const audit = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((r) => (r as { action?: string }).action === "vault.unshared")).toBe(true);
  });

  test("taking it back from a group keeps the AIs of somebody who still has it another way", async () => {
    const w = await world();
    await give(w, w.seyi, "@team-sharing-leads", "use");
    await give(w, w.seyi, "*", "use");
    const raw = await rawMeta(w);
    const meta = await raw.read();
    await raw.write({ ...meta, proxy: { ...meta.proxy, clients: [{ id: "client_claude", name: "Claude Code", at: 2, by: String(w.sayo) }] } });
    const after = await takeBack(w, w.seyi, "@team-sharing-leads");
    expect(after!.proxy!.clients).toHaveLength(1);
    expect(await listed(w, w.sayo)).toHaveLength(1);
  });

  test("somebody can hand back a key given to them, and never take it from whoever saved it", async () => {
    const w = await world();
    await give(w, w.seyi, String(w.sayo), "use");
    expect(await takeBack(w, w.sayo, String(w.sayo))).toBeNull();
    expect(await listed(w, w.sayo)).toEqual([]);
    expect(errorCode(await captureError(() => takeBack(w, w.kola, String(w.seyi))))).toBe("FORBIDDEN");
    await give(w, w.seyi, String(w.editor), "see");
    expect(errorCode(await captureError(() => takeBack(w, w.editor, String(w.seyi))))).toBe("FORBIDDEN");
    expect(await listed(w, w.seyi)).toHaveLength(1);
  });
});
