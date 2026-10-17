import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { givenMail, MAILS_PER_DAY } from "../functions/vaultNotify";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, captureError, createUser, createWorkspace, drainScheduled, errorCode, setupTest } from "./fixtures.helpers";

/**
 * The last two vault sharing boards: telling somebody a key was given to them
 * (board 4, by email), and moving a key out of a personal workspace into a
 * shared one so it can be given (board 5).
 *
 * Sabotage record (each broken by hand, the named test failed, then restored):
 *  - `moveVaultKey` skipping the saver check → "only whoever saved a key may
 *    move it" fails.
 *  - `newlyReached` ignoring the share it was asked about → "everyone given a
 *    key hears about it once" fails.
 */

const VALUE = "fake-move-value-0000003";
const ORIGINAL_KEY = process.env.RESEND_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = ORIGINAL_KEY;
});

type T = ReturnType<typeof setupTest>;

async function bind(t: T, workspaceId: Id<"workspaces">, by: Id<"users">) {
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: by,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const sayo = await createUser(t, "sayo@example.test");
  const kola = await createUser(t, "kola@example.test");
  const own = await createWorkspace(t, seyi, "seyi-own", { kind: "personal" });
  const team = await createWorkspace(t, seyi, "team-move", { kind: "shared" });
  const other = await createWorkspace(t, sayo, "sayo-team", { kind: "shared" });
  await addMember(t, team, sayo, "member", seyi);
  await addMember(t, team, kola, "member", seyi);
  await addMember(t, other, seyi, "member", sayo);
  const backend = memoryS3(FAKE_STORAGE.bucket);
  const mails: { to: string; subject: string; text: string }[] = [];
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (String(input).startsWith("https://api.resend.com/")) {
      mails.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }
    return backend.fetchImpl(input, init);
  });
  process.env.RESEND_API_KEY = "fake-resend-key";
  for (const ws of [own, team, other]) await bind(t, ws, seyi);
  return { t, seyi, sayo, kola, own, team, other, mails };
}
type W = Awaited<ReturnType<typeof world>>;

async function save(w: W, workspaceId: Id<"workspaces">, name = "Convex read-only") {
  const { token } = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId, kind: "add" });
  await asUser(w.t, w.seyi).action(api.functions.vault.saveVaultLogin, {
    token,
    type: "secret",
    name,
    site: "",
    fields: [{ name: "KEY", perEnv: false, values: { _: VALUE } }],
    proxy: { host: "api.convex.example", style: "bearer", ask: true },
  } as never);
  const listed = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId });
  return listed.find((entry: { name: string }) => entry.name === name)!.entryId as string;
}
const listed = (w: W, who: Id<"users">, workspaceId: Id<"workspaces">) =>
  asUser(w.t, who).action(api.functions.vaultSettings.listVaultEntries, { workspaceId });

