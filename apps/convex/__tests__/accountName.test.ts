import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * The person's own name on their account, after sign-up (`functions/accountName.ts`,
 * `functions/lib/gatewayRoutes/accountName.ts`). Dev2, 2026-11-25: a group asked Tex for someone's last name and the
 * account held only the first name typed at sign-up.
 *
 * Sabotage record (each broken by hand, the named tests failed, then restored):
 *  - `textedOwner` with both its client check and its `texGroup` check removed → "a group chat's token can never
 *    rename anyone" (either one alone still refuses a group chat's token; they are two guards on purpose).
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "9A1B2C3D-4E5F-4061-8273-94A5B6C7D8E9";
const ADA = "+15555550140";
const BO = "+15555550151";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return userId;
}

const nameOf = async (t: T, userId: string) => (await t.run(async (ctx) => (await ctx.db.get(userId as never)) as { name?: string } | null))?.name;
const named = async (t: T, accessToken: string, body: Record<string, unknown> = {}) =>
  (await (await gatewayPost(t, "/gateway/account/name", { accessToken, ...body })).json()) as Record<string, unknown>;

describe("the name on a person's account", () => {
  test("the app sets their own name, trimmed, and refuses an empty or overlong one", async () => {
    const t = setupTest();
    const ada = await createUser(t, "ada@example.invalid");
    expect(await asUser(t, ada).mutation(api.functions.accountName.setMyName, { name: "  Ada   Lovelace " })).toEqual({ name: "Ada Lovelace" });
    expect(await asUser(t, ada).query(api.functions.accountName.myName, {})).toEqual({ name: "Ada Lovelace" });
    await expect(asUser(t, ada).mutation(api.functions.accountName.setMyName, { name: "   " })).rejects.toThrow(/1 to 80/);
    await expect(asUser(t, ada).mutation(api.functions.accountName.setMyName, { name: "x".repeat(81) })).rejects.toThrow(/1 to 80/);
    expect(await nameOf(t, ada)).toBe("Ada Lovelace");
  });

  test("their own chat with Tex reads and sets it", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const opened = await agentPost(t, "/agent-texts/session", { phone: ADA });
    const token = opened.accessToken as string;
    expect(await named(t, token)).toEqual({ status: "done", name: null });
    expect(await named(t, token, { name: "Ada Lovelace" })).toEqual({ status: "done", name: "Ada Lovelace" });
    expect(await nameOf(t, ada)).toBe("Ada Lovelace");
    expect(await named(t, token, { name: "" })).toEqual({ status: "invalid" });
    expect(await named(t, token, { name: 7 })).toEqual({ status: "invalid" });
    expect(await nameOf(t, ada)).toBe("Ada Lovelace");
  });

  test("a group chat's token can never rename anyone, even the tagger's own tag", async () => {
    const t = setupTest();
    const ada = await texter(t, "ada", ADA);
    const bo = await texter(t, "bo", BO);
    const studio = await createWorkspace(t, ada, "studio", { kind: "shared" });
    await addMember(t, studio, bo, "editor");
    const before = await nameOf(t, ada);
    const tagged = await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true });
    expect(typeof tagged.accessToken).toBe("string");
    expect(await named(t, tagged.accessToken as string, { name: "Someone Else" })).toEqual({ status: "refused" });
    expect(await named(t, tagged.accessToken as string)).toEqual({ status: "refused" });
    expect(await nameOf(t, ada)).toBe(before);
  });

  test("any other client's token, or none, is refused", async () => {
    const t = setupTest();
    await texter(t, "ada", ADA);
    expect(await named(t, "not-a-real-token", { name: "Ada Lovelace" })).toEqual({ status: "refused" });
    expect((await (await gatewayPost(t, "/gateway/account/name", {})).json())).toEqual({ status: "bad_request" });
  });
});
