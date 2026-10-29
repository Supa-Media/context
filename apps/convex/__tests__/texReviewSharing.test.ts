/**
 * SHARING TEX CONVERSATIONS WITH THE DEVS, BY TEXT (`functions/texReviews.ts`
 * `setTextsReviewSharing`, Dev2, 2026-10-29).
 *
 *  1. The Worker's route needs its own secret, and is keyed by the phone that
 *     texted: a yes or no is that person's alone, the same switch as
 *     Settings → Feedback.
 *  2. An unlinked phone changes nothing.
 *  3. Asking changes nothing.
 *  4. In a group, the answer says whether everybody in it now counts, as one
 *     yes or no, naming nobody; one unlinked person keeps it no.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * ## Sabotage record
 *
 *   `setTextsReviewSharing` setting the switch on a question       1 failed ("asking changes nothing")
 *   `chatShared` counting only the sender                          1 failed ("a group counts only once…")
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { asUser, createUser, createWorkspace, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const ADA = "+15555550100";
const BO = "+15555550111";
const CY = "+15555550122";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, json: JSON.parse((await response.text()) || "null") as Record<string, unknown> };
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).json.status).toBe("linked");
  return userId;
}

const sharing = (t: T, userId: Awaited<ReturnType<typeof texter>>) => asUser(t, userId).query(api.functions.texReviews.myTexReviewSharing, {});

describe("texting yes or no to sharing with the devs", () => {
  test("the Worker's own secret, the phone's own switch, and the same one Settings shows", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const bo = await texter(t, "bo", BO);
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, share: true }, TEST_GATEWAY_SECRET)).status).toBe(401);
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, share: "yes" })).status).toBe(400);
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, share: true })).json).toEqual({ status: "ok", sharing: true, changed: true, team: false });
    expect(await sharing(t, ada)).toBe(true);
    expect(await sharing(t, bo)).toBe(false);
    // Said again: still yes, nothing new.
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, share: true })).json).toMatchObject({ sharing: true, changed: false });
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, share: false })).json).toMatchObject({ sharing: false, changed: true });
    expect(await sharing(t, ada)).toBe(false);
  });

  test("an unlinked phone changes nothing", async () => {
    const t = setupTest();
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: CY, share: true })).json).toEqual({ status: "unlinked" });
    expect(await t.run((ctx) => ctx.db.query("texReviewSharing").collect())).toEqual([]);
  });

  test("asking changes nothing", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA })).json).toEqual({ status: "ok", sharing: false, changed: false, team: false });
    expect(await sharing(t, ada)).toBe(false);
  });

  test("a group counts only once everybody in it said yes, and one unlinked person keeps it out", async () => {
    const t = setupTest();
    await texter(t, "ada", ADA);
    await texter(t, "bo", BO);
    const said = (phone: string, participants: string[]) => agentPost(t, "/agent-texts/review-sharing", { phone, share: true, participants });
    expect((await said(ADA, [ADA, BO])).json).toMatchObject({ sharing: true, chatShared: false });
    expect((await said(BO, [ADA, BO])).json).toMatchObject({ sharing: true, chatShared: true });
    expect((await said(BO, [ADA, BO, CY])).json).toMatchObject({ sharing: true, chatShared: false });
    expect((await agentPost(t, "/agent-texts/review-sharing", { phone: ADA, participants: Array(70).fill(ADA) })).status).toBe(400);
  });
});
