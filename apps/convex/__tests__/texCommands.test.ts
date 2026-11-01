/**
 * TEX'S CHAT COMMANDS AS TOOLS (`functions/texCommands.ts`, Dev2, 2026-10-31;
 * `docs/decisions/texting-assistant/command-tools.md`).
 *
 * The agent changes a chat's settings, mutes Tex or shares mail through
 * `/gateway/tex/command` with the turn's own grant. The chat and the person
 * come off the grant, never the request, and the rules are the texting
 * Worker's own (`lib/texChatRules.ts`), so the tool path and "Tex, stop"
 * behave alike.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - read the acting person or chat from the request body instead of the
 *    grant: "the chat and person come off the grant" fails;
 *  - let a guest's grant share mail (drop the GUEST_COMMANDS check):
 *    "a guest may mute and set the style, nothing that acts as a person" fails;
 *  - set a group's style without `setChatStyle` (the Worker's rule): "the
 *    tool and the texted command write the same row" fails.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, seedGoogleConnection, setupTest } from "./fixtures.helpers";
import { migrate, pinnedWorld } from "./pinnedReaders.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "9A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9";
const ADA = "+15555550140";
const BO = "+15555550151";
const WORK = "ada@work.example";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, workspaceId };
}

const turn = async (t: T, sender: string, extra: Record<string, unknown> = {}) =>
  await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [ADA, BO, LINE], mint: true, ...extra });

const command = async (t: T, accessToken: string, body: Record<string, unknown>) =>
  (await (await gatewayPost(t, "/gateway/tex/command", { accessToken, command: body })).json()) as Record<string, unknown>;

/** Ada owns @studio, Bo edits it, and the chat uses it. */
async function chat(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const studio = await createWorkspace(t, ada.userId, "studio", { kind: "shared" });
  await addMember(t, studio, bo.userId, "editor");
  // A chat reaches every shared workspace all its people share (#2531): no "use" step.
  const ready = await turn(t, ADA);
  expect(ready.status).toBe("ready");
  return { ada, bo, studio, token: ready.accessToken as string };
}

const groupRow = async (t: T) => await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]!);

describe("a group's commands as tools", () => {
  test("anyone in the chat changes its style; the tool and the texted command write the same row", async () => {
    const t = setupTest();
    const { token } = await chat(t);
    expect(await command(t, token, { kind: "style", style: { humor: 60 } })).toEqual({ status: "done", style: { humor: 60 } });
    let row = await groupRow(t);
    expect(row.texStyle).toEqual({ humor: 60 });
    expect(row.texStyleSetBy).toBe("ada");
    // The Worker's texted command lays its patch over the same row.
    expect(await agentPost(t, "/agent-texts/group/style", { line: LINE, groupId: GROUP, style: { emoji: "less" }, setBy: BO })).toMatchObject({ ok: true });
    row = await groupRow(t);
    expect(row.texStyle).toEqual({ humor: 60, emoji: "less" });
    expect(await command(t, token, { kind: "settings" })).toMatchObject({ status: "done", style: { humor: 60, emoji: "less" }, engagementChosen: false });
  });

  test("a style off its closed sets is refused whole, and changes nothing", async () => {
    const t = setupTest();
    const { token } = await chat(t);
    expect(await command(t, token, { kind: "style", style: { humor: 65 } })).toEqual({ status: "bad_request" });
    expect(await command(t, token, { kind: "style", style: { tone: "snarky" } })).toEqual({ status: "bad_request" });
    expect((await groupRow(t)).texStyle).toBeUndefined();
  });

  test("when Tex speaks up, and its status", async () => {
    const t = setupTest();
    const { token } = await chat(t);
    expect(await command(t, token, { kind: "engagement", engagement: "quiet" })).toEqual({ status: "done", engagement: "quiet" });
    expect((await groupRow(t)).engagement).toBe("quiet");
    expect(await command(t, token, { kind: "engagement", engagement: "loud" })).toEqual({ status: "bad_request" });
    expect(await command(t, token, { kind: "status" })).toEqual({ status: "done", slug: "studio", guest: false });
  });

  test("muting stops Tex, and the grant then resolves to nothing", async () => {
    const t = setupTest();
    const { token } = await chat(t);
    expect(await command(t, token, { kind: "mute" })).toEqual({ status: "done", muted: true });
    expect((await groupRow(t)).mutedAt).toBeTypeOf("number");
    expect(await command(t, token, { kind: "status" })).toEqual({ status: "refused" });
  });

  test("mail is shared only by its own person, as by text", async () => {
    const t = setupTest();
    const { ada, bo, token } = await chat(t);
    await seedGoogleConnection(t, { workspaceId: ada.workspaceId, boundBy: ada.userId, address: WORK });
    expect(await command(t, token, { kind: "share_mail", address: WORK })).toEqual({ status: "done", address: WORK, narrowed: false });
    // Bo's grant asks for Ada's mailbox: refused, as "Tex, share Ada's mail" from Bo is.
    const boToken = (await turn(t, BO)).accessToken as string;
    expect(await command(t, boToken, { kind: "share_mail", address: WORK })).toEqual({ status: "mail_refused" });
    expect(await command(t, boToken, { kind: "unshare_mail", address: WORK })).toEqual({ status: "done", count: 0 });
    expect(await command(t, token, { kind: "unshare_mail" })).toEqual({ status: "done", count: 1 });
    void bo;
  });

  test("the chat and person come off the grant: names in the request change nothing", async () => {
    const t = setupTest();
    const { token } = await chat(t);
    const answer = await gatewayPost(t, "/gateway/tex/command", {
      accessToken: token,
      command: { kind: "style", style: { humor: 10 } },
      groupId: "someone-elses-chat",
      sender: BO,
      userId: "users:forged",
    });
    expect(await answer.json()).toEqual({ status: "done", style: { humor: 10 } });
    expect((await groupRow(t)).texStyleSetBy).toBe("ada");
  });

  test("a token that resolves to nothing, or no token, is refused", async () => {
    const t = setupTest();
    await chat(t);
    expect(await command(t, "cat_not-a-real-token", { kind: "status" })).toEqual({ status: "refused" });
    expect(await (await gatewayPost(t, "/gateway/tex/command", { command: { kind: "status" } })).json()).toEqual({ status: "bad_request" });
    expect(await command(t, "cat_x", { kind: "rm -rf" })).toEqual({ status: "bad_request" });
  });

  test("a guest may mute and set the style, nothing that acts as a person", async () => {
    const t = setupTest();
    const { ada, token } = await chat(t);
    await seedGoogleConnection(t, { workspaceId: ada.workspaceId, boundBy: ada.userId, address: WORK });
    // A guest's tag is minted on the person who opened the chat (`textGroupGuests.ts`); mark this grant as one.
    await t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((row) => row.clientId === "context_texts_group")!;
      await ctx.db.patch(grant._id, { texGroup: { ...grant.texGroup!, guestTagger: true } });
    });
    expect(await command(t, token, { kind: "share_mail", address: WORK })).toEqual({ status: "not_allowed" });
    expect(await command(t, token, { kind: "unshare_mail" })).toEqual({ status: "not_allowed" });
    expect(await command(t, token, { kind: "review_sharing", share: true })).toEqual({ status: "not_allowed" });
    expect(await command(t, token, { kind: "style", style: { warmth: "more" } })).toEqual({ status: "done", style: { warmth: "more" } });
    expect((await groupRow(t)).texStyleSetBy).toBe("a guest");
  });

  test("an invited person's tag, minted on the binder, is treated as a guest's", async () => {
    const t = setupTest();
    const { ada, token } = await chat(t);
    await seedGoogleConnection(t, { workspaceId: ada.workspaceId, boundBy: ada.userId, address: WORK });
    await t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((row) => row.clientId === "context_texts_group")!;
      await ctx.db.patch(grant._id, { texGroup: { ...grant.texGroup!, invitedTaggerRole: "member" } });
    });
    expect(await command(t, token, { kind: "share_mail", address: WORK })).toMatchObject({ status: expect.stringMatching(/not_allowed|refused/) });
  });
});

