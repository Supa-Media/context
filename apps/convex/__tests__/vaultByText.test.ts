import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3 } from "./storeStub.helpers";
import { FAKE_STORAGE, addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * Who a vault login is for, read and changed by text (Dev2, 2026-11-12: "I should be able to say share with x person
 * as well, or share with the workspace and it just works"; `functions/vaultByText.ts`,
 * `functions/lib/gatewayRoutes/vaultText.ts`).
 *
 * Sabotage record (each broken by hand, the named tests failed, then restored):
 *  - the common group path minting without `ownTag` (as #3205 left it) → "the saver lists it ..." and "only the saver
 *    changes it" (the tagger's turn is refused).
 *  - the gateway's own-words check removed (`apps/mcp/src/agent/settingsTools.js`) → its "sharing a login runs only on
 *    the person's own words" and "the judge decides" tests.
 */

afterEach(() => vi.unstubAllGlobals());

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "9A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9";
const ADA = "+15555550140";
const BO = "+15555550151";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return userId;
}

const tag = async (t: T, sender: string) => (await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [ADA, BO, LINE], mint: true })).accessToken as string;

/** Ada owns @studio, Bo edits it, both are in the chat, and Ada saved a Gusto login for herself in @studio. */
async function world() {
  const t = setupTest();
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const studio = await createWorkspace(t, ada, "studio", { kind: "shared" });
  await addMember(t, studio, bo, "editor");
  const backend = memoryS3(FAKE_STORAGE.bucket);
  vi.stubGlobal("fetch", backend.fetchImpl);
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId: studio });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: studio,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: ada,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const { token } = await asUser(t, ada).action(api.functions.vaultSettings.startVaultLink, { workspaceId: studio, kind: "add" });
  await asUser(t, ada).action(api.functions.vault.saveVaultLogin, { token, type: "login", name: "Gusto", site: "gusto.com", username: "payroll@example.test", password: "fake-password-0001", fields: [], share: "me" } as never);
  const [entry] = await asUser(t, ada).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: studio });
  return { t, ada, bo, studio, entry: entry.entryId };
}
type W = Awaited<ReturnType<typeof world>>;

const vault = async (w: W, accessToken: string, body: Record<string, unknown>) =>
  (await (await gatewayPost(w.t, "/gateway/vault/text", { accessToken, expectedWorkspaceId: w.studio, ...body })).json()) as Record<string, any>;

const boSees = async (w: W) => (await asUser(w.t, w.bo).action(api.functions.vaultSettings.listVaultEntries, { workspaceId: w.studio as Id<"workspaces"> })).map((row) => row.name);

describe("a vault login's people, by text", () => {
  test("the saver lists it, gives it to the chat, the workspace and a person, and keeps it to herself again", async () => {
    const w = await world();
    const token = await tag(w.t, ADA);
    const listed = await vault(w, token, { op: "list" });
    expect(listed).toEqual({ status: "done", entries: [{ entry: w.entry, name: "Gusto", type: "login", sites: ["gusto.com"], savedBy: "You", yours: true, who: ["you (saved it)"], here: true, ais: [] }] });

    expect((await vault(w, token, { op: "share", entry: w.entry, to: "chat" })).entry.who).toEqual(["you (saved it)", "this chat"]);
    expect(await boSees(w)).toEqual([]);
    expect((await vault(w, token, { op: "share", entry: w.entry, to: "workspace" })).entry.who).toEqual(["you (saved it)", "this chat", "everyone in the workspace"]);
    expect(await boSees(w)).toEqual(["Gusto"]);
    expect((await vault(w, token, { op: "unshare", entry: w.entry, from: "workspace" })).entry.who).toEqual(["you (saved it)", "this chat"]);
    expect(await boSees(w)).toEqual([]);
    const toBo = await vault(w, token, { op: "share", entry: w.entry, to: "@bo" });
    expect(toBo.status).toBe("done");
    expect(toBo.entry.who).toEqual(["you (saved it)", "this chat", "bo"]);
    expect(await boSees(w)).toEqual(["Gusto"]);
    expect((await vault(w, token, { op: "only_me", entry: w.entry })).entry.who).toEqual(["you (saved it)"]);
    expect(await boSees(w)).toEqual([]);
    expect(await vault(w, token, { op: "share", entry: w.entry, to: "@nobody-here" })).toEqual({ status: "not_member" });
    expect(await vault(w, token, { op: "share", entry: w.entry, to: "a b" })).toEqual({ status: "bad_request" });
    // "everyone" and "here" are the workspace and this chat.
    expect((await vault(w, token, { op: "share", entry: w.entry, to: "everyone" })).entry.who).toEqual(["you (saved it)", "everyone in the workspace"]);
    expect((await vault(w, token, { op: "share", entry: w.entry, to: "here" })).entry.who).toEqual(["you (saved it)", "everyone in the workspace", "this chat"]);
  });

  test("only the saver changes it, on her own tag", async () => {
    const w = await world();
    await vault(w, await tag(w.t, ADA), { op: "share", entry: w.entry, to: "workspace" });
    const bo = await tag(w.t, BO);
    expect((await vault(w, bo, { op: "list" })).entries[0]).toMatchObject({ name: "Gusto", yours: false, who: [], here: true });
    expect(await vault(w, bo, { op: "only_me", entry: w.entry })).toEqual({ status: "not_yours" });
    expect(await vault(w, bo, { op: "unshare", entry: w.entry, from: "workspace" })).toEqual({ status: "not_yours" });
    expect(await boSees(w)).toEqual(["Gusto"]);
  });

  test("an AI app's grant, a stale token and a workspace outside the grant are refused", async () => {
    const w = await world();
    expect(await vault(w, "not-a-token", { op: "list" })).toEqual({ status: "refused" });
    const other = await createWorkspace(w.t, w.bo, "elsewhere", { kind: "shared" });
    const token = await tag(w.t, ADA);
    expect((await (await gatewayPost(w.t, "/gateway/vault/text", { accessToken: token, expectedWorkspaceId: other, op: "list" })).json())).toEqual({ status: "refused" });
    expect(await vault(w, token, { op: "explode" })).toEqual({ status: "bad_request" });
  });

  test("a person's own chat can't give a login to \"this chat\"", async () => {
    const w = await world();
    const opened = await agentPost(w.t, "/agent-texts/session", { phone: ADA });
    // Their own chat's grant is for their personal workspace; @studio is outside it, so it is refused there.
    expect(await vault(w, opened.accessToken as string, { op: "share", entry: w.entry, to: "chat" })).toMatchObject({ status: expect.stringMatching(/refused|no_chat/) });
  });

  test("in a group, a login given to the tagger alone isn't listed to the chat", async () => {
    const w = await world();
    await vault(w, await tag(w.t, ADA), { op: "share", entry: w.entry, to: "@bo" });
    expect(await boSees(w)).toEqual(["Gusto"]);
    expect(await vault(w, await tag(w.t, BO), { op: "list" })).toEqual({ status: "done", entries: [] });
  });
});
