/**
 * A draft a person's AI saves lands in that person's own Gmail Drafts, only
 * through a connection that granted `gmail.compose`, and is never sent
 * (`gatewayPersonEmailDraftHandler` in `functions/lib/gatewayRoutes/personEmail.ts`).
 *
 * ## Sabotage record
 *
 * Checking `GMAIL_SEND_SCOPE` for a draft in `claimPersonEmail` saved one
 * through a send-only connection, failing "a Gmail that may only send saves no
 * draft". Posting a draft to the send endpoint failed "it lands in Drafts and
 * is never sent". Spending the sending policies for a draft failed "a draft
 * spends none of the sending limits".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { GMAIL_COMPOSE_SCOPE, GMAIL_SEND_SCOPE, PERSON_EMAIL_DRAFT_HOURLY_LIMIT, PERSON_EMAIL_HOURLY_LIMIT } from "../functions/lib/personEmail";

const realFetch = globalThis.fetch;
const READ = "https://www.googleapis.com/auth/gmail.readonly";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Gmail, answered here: each call's endpoint and decoded message. */
function gmail(status = 200) {
  const calls: Array<{ url: string; message: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const raw = String(body.message?.raw ?? body.raw).replace(/-/g, "+").replace(/_/g, "/");
    calls.push({ url, message: atob(raw) });
    return new Response(JSON.stringify({ id: "draft_fake" }), { status });
  });
  return calls;
}

async function connected(scopes: string[]) {
  const tenants = await twoConnectedTenants();
  const id = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: "alice@gmail.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: tenants.aliceWs });
  await tenants.t.run((ctx) => ctx.db.patch(id, { scopes, encryptedAccessToken, accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 }));
  return tenants;
}

const EMAIL = { to: ["jo@example.invalid"], subject: "Thursday works", body: "Hi Jo,\n\nThursday at 3 works for me." };

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function post(t: Tenants["t"], path: string, accessToken: string, workspaceId: string) {
  return await bodyOf(await gatewayPost(t, path, { accessToken, expectedWorkspaceId: workspaceId, email: EMAIL }));
}

describe("saving an email as a draft in the person's Gmail", () => {
  test("it lands in Drafts and is never sent, and nothing of it is kept", async () => {
    const calls = gmail();
    const { t, aliceWs } = await connected([READ, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE]);
    expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: true, from: "alice@gmail.example" });
    expect(calls.map((call) => call.url)).toEqual(["https://gmail.googleapis.com/gmail/v1/users/me/drafts"]);
    expect(calls[0]!.message).toContain("To: jo@example.invalid\r\nSubject: Thursday works\r\n");
    const kept = await t.run(async (ctx) => ({
      limits: await ctx.db.query("rateLimits").collect(),
      audit: (await ctx.db.query("auditEvents").collect()).filter((row) => row.action === "save_email_draft"),
    }));
    expect(JSON.stringify(kept)).not.toContain("jo@example.invalid");
    expect(JSON.stringify(kept)).not.toContain("Thursday");
    expect(kept.audit).toHaveLength(1);
  });

  test("a Gmail that may only send saves no draft", async () => {
    const calls = gmail();
    const { t, aliceWs } = await connected([READ, GMAIL_SEND_SCOPE]);
    expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_sender" });
    expect(calls).toHaveLength(0);
  });

  test("a Gmail that may only compose saves a draft but sends nothing", async () => {
    const calls = gmail();
    const { t, aliceWs } = await connected([READ, GMAIL_COMPOSE_SCOPE]);
    expect(await post(t, "/gateway/email/send", ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_sender" });
    expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: true, from: "alice@gmail.example" });
    expect(calls.map((call) => call.url.endsWith("/drafts"))).toEqual([true]);
  });

  test("another tenant's token cannot save a draft in their Gmail", async () => {
    const calls = gmail();
    const { t, aliceWs } = await connected([READ, GMAIL_COMPOSE_SCOPE]);
    expect(await post(t, "/gateway/email/draft", ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toHaveLength(0);
  });

  test("a draft spends none of the sending limits, and drafts have an hourly limit of their own", async () => {
    const calls = gmail();
    const { t, aliceWs } = await connected([READ, GMAIL_SEND_SCOPE, GMAIL_COMPOSE_SCOPE]);
    for (let i = 0; i < PERSON_EMAIL_DRAFT_HOURLY_LIMIT; i += 1) {
      expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: true, from: "alice@gmail.example" });
    }
    expect(PERSON_EMAIL_DRAFT_HOURLY_LIMIT).toBeGreaterThan(PERSON_EMAIL_HOURLY_LIMIT);
    expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "hourly_limit" });
    // The same address, drafted to ten times, can still be sent to.
    expect(await post(t, "/gateway/email/send", ACCESS_A, aliceWs)).toEqual({ ok: true, from: "alice@gmail.example" });
    expect(calls).toHaveLength(PERSON_EMAIL_DRAFT_HOURLY_LIMIT + 1);
  });

  test("a Gmail failure is reported, not called saved", async () => {
    gmail(500);
    const { t, aliceWs } = await connected([READ, GMAIL_COMPOSE_SCOPE]);
    expect(await post(t, "/gateway/email/draft", ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "unavailable" });
  });
});