describe("moving a personal key into a shared workspace", () => {
  test("offers the shared workspaces the person owns or edits, and nothing else", async () => {
    const w = await world();
    const targets = await asUser(w.t, w.seyi).query(api.functions.vaultMove.vaultMoveTargets, {});
    expect(targets.map((target: { handle: string }) => target.handle)).toEqual(["team-move"]);
  });

  test("moves the key, values and website, and leaves no copy behind", async () => {
    const w = await world();
    const entryId = await save(w, w.own);
    const moved = await asUser(w.t, w.seyi).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.own, entryId, toWorkspaceId: w.team });
    expect(moved.handle).toBe("team-move");
    expect(await listed(w, w.seyi, w.own)).toEqual([]);
    const [there] = await listed(w, w.seyi, w.team);
    expect(there).toMatchObject({ entryId: moved.entryId, name: "Convex read-only", savedByYou: true });
    expect(there.proxy).toMatchObject({ host: "api.convex.example", clients: [] });
    const { token } = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "view", entryId: moved.entryId });
    const shown = await asUser(w.t, w.seyi).action(api.functions.vault.revealVaultEntry, { token });
    expect(shown.fields[0].values._).toBe(VALUE);
    // Now it can be given.
    await asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId: moved.entryId, to: String(w.sayo), level: "use" });
    expect(await listed(w, w.sayo, w.team)).toHaveLength(1);
    const audit = await w.t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.filter((row) => (row as { action?: string }).action === "vault.moved")).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(VALUE);
  });

  test("never into a workspace the person only belongs to, a personal one, or out of a shared one", async () => {
    const w = await world();
    const entryId = await save(w, w.own);
    const member = await captureError(() => asUser(w.t, w.seyi).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.own, entryId, toWorkspaceId: w.other }));
    expect(errorCode(member)).toBe("FORBIDDEN");
    const personal = await captureError(() => asUser(w.t, w.seyi).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.own, entryId, toWorkspaceId: w.own }));
    expect(errorCode(personal)).toBe("FORBIDDEN");
    const shared = await save(w, w.team, "Team key");
    const outOfShared = await captureError(() => asUser(w.t, w.seyi).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.team, entryId: shared, toWorkspaceId: w.team }));
    expect(errorCode(outOfShared)).toBe("INVALID_ARGUMENT");
    expect(await listed(w, w.seyi, w.own)).toHaveLength(1);
  });

  test("only whoever saved a key may move it, and a stranger learns nothing", async () => {
    const w = await world();
    const entryId = await save(w, w.own);
    const stranger = await captureError(() => asUser(w.t, w.kola).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.own, entryId, toWorkspaceId: w.team }));
    expect(errorCode(stranger)).toBe("WORKSPACE_NOT_FOUND");
    // Somebody in the personal workspace who was given the key before levels existed sees it, but it isn't theirs to move.
    await addMember(w.t, w.own, w.sayo, "editor", w.seyi);
    await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", w.team).eq("userId", w.sayo))
        .unique();
      await ctx.db.patch(row!._id, { role: "editor" });
    });
    const { storeForBinding } = await import("../../mcp/src/store/factory.js");
    const { readMeta, writeMeta } = await import("../../mcp/src/vault/entries.js");
    const credential = await w.t.action(internal.functions.storage.getBindingForGateway, { workspaceId: w.own });
    const store = storeForBinding(credential!, undefined, {});
    const keys = await w.t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: w.own, create: false });
    const meta = (await readMeta(store, keys, String(w.own), entryId)) as { people: string[] };
    await writeMeta(store, keys, String(w.own), entryId, { ...meta, people: [...meta.people, String(w.sayo)] });
    const notTheirs = await captureError(() => asUser(w.t, w.sayo).action(api.functions.vaultMove.moveVaultKey, { workspaceId: w.own, entryId, toWorkspaceId: w.team }));
    expect(errorCode(notTheirs)).toBe("FORBIDDEN");
    expect(await listed(w, w.seyi, w.own)).toHaveLength(1);
    expect(await listed(w, w.seyi, w.team)).toEqual([]);
  });
});

describe("telling somebody they were given a key", () => {
  test("the mail names who gave it and where, never the key or a value", () => {
    const mail = givenMail("Seyi", "supa", "use");
    expect(mail.subject).toBe("Seyi gave you a key in @supa");
    expect(mail.text).toContain("You won't see its value");
    expect(mail.text).toContain("/console/supa?settings=vault");
    expect(givenMail("Seyi", "supa", "see").text).toContain("you can open it to see it");
  });

  test("a person given a key hears about it once; a level change and the giver hear nothing", async () => {
    const w = await world();
    const entryId = await save(w, w.team);
    const give = (to: string, level: "use" | "see") =>
      asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId, to, level });
    await give(String(w.sayo), "use");
    await drainScheduled(w.t);
    expect(w.mails.map((mail) => mail.to)).toEqual(["sayo@example.test"]);
    expect(w.mails[0].subject).toContain("gave you a key in @team-move");
    expect(JSON.stringify(w.mails)).not.toContain("Convex read-only");
    expect(JSON.stringify(w.mails)).not.toContain(VALUE);
    await give(String(w.sayo), "see");
    await drainScheduled(w.t);
    expect(w.mails).toHaveLength(1);
  });

  test("everyone given a key hears about it once, but not those who had it already", async () => {
    const w = await world();
    const entryId = await save(w, w.team);
    await asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId, to: String(w.sayo), level: "use" });
    await drainScheduled(w.t);
    await asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId, to: "*", level: "use" });
    await drainScheduled(w.t);
    expect(w.mails.map((mail) => mail.to)).toEqual(["sayo@example.test", "kola@example.test"]);
  });

  test(`no more than ${MAILS_PER_DAY} a day reach one person`, async () => {
    const w = await world();
    for (let n = 0; n < MAILS_PER_DAY + 2; n += 1) {
      const entryId = await save(w, w.team, `Key ${n}`);
      await asUser(w.t, w.seyi).action(api.functions.vaultSettings.giveVaultKey, { workspaceId: w.team, entryId, to: String(w.sayo), level: "use" });
    }
    await drainScheduled(w.t);
    expect(w.mails).toHaveLength(MAILS_PER_DAY);
  });
});
