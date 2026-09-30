/**
 * `/gateway/feedback`: a problem report an agent files through the gateway's
 * `report_problem` tool.
 *
 * It spends the two proofs every other gateway route spends: the gateway
 * secret, and the person's own access token forwarded verbatim. The control
 * plane resolves the person from the token, so the gateway cannot report on
 * anybody's behalf but the grant's own. From there it is the same intake as
 * the app's bug button: the same checks, the same ten-a-day budget per person
 * (shared with the app), the same Sentry envelope, and nothing of the report
 * stored.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { api } from "../../_generated/api";
import { asUser, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, CLIENT_A, bodyOf, twoConnectedTenants } from "./fixtures.helpers";

const DSN = "https://0123456789abcdef0123456789abcdef@o1.ingest.example.invalid/42";

type Sent = { url: string; body: Uint8Array };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  process.env.FEEDBACK_SENTRY_DSN = DSN;
  delete process.env.FEEDBACK_INTAKE;
  vi.stubGlobal("fetch", async (url: string, init: { body: Uint8Array }) => {
    sent.push({ url: String(url), body: new Uint8Array(init.body) });
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEEDBACK_SENTRY_DSN;
});

const text = (item: Sent) => new TextDecoder().decode(item.body);

async function report(t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"], body: unknown, secret?: string | null) {
  return await bodyOf(await gatewayPost(t, "/gateway/feedback", body, secret === undefined ? {} : { secret }));
}

describe("/gateway/feedback", () => {
  test("files the report as the grant's own person, from that agent", async () => {
    const { t, alice } = await twoConnectedTenants();
    const answer = await report(t, { accessToken: ACCESS_A, message: "search_notes returned nothing for a note that exists" });
    expect(answer.report).toEqual({ eventId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(sent).toHaveLength(1);
    const envelope = text(sent[0]);
    expect(envelope).toContain("search_notes returned nothing for a note that exists");
    expect(envelope).toContain(`"id":"${alice}"`);
    expect(envelope).toContain('"feedback.source":"agent"');
    expect(envelope).toContain(`"feedback.agent_client":"Client ${CLIENT_A}"`);
  });

  test("a wrong secret or none reaches nothing", async () => {
    const { t } = await twoConnectedTenants();
    for (const secret of ["not-the-secret", null]) {
      const response = await gatewayPost(t, "/gateway/feedback", { accessToken: ACCESS_A, message: "x" }, { secret });
      expect(response.status).not.toBe(200);
    }
    expect(sent).toHaveLength(0);
  });

  test("an unknown or revoked token files nothing, and says only that", async () => {
    const { t, grantA } = await twoConnectedTenants();
    // Exactly `{ report: null }`: no refusal word, which is only ever given to
    // a person the token did resolve to.
    expect(await report(t, { accessToken: "cat_nobody_000000000000000000000000", message: "x" })).toEqual({ report: null });
    await t.run((ctx) => ctx.db.patch(grantA, { status: "revoked" }));
    expect(await report(t, { accessToken: ACCESS_A, message: "x" })).toEqual({ report: null });
    expect(sent).toHaveLength(0);
  });

  test("an empty or oversized message is refused before anything is reserved", async () => {
    const { t } = await twoConnectedTenants();
    expect(await report(t, { accessToken: ACCESS_A, message: "   " })).toEqual({ report: null, refused: "invalid" });
    expect(await report(t, { accessToken: ACCESS_A, message: "x".repeat(4_001) })).toEqual({ report: null, refused: "invalid" });
    expect(sent).toHaveLength(0);
  });

  test("the day's budget is the person's, shared with the app's bug button", async () => {
    const { t, alice } = await twoConnectedTenants();
    const as = asUser(t, alice);
    for (let n = 0; n < 9; n += 1) {
      await as.action(api.functions.feedback.submitFeedback, {
        clientReportId: n.toString(16).padStart(24, "0"),
        message: `app report ${n}`,
        source: "top_bar",
        screen: "/console/:context",
        app: { platform: "web" },
      });
    }
    expect((await report(t, { accessToken: ACCESS_A, message: "the tenth" })).report).not.toBeNull();
    expect(await report(t, { accessToken: ACCESS_A, message: "the eleventh" })).toEqual({
      report: null,
      refused: "rate_limited",
    });
    // Another person's budget is their own.
    expect((await report(t, { accessToken: ACCESS_B, message: "bob's first" })).report).not.toBeNull();
  });

  test("a deployment that takes no reports says so", async () => {
    const { t } = await twoConnectedTenants();
    process.env.FEEDBACK_INTAKE = "disabled";
    expect(await report(t, { accessToken: ACCESS_A, message: "x" })).toEqual({ report: null, refused: "not_configured" });
    expect(sent).toHaveLength(0);
  });

  test("an agent report cannot pass itself off as the app's, nor the app's as an agent's", async () => {
    const { t, alice } = await twoConnectedTenants();
    // Extra fields from the gateway are ignored: the source is always agent.
    await report(t, { accessToken: ACCESS_A, message: "x", source: "top_bar", screen: "/console/:context" });
    expect(text(sent[0])).toContain('"feedback.source":"agent"');
    // And the app's own intake still refuses the agent source.
    await expect(
      asUser(t, alice).action(api.functions.feedback.submitFeedback, {
        clientReportId: "a".repeat(24),
        message: "x",
        source: "agent",
        screen: "/console/:context",
        app: { platform: "web" },
      }),
    ).rejects.toThrow();
  });
});
