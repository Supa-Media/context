import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { chatLabel, sharesFor } from "../functions/lib/vaultChat";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";

/**
 * A vault link Tex texted in a group chat (Dev2, 2026-11-12, the Crystal Care
 * chat's Gusto login): the page shows the chat and who in it is in the
 * workspace, the save goes to the chat, the whole workspace or its saver
 * alone, and "Add" invites somebody in the chat who isn't a member.
 *
 * Sabotage record (each broken by hand, the named test failed, then restored):
 *  - `sharesFor` giving "workspace" in a personal workspace → "a personal
 *    workspace has nobody to give it to".
 *  - `inviteFromVaultLink` skipping the owner check → "only an owner adds,
 *    and only somebody the chat names".
 *  - `chatForPage` ignoring whose link it is → "the chat is shown only on
 *    its own person's link".
 */

afterEach(() => vi.unstubAllGlobals());
const CHAT_KEY = "c".repeat(64);

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.test");
  const segun = await createUser(t, "segun@example.test");
  const mom = await createUser(t, "mom@example.test");
  const editor = await createUser(t, "editor@example.test");
  for (const [user, slug] of [[seyi, "seyi-chat"], [segun, "segun-chat"], [mom, "mom-chat"], [editor, "editor-chat"]] as const) {
    await createWorkspace(t, user, slug);
  }
  const team = await createWorkspace(t, seyi, "crystal-chat", { kind: "shared" });
  await addMember(t, team, segun, "member", seyi);
  await addMember(t, team, editor, "editor", seyi);
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
  return { t, seyi, segun, mom, editor, team };
}
type W = Awaited<ReturnType<typeof world>>;

/** An add link for `who` as if Tex had texted it in the chat: the chat stored on the row, its people from the grant. */
async function chatLink(w: W, who: Id<"users">, people: Array<Id<"users">> = [w.seyi, w.segun, w.mom]) {
  const { token } = await asUser(w.t, who).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "add" });
  const hashed = await hashToken(token);
  await w.t.run(async (ctx) => {
    const row = await ctx.db.query("vaultRequests").withIndex("by_hashed_token", (q) => q.eq("hashedToken", hashed)).unique();
    await ctx.db.patch(row!._id, { chat: { key: CHAT_KEY, people: [...people.map((userId) => ({ userId })), { label: "guest-1a2b" }] } });
  });
  return token;
}

const save = (w: W, who: Id<"users">, token: string, share?: "chat" | "workspace" | "me") =>
  asUser(w.t, who).action(api.functions.vault.saveVaultLogin, {
    token,
    type: "login",
    name: "Gusto",
    site: "gusto.com",
    username: "payroll@example.test",
    password: "fake-password-0001",
    fields: [],
    ...(share === undefined ? {} : { share }),
  } as never);

async function sharesOfOnly(w: W) {
  const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
  const { storeForBinding } = await import("../../mcp/src/store/factory.js");
  const { readMeta } = await import("../../mcp/src/vault/entries.js");
  const credential = await w.t.action(internal.functions.storage.getBindingForGateway, { workspaceId: w.team });
  const store = storeForBinding(credential!, undefined, {});
  const keys = await w.t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: w.team, create: false });
  const meta = (await readMeta(store, keys, String(w.team), entry.entryId)) as { shares?: Array<{ to: string; level: string; label?: string }> };
  return { entry, shares: (meta.shares ?? []).map(({ to, level, label }) => ({ to, level, ...(label ? { label } : {}) })) };
}

