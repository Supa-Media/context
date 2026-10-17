/**
 * An email a person's AI sends goes out through that person's own Gmail, only
 * one that granted sending, and the limits hold whatever the gateway asks
 * (`functions/lib/gatewayRoutes/personEmail.ts`).
 *
 * ## Sabotage record
 *
 * Dropping the per-recipient policy from `personEmailPolicies` sent a fourth
 * email to one address in a day, failing "one address gets at most three a
 * day". Spending inside the room check (calling `tryConsumeRateLimit` in place
 * of `hasRoom`) made a check use up the hour, failing "a check sends nothing
 * and spends nothing". Accepting a subject with a newline in
 * `readPersonEmail` let "Bcc:" ride into the subject, failing the header test.
 * Dropping the `gmail.send` scope check sent from a read-only connection,
 * failing "a Gmail connected to read only sends nothing".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, token, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { GMAIL_SEND_SCOPE, PERSON_EMAIL_HOURLY_LIMIT, PERSON_EMAIL_RECIPIENT_DAILY_LIMIT, gmailRaw, readPersonEmail } from "../functions/lib/personEmail";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Gmail, answered here; anything else goes where it was going. Each sent message, decoded. */
function gmail(status = 200) {
  const sent: Array<{ auth: string | null; message: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    const raw = String(JSON.parse(String(init?.body)).raw).replace(/-/g, "+").replace(/_/g, "/");
    const headers = new Headers(init?.headers);
    sent.push({ auth: headers.get("Authorization"), message: atob(raw) });
    return new Response(JSON.stringify({ id: "msg_fake" }), { status });
  });
  return sent;
}

