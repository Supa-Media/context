import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  TEST_GATEWAY_SECRET,
} from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { INVITE_TTL_MS } from "../functions/textLinks";

/**
 * THE LINK A TEXT SENDS BACK.
 *
 * A phone nobody has linked is texted a sign-in link instead of instructions.
 * Opening it signed in shows a code for that phone, so the person never types
 * their number. What must not change is the rule the link sits on top of: a
 * phone is linked only by texting the code *from that phone*. A link that was
 * forwarded, or opened by someone else, shows them a code they cannot use.
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
  await createWorkspace(t, userId, slug, { kind: "personal" });
  return userId;
}

/** The link the Worker would text to `phone`, and the token in it. */
async function invite(t: T, phone = PHONE) {
  const { body } = await agentPost(t, "/agent-texts/invite", { phone });
  expect(body.status).toBe("issued");
  const url = new URL(body.url as string);
  return { url, token: url.pathname.split("/").pop()! };
}

async function claim(t: T, userId: Awaited<ReturnType<typeof person>>, token: string) {
  return await asUser(t, userId).action(api.functions.textLinks.claimPhoneLinkInvite, { token });
}

async function link(t: T, phone: string, code: string) {
  return (await agentPost(t, "/agent-texts/link", { phone, code })).body;
}

describe("the door", () => {
  test("invite and unlink refuse without the agent worker's own secret", async () => {
    const t = setupTest();
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
      expect((await agentPost(t, "/agent-texts/invite", { phone: PHONE }, secret)).status).toBe(401);
      expect((await agentPost(t, "/agent-texts/unlink", { phone: PHONE }, secret)).status).toBe(401);
    }
  });

  test("claiming a link needs a session", async () => {
    const t = setupTest();
    const { token } = await invite(t);
    const error = await captureError(() =>
      t.action(api.functions.textLinks.claimPhoneLinkInvite, { token }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

describe("the texted link", () => {
  test("is a page on the app, and opening it shows a code that links that phone", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const { url, token } = await invite(t);
    expect(url.origin).toBe("https://app.context.invalid");
    expect(url.pathname).toBe(`/texts/${token}`);
    // Nothing about the number is in the link itself.
    expect(url.toString()).not.toContain("5555550100");

    const shown = await claim(t, ada, token);
    expect(shown.phoneEnding).toBe("0100");
    expect(shown.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(await link(t, PHONE, shown.code)).toEqual({ status: "linked", handle: "ada" });
  });

  test("someone else opening a forwarded link gets a code only that phone can use", async () => {
    const t = setupTest();
    const mallory = await person(t, "m@example.invalid", "mallory");
    const { token } = await invite(t, PHONE);
    const shown = await claim(t, mallory, token);
    // Mallory can text it from her own phone, and it links nothing.
    expect((await link(t, OTHER_PHONE, shown.code)).status).toBe("refused");
    expect((await agentPost(t, "/agent-texts/session", { phone: OTHER_PHONE })).body).toEqual({ status: "unlinked" });
    expect((await agentPost(t, "/agent-texts/session", { phone: PHONE })).body).toEqual({ status: "unlinked" });
  });

  test("reloading the page works, and shows a fresh code that replaces the last", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const { token } = await invite(t);
    const first = await claim(t, ada, token);
    const second = await claim(t, ada, token);
    expect((await link(t, PHONE, first.code)).status).toBe("refused");
    expect((await link(t, PHONE, second.code)).status).toBe("linked");
  });

  test("a newer link replaces the older one", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const older = await invite(t);
    await invite(t);
    expect(errorCode(await captureError(() => claim(t, ada, older.token)))).toBe("INVITE_DEAD");
  });

  test("a link expires, and expired ones are swept with the number they name", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const { token } = await invite(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("phoneLinkInvites").collect()) {
        await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
      }
    });
    expect(errorCode(await captureError(() => claim(t, ada, token)))).toBe("INVITE_DEAD");
    await t.mutation(internal.functions.textLinks.purgeExpiredPhoneLinkInvites, {});
    expect(await t.run(async (ctx) => await ctx.db.query("phoneLinkInvites").collect())).toEqual([]);
    expect(INVITE_TTL_MS).toBe(30 * 60 * 1000);
  });

  test("an unknown or made-up token is dead, the same as an expired one", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    await invite(t);
    for (const token of ["nope", "", "x".repeat(500)]) {
      expect(errorCode(await captureError(() => claim(t, ada, token)))).toBe("INVITE_DEAD");
    }
  });

  test("only the token's hash is stored", async () => {
    const t = setupTest();
    const { token } = await invite(t);
    const rows = await t.run(async (ctx) => await ctx.db.query("phoneLinkInvites").collect());
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.hashedToken).toBe(await hashToken(token));
  });

  test("a phone is texted at most ten links an hour", async () => {
    const t = setupTest();
    for (let i = 0; i < 10; i++) await invite(t);
    expect((await agentPost(t, "/agent-texts/invite", { phone: PHONE })).body).toEqual({ status: "refused" });
    expect((await agentPost(t, "/agent-texts/invite", { phone: OTHER_PHONE })).body.status).toBe("issued");
  });

  test("a malformed number gets no link", async () => {
    const t = setupTest();
    expect((await agentPost(t, "/agent-texts/invite", { phone: "555-0100" })).body).toEqual({ status: "refused" });
  });
});

describe("texting UNLINK", () => {
  test("disconnects the phone it came from, and nothing else", async () => {
    const t = setupTest();
    const ada = await person(t, "a@example.invalid", "ada");
    const bo = await person(t, "b@example.invalid", "bo");
    const adaLink = await invite(t, PHONE);
    await link(t, PHONE, (await claim(t, ada, adaLink.token)).code);
    const boLink = await invite(t, OTHER_PHONE);
    await link(t, OTHER_PHONE, (await claim(t, bo, boLink.token)).code);

    expect((await agentPost(t, "/agent-texts/unlink", { phone: PHONE })).body).toEqual({ status: "unlinked" });
    expect((await agentPost(t, "/agent-texts/session", { phone: PHONE })).body).toEqual({ status: "unlinked" });
    expect((await agentPost(t, "/agent-texts/session", { phone: OTHER_PHONE })).body.status).toBe("linked");
    expect((await agentPost(t, "/agent-texts/unlink", { phone: PHONE })).body).toEqual({ status: "not_linked" });
  });
});
