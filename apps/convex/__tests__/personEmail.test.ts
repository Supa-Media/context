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
 * failing "a Gmail connected to read only sends nothing". Dropping the check
 * that the cleared workspace is the person's own sent from Alice's Gmail on a
 * shared workspace's request, failing "a grant on a shared workspace never
 * reaches its person's own Gmail". Dropping the Message-ID check in
 * `replyHeadersOf` let a forged header through, failing "a thread's headers
 * become headers only when each is one plain message id"; sending a reply
 * when its message was not found (2026-10-20) failed "a reply to an email the
 * mailbox does not hold sends nothing". Choosing the sender without its
 * health failed "a Gmail whose sign-in stopped working never sends…".
 * Dropping the `findReplyThread` call failed both "Re:" tests; dropping its
 * exact-subject check threaded "Re: Welcome" into "Welcome to the team",
 * failing 'a "Re:" email whose subject matches no message…'.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, token, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { replyThreadQuery } from "../functions/lib/personEmailThread";
import { fileHeaders } from "../functions/lib/personEmailForward";
import { GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, PERSON_EMAIL_HOURLY_LIMIT, PERSON_EMAIL_RECIPIENT_DAILY_LIMIT, gmailRaw, readPersonEmail, recipientLimitKey, replyHeadersOf } from "../functions/lib/personEmail";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** An email to forward, as Gmail's full read returns it: a text part and one PDF. */
const RECEIPT = {
  id: "18rcpt",
  threadId: "18rcpt",
  internalDate: String(Date.UTC(2026, 9, 21, 15, 0)),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Anthropic <invoice@billing.example.invalid>" },
      { name: "To", value: "alice@gmail.example" },
      { name: "Subject", value: "Your receipt from Anthropic" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: btoa("Paid $212.00.") } },
      { mimeType: "application/pdf", filename: "Receipt-2508.pdf", body: { attachmentId: "att_1", size: 16 } },
    ],
  },
};

/** The message a reply answers, as Gmail's metadata read returns it. */
const ANSWERED = {
  id: "18cafe",
  threadId: "18beef",
  payload: {
    headers: [
      { name: "Message-ID", value: "<second@mail.example.invalid>" },
      { name: "References", value: "<first@mail.example.invalid>" },
      { name: "Subject", value: "Welcome" },
    ],
  },
};

/**
 * Gmail, answered here; anything else goes where it was going. Each sent
 * message, decoded, with the threadId it was sent in. A metadata read answers
 * from `messages` by id, or 404.
 */
