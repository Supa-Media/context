import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  gatewayPost,
  setupTest,
  TEST_EMAIL_WORKER_SECRET,
  TEST_GATEWAY_SECRET,
} from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { CODE_TTL_MS, MAX_WRONG_TRIES, TEXTS_CLIENT_ID } from "../functions/textLinks";

/**
 * LINKING A PHONE, AND WHAT A TEXT CAN REACH.
 *
 * The sending phone number is a texter's whole identity, so these tests are
 * about the two ways that could go wrong: a phone linked to an account by
 * someone who doesn't hold both, and a linked phone reaching more than its
 * owner's personal workspace. The grant is spent on the real `/gateway/session`
 * route, as in `agentGrant.test.ts`: a grant that exists but doesn't resolve is
 * not a grant.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const OTHER_PHONE = "+15555550111";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function person(t: T, email: string, slug: string) {
  const userId = await createUser(t, email);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  return { userId, workspaceId };
}

async function startLink(t: T, userId: Parameters<typeof asUser>[1], phone = PHONE) {
  return await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
}

async function link(t: T, phone: string, code: string) {
  return (await agentPost(t, "/agent-texts/link", { phone, code })).body.status;
}

async function session(t: T, phone: string) {
  return (await agentPost(t, "/agent-texts/session", { phone })).body;
}

async function resolves(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  const body = JSON.parse(await response.text()) as { session: Record<string, unknown> | null };
  return body.session;
}

describe("the door", () => {
  test("both routes refuse without the agent worker's own secret", async () => {
    const t = setupTest();
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET, TEST_EMAIL_WORKER_SECRET]) {
      expect((await agentPost(t, "/agent-texts/link", { phone: PHONE, code: "X" }, secret)).status).toBe(401);
      expect((await agentPost(t, "/agent-texts/session", { phone: PHONE }, secret)).status).toBe(401);
    }
  });
});

describe("linking", () => {
  test("texting the code from the number it was made for links that number", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    expect(await link(t, PHONE, code.toLowerCase())).toBe("linked");
    // The confirmation names whose Context answers, so a code someone else
    // made for this number can't link it to their account unnoticed.
    expect((await agentPost(t, "/agent-texts/link", { phone: PHONE, code: "ZZZZZZZZ" })).body).toEqual({
      status: "refused",
    });
    expect(await asUser(t, userId).query(api.functions.textLinks.myPhoneLink, {})).toMatchObject({ phone: PHONE });
  });

  test("a successful link names the handle whose Context will answer", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    expect((await agentPost(t, "/agent-texts/link", { phone: PHONE, code })).body).toEqual({
      status: "linked",
      handle: "ada",
    });
  });

  test("the right code from a different number links nothing", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    expect(await link(t, OTHER_PHONE, code)).toBe("refused");
    expect(await session(t, OTHER_PHONE)).toEqual({ status: "unlinked" });
    expect(await session(t, PHONE)).toEqual({ status: "unlinked" });
  });

  test("a code works once", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    expect(await link(t, PHONE, code)).toBe("linked");
    expect(await link(t, PHONE, code)).toBe("refused");
  });

  test("a code expires", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("phoneLinkCodes").collect()) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    expect(await link(t, PHONE, code)).toBe("refused");
    expect(CODE_TTL_MS).toBe(10 * 60 * 1000);
  });

  test("wrong guesses burn the code, so the right one stops working", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    for (let i = 0; i < MAX_WRONG_TRIES; i++) expect(await link(t, PHONE, "ZZZZZZZZ")).toBe("refused");
    expect(await link(t, PHONE, code)).toBe("refused");
  });

  test("only the code's hash is stored", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const { code } = await startLink(t, userId);
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneLinkCodes").collect());
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0]!.hashedCode).toBe(await hashToken(code));
  });

  test("a malformed number is refused when the code is asked for", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    const error = await captureError(() => startLink(t, userId, "555-0100"));
    expect(errorCode(error)).toBe("INVALID_ARGUMENT");
  });

  test("linking a number someone else had moves it, and their texts stop reaching their notes", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const bo = await person(t, "b@example.invalid", "bo");
    expect(await link(t, PHONE, (await startLink(t, ada.userId)).code)).toBe("linked");
    const adaSession = await session(t, PHONE);
    expect(await link(t, PHONE, (await startLink(t, bo.userId)).code)).toBe("linked");

    // Ada's live texting grant was revoked with the link.
    expect(await resolves(t, adaSession.accessToken as string)).toBeNull();
    const now = await session(t, PHONE);
    const resolved = await resolves(t, now.accessToken as string);
    expect(resolved?.defaultWorkspaceId).toBe(bo.workspaceId);
    expect(await asUser(t, ada.userId).query(api.functions.textLinks.myPhoneLink, {})).toBeNull();
  });

  test("unlinking stops the phone and revokes its live grant", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    await link(t, PHONE, (await startLink(t, userId)).code);
    const live = await session(t, PHONE);
    await asUser(t, userId).mutation(api.functions.textLinks.unlinkPhone, {});
    expect(await session(t, PHONE)).toEqual({ status: "unlinked" });
    expect(await resolves(t, live.accessToken as string)).toBeNull();
  });
});

describe("what a text can reach", () => {
  test("a linked phone gets a grant on its owner's personal workspace, with the texts client id", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "a@example.invalid", "ada");
    await link(t, PHONE, (await startLink(t, userId)).code);

    const answer = await session(t, PHONE);
    expect(answer.status).toBe("linked");
    expect(answer.accessToken).toMatch(/^cat_[0-9a-f]{64}$/);
    const resolved = await resolves(t, answer.accessToken as string);
    expect(resolved?.defaultWorkspaceId).toBe(workspaceId);

    const grants = await t.run(async (ctx) => await ctx.db.query("oauthGrants").collect());
    expect(grants).toHaveLength(1);
    expect(grants[0]!.clientId).toBe(TEXTS_CLIENT_ID);
    expect(JSON.stringify(grants)).not.toContain(answer.accessToken as string);
  });

  test("it reaches what its person can, and nothing of anyone else's", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const bo = await person(t, "b@example.invalid", "bo");
    const shared = await createWorkspace(t, bo.userId, "bos-studio", { kind: "shared" });
    await addMember(t, shared, ada.userId, "member");
    await link(t, PHONE, (await startLink(t, ada.userId)).code);

    const resolved = await resolves(t, (await session(t, PHONE)).accessToken as string);
    expect(resolved?.defaultWorkspaceId).toBe(ada.workspaceId);
    const reach = JSON.stringify(resolved?.workspaces);
    expect(reach).toContain(String(shared));
    // Bo's personal workspace is not Ada's to reach, by text or otherwise.
    expect(reach).not.toContain(String(bo.workspaceId));
  });

  test("each session replaces the last token instead of stacking live ones", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    await link(t, PHONE, (await startLink(t, userId)).code);
    const first = await session(t, PHONE);
    const second = await session(t, PHONE);
    expect(await resolves(t, first.accessToken as string)).toBeNull();
    expect(await resolves(t, second.accessToken as string)).not.toBeNull();
  });

  test("an unknown number is told unlinked and given no token", async () => {
    const t = setupTest();
    expect(await session(t, PHONE)).toEqual({ status: "unlinked" });
    expect(await session(t, "not-a-number")).toEqual({ status: "unlinked" });
  });

  test("deleting the account removes the link", async () => {
    const t = setupTest();
    const { userId } = await person(t, "a@example.invalid", "ada");
    await link(t, PHONE, (await startLink(t, userId)).code);
    await startLink(t, userId, OTHER_PHONE);
    await t.run(async (ctx) => {
      const { deleteTextLinksOf } = await import("../functions/textLinks");
      await deleteTextLinksOf(ctx, userId);
    });
    const left = await t.run(async (ctx) => [
      ...(await ctx.db.query("phoneLinks").collect()),
      ...(await ctx.db.query("phoneLinkCodes").collect()),
    ]);
    expect(left).toEqual([]);
  });
});