describe("a vault link from a group chat", () => {
  test("the page shows the chat, the asker first, and who in it is in the workspace", async () => {
    const w = await world();
    const token = await chatLink(w, w.seyi);
    const described = await asUser(w.t, w.seyi).action(api.functions.vault.describeVaultRequest, { token });
    expect(described.chat).toEqual({
      label: "Group chat with @segun-chat, @mom-chat and 1 more",
      canInvite: true,
      people: [
        { name: "You", handle: "seyi-chat", status: "you" },
        { name: "@segun-chat", handle: "segun-chat", status: "member" },
        { name: "@mom-chat", handle: "mom-chat", status: "not_member" },
        { name: "guest-1a2b", handle: null, status: "invited" },
      ],
    });
  });

  test("the chat is shown only on its own person's link, and a link from no chat shows none", async () => {
    const w = await world();
    const { token } = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "add" });
    expect((await asUser(w.t, w.seyi).action(api.functions.vault.describeVaultRequest, { token })).chat).toBeNull();
    const theirs = await chatLink(w, w.seyi);
    expect(errorCode(await captureError(() => asUser(w.t, w.segun).action(api.functions.vault.describeVaultRequest, { token: theirs })))).toBe(
      "VAULT_LINK_NOT_YOURS",
    );
  });

  test("saved from a chat with no choice sent, it goes to that chat, used, never seen", async () => {
    const w = await world();
    const saved = await save(w, w.seyi, await chatLink(w, w.seyi));
    expect(saved.sharedWith).toBe("chat");
    const { shares } = await sharesOfOnly(w);
    expect(shares).toEqual([{ to: `#chat:${CHAT_KEY}`, level: "use", label: "Group chat with @segun-chat, @mom-chat and 1 more" }]);
    // Nobody else in the workspace was given it as a person.
    expect(await asUser(w.t, w.segun).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team })).toEqual([]);
  });

  test("the whole workspace, or only its saver, as picked", async () => {
    const w = await world();
    expect((await save(w, w.seyi, await chatLink(w, w.seyi), "workspace")).sharedWith).toBe("workspace");
    expect((await sharesOfOnly(w)).shares).toEqual([{ to: "*", level: "use" }]);
    const v = await world();
    expect((await save(v, v.seyi, await chatLink(v, v.seyi), "me")).sharedWith).toBe("me");
    expect((await sharesOfOnly(v)).shares).toEqual([]);
  });

  test("the chat can't be picked on a link from no chat", async () => {
    const w = await world();
    const { token } = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.startVaultLink, { workspaceId: w.team, kind: "add" });
    expect(errorCode(await captureError(() => save(w, w.seyi, token, "chat")))).toBe("INVALID_ARGUMENT");
    // The link is still good after a refused choice.
    expect((await save(w, w.seyi, token)).sharedWith).toBe("me");
  });

  test("the vault page lists the chat by its name, and takes it back", async () => {
    const w = await world();
    await save(w, w.seyi, await chatLink(w, w.seyi));
    const [entry] = await asUser(w.t, w.seyi).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.team });
    expect(entry.people.find((row: { kind: string }) => row.kind === "chat")).toMatchObject({ name: "Group chat with @segun-chat, @mom-chat and 1 more", level: "use" });
    // Taken back from the vault page like any share: the chat's turns stop using it.
    await asUser(w.t, w.seyi).action(api.functions.vaultSettings.takeBackVaultKey, { workspaceId: w.team, entryId: entry.entryId, to: `#chat:${CHAT_KEY}` });
    expect((await sharesOfOnly(w)).shares).toEqual([]);
  });

  test("only an owner adds, and only somebody the chat names", async () => {
    const w = await world();
    const token = await chatLink(w, w.seyi);
    expect(await asUser(w.t, w.seyi).mutation(api.functions.vaultChatLinks.inviteFromVaultLink, { token, handle: "mom-chat" })).toBe("invited");
    const invitations = await w.t.run((ctx) => ctx.db.query("workspaceInvitations").collect());
    expect(invitations.filter((row) => row.workspaceId === w.team).map((row) => row.inviteeKind)).toEqual(["name"]);
    expect(await asUser(w.t, w.seyi).mutation(api.functions.vaultChatLinks.inviteFromVaultLink, { token, handle: "segun-chat" })).toBe("already");
    expect(errorCode(await captureError(() => asUser(w.t, w.seyi).mutation(api.functions.vaultChatLinks.inviteFromVaultLink, { token, handle: "editor-chat" })))).toBe(
      "INVALID_ARGUMENT",
    );
    // An editor's own link from the same chat: they see who is missing, but can't add them.
    const theirs = await chatLink(w, w.editor, [w.editor, w.segun, w.mom]);
    expect((await asUser(w.t, w.editor).action(api.functions.vault.describeVaultRequest, { token: theirs })).chat?.canInvite).toBe(false);
    expect(errorCode(await captureError(() => asUser(w.t, w.editor).mutation(api.functions.vaultChatLinks.inviteFromVaultLink, { token: theirs, handle: "mom-chat" })))).toBe(
      "NOT_ALLOWED",
    );
    // Somebody else's link is never theirs to invite from.
    expect(errorCode(await captureError(() => asUser(w.t, w.segun).mutation(api.functions.vaultChatLinks.inviteFromVaultLink, { token, handle: "mom-chat" })))).toBe(
      "VAULT_LINK_NOT_YOURS",
    );
  });
});

describe("who a save is given to", () => {
  const chat = { key: CHAT_KEY, people: [] };
  const base = { label: "Group chat", userId: "user_1", now: 1 };
  test("a personal workspace has nobody to give it to", () => {
    expect(sharesFor("workspace", { ...base, chat, kind: "personal" })).toBeNull();
    expect(sharesFor("workspace", { ...base, chat, kind: "shared" })).toEqual([{ to: "*", level: "use", by: "user_1", at: 1 }]);
    expect(sharesFor("chat", { ...base, chat: null, kind: "shared" })).toBeNull();
    expect(sharesFor("me", { ...base, chat, kind: "personal" })).toEqual([]);
  });

  test("a chat is named by its people, never a number", () => {
    expect(chatLabel([{ name: "You", handle: "a", status: "you" }])).toBe("Group chat");
    expect(chatLabel([{ name: "guest-1a2b", handle: null, status: "invited" }])).toBe("Group chat with 1 person");
    expect(
      chatLabel(["A", "B", "C", "D"].map((name) => ({ name, handle: name.toLowerCase(), status: "member" as const }))),
    ).toBe("Group chat with A, B, C and 1 more");
  });
});