function gmail(status = 200, messages: Record<string, unknown> = { [ANSWERED.id]: ANSWERED }, found: string[] = [], searched: string[] = []) {
  const sent: Array<{ auth: string | null; message: string; threadId?: string; url: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    if ((init?.method ?? "GET") === "GET" && new URL(url).pathname.endsWith("/users/me/messages")) {
      searched.push(new URL(url).searchParams.get("q") ?? "");
      return new Response(JSON.stringify({ messages: found.map((id) => ({ id })) }));
    }
    if ((init?.method ?? "GET") === "GET") {
      const id = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
      return Object.hasOwn(messages, id) ? new Response(JSON.stringify(messages[id])) : new Response("{}", { status: 404 });
    }
    // A forward goes up whole, as `message/rfc822`, through the upload endpoint.
    if (url.startsWith("https://gmail.googleapis.com/upload/")) {
      const headers = new Headers(init?.headers);
      sent.push({ auth: headers.get("Authorization"), message: new TextDecoder().decode(init?.body as Uint8Array), url });
      return new Response(JSON.stringify({ id: "msg_fake" }), { status });
    }
    const posted = JSON.parse(String(init?.body));
    const body = posted.message ?? posted;
    const raw = String(body.raw).replace(/-/g, "+").replace(/_/g, "/");
    const headers = new Headers(init?.headers);
    sent.push({ auth: headers.get("Authorization"), message: atob(raw), threadId: body.threadId, url });
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

describe("who counts as one recipient", () => {
  test("a Gmail address is one mailbox however it is spelled", () => {
    expect(recipientLimitKey("j.o+news@googlemail.com")).toBe("jo@gmail.com");
    expect(recipientLimitKey("JO@Gmail.com")).toBe("jo@gmail.com");
    expect(recipientLimitKey("j.o+x@example.invalid")).toBe("j.o+x@example.invalid");
  });
});

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

  test("a grant on a shared workspace never reaches its person's own Gmail", async () => {
    const sent = gmail();
    const { t, alice, aliceWs } = await connected();
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await send(t, ACCESS_A, shared, { check: true })).toEqual({ ok: false, refused: "not_allowed" });
    expect(await send(t, ACCESS_A, shared)).toEqual({ ok: false, refused: "not_allowed" });
    expect(sent).toHaveLength(0);
    // ...while the same grant still sends from the person's own workspace.
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: true, from: FROM });
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

  test("another spelling of a Gmail address is the same recipient", async () => {
    gmail();
    const { t, aliceWs } = await connected();
    const jo = { ...EMAIL, to: ["jo@gmail.com"] };
    for (let i = 0; i < PERSON_EMAIL_RECIPIENT_DAILY_LIMIT; i++) expect((await send(t, ACCESS_A, aliceWs, { email: jo })).ok).toBe(true);
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, to: ["j.o+again@googlemail.com"] } })).toEqual({ ok: false, refused: "recipient_limit" });
  });

  test("a reply goes inside the thread of the email it answers", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM, replyTo: ANSWERED.id } })).toEqual({ ok: true, from: FROM });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe(ANSWERED.threadId);
    expect(sent[0]!.message).toContain(
      "In-Reply-To: <second@mail.example.invalid>\r\nReferences: <first@mail.example.invalid> <second@mail.example.invalid>\r\n",
    );
  });

  test("a draft reply sits in that thread too", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("googleConnections").collect()) await ctx.db.patch(row._id, { scopes: [...(row.scopes ?? []), GMAIL_COMPOSE_SCOPE] });
    });
    const answer = await bodyOf(
      await gatewayPost(t, "/gateway/email/draft", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs, email: { ...EMAIL, from: FROM, replyTo: ANSWERED.id } }),
    );
    expect(answer).toEqual({ ok: true, from: FROM });
    expect(sent[0]!.url).toContain("/drafts");
    expect(sent[0]!.threadId).toBe(ANSWERED.threadId);
    expect(sent[0]!.message).toContain("In-Reply-To: <second@mail.example.invalid>");
  });

  test('a "Re:" email with no thread named joins the thread it answers', async () => {
    const searched: string[] = [];
    const sent = gmail(200, { [ANSWERED.id]: ANSWERED }, [ANSWERED.id], searched);
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM, subject: "RE: welcome" } })).toEqual({ ok: true, from: FROM });
    expect(searched).toEqual(['subject:"welcome" {from:jo@example.invalid OR to:jo@example.invalid OR cc:jo@example.invalid} -in:draft -in:trash -in:spam']);
    expect(sent[0]!.threadId).toBe(ANSWERED.threadId);
    expect(sent[0]!.message).toContain("In-Reply-To: <second@mail.example.invalid>");
  });

  test('a "Re:" email whose subject matches no message, or that is not a reply, goes as a new email', async () => {
    const searched: string[] = [];
    const other = { ...ANSWERED, id: "18other", payload: { headers: [...ANSWERED.payload.headers.slice(0, 2), { name: "Subject", value: "Welcome to the team" }] } };
    const sent = gmail(200, { [other.id]: other }, [other.id], searched);
    const { t, aliceWs } = await connected();
    expect((await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM, subject: "Re: Welcome" } })).ok).toBe(true);
    expect((await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM } })).ok).toBe(true);
    expect(searched).toHaveLength(1);
    expect(sent.map((mail) => mail.threadId)).toEqual([undefined, undefined]);
    expect(sent[0]!.message).not.toContain("In-Reply-To");
    expect(replyThreadQuery({ subject: "Re: Welcome", to: ["a}OR{b@example.invalid"], cc: [] })).toBeNull();
  });

  test("a reply to an email the mailbox does not hold sends nothing", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM, replyTo: "18gone" } })).toEqual({ ok: false, refused: "reply_not_found" });
    expect(sent).toHaveLength(0);
  });

  test("a Gmail whose sign-in stopped working never sends: another one does, or the person is told to reconnect", async () => {
    const sent = gmail();
    const { t, aliceWs, alice } = await connected();
    const first = await t.run(async (ctx) => (await ctx.db.query("googleConnections").collect())[0]!._id);
    await t.run((ctx) => ctx.db.patch(first, { health: "reconnect_required" }));
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "reconnect_required" });
    expect(sent).toHaveLength(0);
    await connectGmail(t, aliceWs, alice, { address: "alice.work@gmail.example" });
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: true, from: "alice.work@gmail.example" });
    expect(sent).toHaveLength(1);
  });

  test("a forward sends the person's words, the email below them, and its attachment, from that mailbox", async () => {
    const pdf = btoa("%PDF-1.4 receipt").replace(/\+/g, "-").replace(/\//g, "_");
    const sent = gmail(200, {
      [RECEIPT.id]: RECEIPT,
      att_1: { data: pdf },
    });
    const { t, aliceWs } = await connected();
    const email = { ...EMAIL, from: FROM, subject: "Fwd: Your receipt", body: "For the books.", forward: RECEIPT.id };
    expect(await send(t, ACCESS_A, aliceWs, { email })).toEqual({ ok: true, from: FROM });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toContain("/upload/gmail/v1/users/me/messages/send?uploadType=media");
    const message = sent[0]!.message;
    expect(message).toContain(`From: ${FROM}\r\nTo: jo@example.invalid\r\nSubject: Fwd: Your receipt\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed;`);
    expect(message).toContain('Content-Type: application/pdf; name="Receipt-2508.pdf"');
    expect(message).toContain(btoa("%PDF-1.4 receipt"));
    const text = atob(message.split('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1]!.split("\r\n--")[0]!.replace(/\r\n/g, ""));
    expect(text).toContain("For the books.\r\n\r\n---------- Forwarded message ---------\r\nFrom: Anthropic <invoice@billing.example.invalid>");
    expect(text).toContain("Subject: Your receipt from Anthropic");
    expect(text).toContain("Paid $212.00.");
  });

  test("a forward of an email the mailbox does not hold sends nothing", async () => {
    const sent = gmail();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, { email: { ...EMAIL, from: FROM, forward: "18gone" } })).toEqual({ ok: false, refused: "forward_not_found" });
    expect(sent).toHaveLength(0);
  });

  test("a Gmail failure is reported, not called sent", async () => {
    gmail(500);
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "unavailable" });
  });
});

