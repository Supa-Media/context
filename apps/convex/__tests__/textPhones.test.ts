import { describe, expect, test } from "vitest";
import { createUser, setupTest, TEST_GATEWAY_SECRET } from "./fixtures.helpers";

/**
 * THE PHONES THE NEW-NUMBER NOTICE MAY REACH.
 *
 * Tex's old line is going away, and the Worker tells each phone whose own chat
 * is on it (`apps/agent/src/newLine.ts`). This route only says which phones
 * Tex may know: linked ones and ones let in off the waitlist. Behind the
 * Worker's own secret, phones and nothing else.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";

type T = ReturnType<typeof setupTest>;

async function phones(t: T, secret: string | null = AGENT_SECRET) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  const response = await t.fetch("/agent-texts/phones", { method: "POST", headers, body: "{}" });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

describe("/agent-texts/phones", () => {
  test("refuses without the agent worker's own secret", async () => {
    const t = setupTest();
    for (const secret of [null, "wrong", TEST_GATEWAY_SECRET]) {
      expect((await phones(t, secret)).status).toBe(401);
    }
  });

  test("lists linked and admitted phones once each, and nobody still waiting or removed", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    await t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: ada, phone: "+15555550100", linkedAt: 1 });
      await ctx.db.insert("waitlist", { phone: "+15555550100", status: "admitted", joinedAt: 1, source: "login" });
      await ctx.db.insert("waitlist", { phone: "+15555550101", status: "admitted", joinedAt: 2, source: "login" });
      await ctx.db.insert("waitlist", { phone: "+15555550102", status: "waiting", joinedAt: 3, source: "login" });
      await ctx.db.insert("waitlist", { phone: "+15555550103", status: "removed", joinedAt: 4, source: "login" });
      await ctx.db.insert("waitlist", { email: "bo@example.invalid", status: "admitted", joinedAt: 5, source: "homepage" });
    });
    expect(await phones(t)).toEqual({ status: 200, body: { phones: ["+15555550100", "+15555550101"] } });
  });
});