// Guest mode is retired (#2529): a chat with someone who has no account is answered from its home, on a grant held
// for its sponsor. A guest's tag acts for nobody; an account holder's tag in that chat acts for them.
describe("a home-only chat", () => {
  const GUEST = "+15555550163";
  const homeTurn = async (t: T, sender: string) =>
    await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [ADA, BO, GUEST, LINE], mint: true });

  test("a guest's tag may set the style, never act for the sponsor", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const ada = await texter(w.t, "ada", ADA);
    await texter(w.t, "bo", BO);
    await seedGoogleConnection(w.t, { workspaceId: ada.workspaceId, boundBy: ada.userId, address: WORK });
    await homeTurn(w.t, ADA);
    const guest = await homeTurn(w.t, GUEST);
    expect(guest.status).toBe("ready");
    const token = guest.accessToken as string;
    expect(await command(w.t, token, { kind: "share_mail", address: WORK })).toEqual({ status: "not_allowed" });
    expect(await command(w.t, token, { kind: "style", style: { humor: 40 } })).toEqual({ status: "done", style: { humor: 40 } });
    expect(await command(w.t, token, { kind: "status" })).toEqual({ status: "done", slug: "", guest: true });
  });
});

describe("a person's own chat", () => {
  test("their own settings and review sharing; nothing a group has", async () => {
    const t = setupTest();
    await texter(t, "ada", ADA);
    const opened = await agentPost(t, "/agent-texts/session", { phone: ADA });
    const token = opened.accessToken as string;
    expect(await command(t, token, { kind: "settings" })).toEqual({ status: "done", style: {} });
    expect(await command(t, token, { kind: "style", style: { length: "short" } })).toEqual({ status: "done", style: { length: "short" } });
    expect(await command(t, token, { kind: "settings" })).toEqual({ status: "done", style: { length: "short" } });
    expect(await command(t, token, { kind: "review_sharing", share: true })).toMatchObject({ status: "done", sharing: true });
    expect(await command(t, token, { kind: "mute" })).toEqual({ status: "not_allowed" });
    expect(await command(t, token, { kind: "share_mail", address: WORK })).toEqual({ status: "not_allowed" });
  });
});