describe("what an email may be", () => {
  test("anything that could add a header or a hidden recipient is refused", () => {
    expect(readPersonEmail(EMAIL)).toEqual({ ...EMAIL, from: null, cc: [], replyTo: null, forward: null });
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
    expect(readPersonEmail({ ...EMAIL, from: FROM, replyTo: "18cafe/../x" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, replyTo: "18cafe" })).toBeNull();
    // A forward goes from the mailbox that holds it, names one plain id, and is never also a reply.
    expect(readPersonEmail({ ...EMAIL, forward: "18rcpt" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, from: FROM, forward: "18rcpt/../x" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, from: FROM, forward: "18rcpt", replyTo: "18cafe" })).toBeNull();
    expect(readPersonEmail({ ...EMAIL, from: FROM, forward: "18rcpt" })?.forward).toBe("18rcpt");
  });

  test("a forwarded file's name and type never become a header of their own", () => {
    const [type, disposition] = fileHeaders({ filename: 'a"\r\nBcc: x@example.invalid.pdf', contentType: "application/pdf\r\nBcc: y" });
    expect(type).toBe('Content-Type: application/octet-stream; name="a Bcc: x@example.invalid.pdf"');
    expect(disposition).toBe('Content-Disposition: attachment; filename="a Bcc: x@example.invalid.pdf"');
    expect(fileHeaders({ filename: "Reçu.pdf", contentType: "application/pdf" })[1]).toBe(
      "Content-Disposition: attachment; filename=\"Re_u.pdf\"; filename*=UTF-8''Re%C3%A7u.pdf",
    );
  });

  test("a thread's headers become headers only when each is one plain message id", () => {
    expect(replyHeadersOf(ANSWERED)).toEqual({
      threadId: "18beef",
      inReplyTo: "<second@mail.example.invalid>",
      references: ["<first@mail.example.invalid>", "<second@mail.example.invalid>"],
    });
    const forged = (value: string) => ({ ...ANSWERED, payload: { headers: [{ name: "Message-ID", value }] } });
    expect(replyHeadersOf(forged("<a@b>\r\nBcc: x@example.invalid"))).toBeNull();
    expect(replyHeadersOf(forged("<a b@c>"))).toBeNull();
    expect(replyHeadersOf(forged("no-brackets@example.invalid"))).toBeNull();
    expect(replyHeadersOf({ ...ANSWERED, threadId: "../x" })).toBeNull();
    const references = replyHeadersOf({
      ...ANSWERED,
      payload: { headers: [ANSWERED.payload.headers[0]!, { name: "References", value: "<ok@x> <bad\r\nBcc:x> " + Array.from({ length: 30 }, (_, i) => `<r${i}@x>`).join(" ") }] },
    })!;
    expect(references.references).toHaveLength(20);
    expect(references.references.at(-1)).toBe("<second@mail.example.invalid>");
    expect(references.references.join(" ")).not.toContain("Bcc");
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