/** A connected Gmail on Alice's workspace; `send` grants the send scope, with a cached token. */
async function connectGmail(
  t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"],
  workspaceId: Awaited<ReturnType<typeof twoConnectedTenants>>["aliceWs"],
  boundBy: Awaited<ReturnType<typeof twoConnectedTenants>>["alice"],
  { send = true, address = "alice@gmail.example" } = {},
) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.patch(id, {
      scopes: send ? ["https://www.googleapis.com/auth/gmail.readonly", GMAIL_SEND_SCOPE] : ["https://www.googleapis.com/auth/gmail.readonly"],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
  return id;
}

/** Alice, Bob, and a Gmail on Alice's workspace that may send. */
async function connected(options: { send?: boolean } = {}) {
  const tenants = await twoConnectedTenants();
  await connectGmail(tenants.t, tenants.aliceWs, tenants.alice, options);
  return tenants;
}

const EMAIL = { to: ["jo@example.invalid"], subject: "Thursday works", body: "Hi Jo,\n\nThursday at 3 works for me.\n\nSeyi" };
const FROM = "alice@gmail.example";

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function send(t: Tenants["t"], accessToken: string, workspaceId: string, extra: Record<string, unknown> = {}) {
  return await bodyOf(await gatewayPost(t, "/gateway/email/send", { accessToken, expectedWorkspaceId: workspaceId, email: EMAIL, ...extra }));
}

describe("sending an email as the person", () => {
  test("it goes through their own Gmail, and nothing of it is kept", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: true, from: FROM });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.auth).toBe("Bearer ya29.fake-access-token");
    expect(sent[0]!.message).toContain(`From: ${FROM}\r\nTo: jo@example.invalid\r\nSubject: Thursday works\r\n`);
    const kept = await t.run(async (ctx) => ({
      limits: await ctx.db.query("rateLimits").collect(),
      audit: (await ctx.db.query("auditEvents").collect()).filter((row) => row.action === "send_email"),
    }));
    const stored = JSON.stringify(kept);
    expect(stored).not.toContain("jo@example.invalid");
    expect(stored).not.toContain("Thursday");
    expect(kept.audit).toHaveLength(1);
    expect(kept.audit[0]!.details).toEqual({ recipients: 1 });
  });

  test("a Gmail connected to read only sends nothing, and says there is no sender", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected({ send: false });
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_sender" });
    expect(await send(t, ACCESS_A, aliceWs, { check: true })).toEqual({ ok: false, refused: "no_sender" });
    expect(sent).toHaveLength(0);
  });

  test("a person with no Gmail connected has no sender", async () => {
    const sent = gmail();
    const { t, aliceWs } = await twoConnectedTenants();
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_sender" });
    expect(sent).toHaveLength(0);
  });

  test("it sends from the address asked for, and only one the person connected", async () => {
    const sent = gmail();
    const { t, alice, aliceWs } = await connected();
    await connectGmail(t, aliceWs, alice, { address: "alice@work.example" });
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: "Alice@Work.example" } })).toEqual({ ok: true, from: "alice@work.example" });
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: "ceo@bank.example" } })).toEqual({ ok: false, refused: "no_sender" });
    expect(sent.map((mail) => mail.message.split("\r\n")[0])).toEqual(["From: alice@work.example"]);
  });

  test("the sender is the token's person: another tenant's token cannot send from their Gmail", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(await send(t, token("nobody"), aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(sent).toHaveLength(0);
  });

  test("a grant that can only read sends nothing", async () => {
    const sent = gmail();
    const { t, aliceWs, grantA } = await connected();
    await t.run((ctx) => ctx.db.patch(grantA, { scopes: ["context:read"] }));
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(sent).toHaveLength(0);
  });

  test("a check sends nothing and spends nothing", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < PERSON_EMAIL_HOURLY_LIMIT + 2; i++) {
      expect(await send(t, ACCESS_A, aliceWs, { check: true })).toEqual({ ok: true, from: FROM });
    }
    expect(sent).toHaveLength(0);
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(limits.filter((row) => row.key.startsWith("person_email."))).toHaveLength(0);
  });

  test("an hour holds at most five, and the sixth is refused before anything is sent", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < PERSON_EMAIL_HOURLY_LIMIT; i++) {
      const email = { ...EMAIL, to: [`friend${i}@example.invalid`] };
      expect((await send(t, ACCESS_A, aliceWs, { email })).ok).toBe(true);
    }
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, to: ["new@example.invalid"] } })).toEqual({ ok: false, refused: "hourly_limit" });
    // And a check says so too, so the person is never asked to approve it.
    expect(await send(t, ACCESS_A, aliceWs, { check: true })).toEqual({ ok: false, refused: "hourly_limit" });
    expect(sent).toHaveLength(PERSON_EMAIL_HOURLY_LIMIT);
  });

  test("one address gets at most three a day, and a refused email spends nothing", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < PERSON_EMAIL_RECIPIENT_DAILY_LIMIT; i++) expect((await send(t, ACCESS_A, aliceWs)).ok).toBe(true);
    // Jo again, with a new address alongside: all or none.
    const both = { ...EMAIL, to: ["jo@example.invalid", "sam@example.invalid"] };
    expect(await send(t, ACCESS_A, aliceWs, { email: both })).toEqual({ ok: false, refused: "recipient_limit" });
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, to: ["JO@example.invalid"] } })).toEqual({ ok: false, refused: "recipient_limit" });
    expect((await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, to: ["sam@example.invalid"] } })).ok).toBe(true);
    expect(sent).toHaveLength(PERSON_EMAIL_RECIPIENT_DAILY_LIMIT + 1);
  });

  test("a Gmail failure is reported, not called sent", async () => {
    gmail(500);
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "unavailable" });
  });
});

describe("what an email may be", () => {
  test("anything that could add a header or a hidden recipient is refused", () => {
    expect(readPersonEmail(EMAIL)).toEqual({ ...EMAIL, from: null, cc: [] });
    expect(readPersonEmail({ ...EMAIL, subject: "Hi\nBcc: everyone@example.invalid" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, to: ["jo@example.invalid, sam@example.invalid"] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, to: ["Jo <jo@example.invalid>"] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, to: ["jo@example.invalid\r\nBcc: x@example.invalid"] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, from: ["a@example.invalid", "b@example.invalid"] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, to: [] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, cc: ["jo@example.invalid"] })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, to: Array.from({ length: 11 }, (_, i) => `p${i}@example.invalid`) })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, body: "" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, body: "hi \u202e there" })).toBeNull();
  });

  test("the message carries the body exactly, encoded so no line of it can become a header", () => {
    const email = readPersonEmail({ ...EMAIL, subject: "Café ☕", body: "Line one\n\nFrom: forged@example.invalid\nBcc: x@example.invalid" })!;
    const message = atob(gmailRaw(email, FROM).replace(/-/g, "+").replace(/_/g, "/"));
    const [headers, encoded] = message.split("\r\n\r\n");
    expect(headers).not.toContain("forged");
    expect(headers).not.toContain("Bcc");
    expect(headers).toContain("Subject: =?UTF-8?B?");
    const bytes = Uint8Array.from(atob(encoded!.replace(/\r\n/g, "")), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe("Line one\r\n\r\nFrom: forged@example.invalid\r\nBcc: x@example.invalid");
  });
});
