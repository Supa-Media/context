import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, seedGoogleConnection, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { CALENDAR_WRITE_SCOPE } from "../functions/lib/calendarWrite";
import { GMAIL_SEND_SCOPE } from "../functions/lib/googleOAuth";

/**
 * A GROUP CHAT'S TEX ACTS ON ITS TAGGER'S OWN CALENDAR AND MAIL, AND NOBODY ELSE'S.
 *
 * The owner, 2026-10-21: "calendar is necessary", "email too, write only not
 * read" (`functions/lib/controlPlane/ownAccount.ts`). A group grant reaches the
 * chat's shared workspace for notes; for one email or one calendar change it
 * reaches its tagger's own Google account, whatever their role in the shared
 * workspace, and only while the chat still resolves. It never reads mail.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const CY = "+15555550122";

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

/** One Google connection in a personal workspace that can send and change the calendar. */
async function google(t: T, workspaceId: Id<"workspaces">, boundBy: Id<"users">, address: string) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address, googleAccountId: `account-${address}` });
  await t.run((ctx) => ctx.db.patch(id, { products: ["gmail", "calendar"], scopes: [GMAIL_SEND_SCOPE, CALENDAR_WRITE_SCOPE] }));
}

/** Ada owns the shared workspace; Cy is only a member of it. Both have their own Google connected. */
async function chat(t: T) {
  const ada = await texter(t, "ada", ADA);
  const cy = await texter(t, "cy", CY);
  const studio = await createWorkspace(t, ada.userId, "studio", { kind: "shared" });
  await addMember(t, studio, cy.userId, "member");
  await google(t, ada.workspaceId, ada.userId, "ada@gmail.example");
  await google(t, cy.workspaceId, cy.userId, "cy@gmail.example");
  return { ada, cy, studio };
}

async function tag(t: T, sender: string) {
  const answer = await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [ADA, CY], mint: true });
  expect(answer.status).toBe("ready");
  return await hashToken(answer.accessToken as string);
}

const calendar = (t: T, hashedAccessToken: string, expectedWorkspaceId: string) =>
  t.mutation(internal.functions.calendarWrite.claimCalendarWrite, { hashedAccessToken, expectedWorkspaceId, action: "create", spend: false });
const email = (t: T, hashedAccessToken: string, expectedWorkspaceId: string) =>
  t.mutation(internal.functions.personEmail.claimPersonEmail, {
    hashedAccessToken,
    expectedWorkspaceId,
    recipientHashes: ["a".repeat(64)],
    from: null,
    spend: false,
  });

describe("a group chat's tagger's own account", () => {
  test("a member who can only read the shared workspace can still schedule and send as themselves", async () => {
    const t = setupTest();
    const { studio } = await chat(t);
    const cy = await tag(t, CY);
    expect(await calendar(t, cy, String(studio))).toMatchObject({ ok: true, address: "cy@gmail.example" });
    expect(await email(t, cy, String(studio))).toMatchObject({ ok: true, from: "cy@gmail.example" });
  });

  test("never the owner's, or anyone else's, whoever owns the workspace", async () => {
    const t = setupTest();
    const { studio } = await chat(t);
    const ada = await tag(t, ADA);
    expect(await calendar(t, ada, String(studio))).toMatchObject({ ok: true, address: "ada@gmail.example" });
    const cy = await tag(t, CY);
    expect(await email(t, cy, String(studio))).not.toMatchObject({ from: "ada@gmail.example" });
  });

  test("only for the chat's own workspace, named by the call", async () => {
    const t = setupTest();
    const { cy: person, ada } = await chat(t);
    const cy = await tag(t, CY);
    for (const elsewhere of [String(person.workspaceId), String(ada.workspaceId)]) {
      expect(await calendar(t, cy, elsewhere)).toEqual({ ok: false, refused: "not_allowed" });
      expect(await email(t, cy, elsewhere)).toEqual({ ok: false, refused: "not_allowed" });
    }
  });

  test("stops the moment the chat is muted or someone leaves the workspace", async () => {
    const t = setupTest();
    const { studio, cy: person } = await chat(t);
    const cy = await tag(t, CY);
    await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, CY], command: { kind: "stop" } });
    expect(await calendar(t, cy, String(studio))).toEqual({ ok: false, refused: "not_allowed" });

    const t2 = setupTest();
    const second = await chat(t2);
    const token = await tag(t2, ADA);
    await t2.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", second.studio).eq("userId", second.cy.userId))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });
    expect(await email(t2, token, String(second.studio))).toEqual({ ok: false, refused: "not_allowed" });
    void person;
  });

  test("never reads anyone's mail", async () => {
    const t = setupTest();
    const { studio, cy: person } = await chat(t);
    const cy = await tag(t, CY);
    for (const expectedWorkspaceId of [String(studio), String(person.workspaceId)]) {
      const read = await t.mutation(internal.functions.personMail.claimPersonMailRead, { hashedAccessToken: cy, expectedWorkspaceId, address: null });
      expect(read).toMatchObject({ ok: false, refused: "not_allowed" });
    }
  });
});
