import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { api } from "../_generated/api";

/**
 * GUEST MODE IS RETIRED (E2 of the retirement, decided by the owner, 2026-10-31; docs/decisions/texting-assistant/group-guests.md).
 *
 * A grant minted under guest mode (`texGroup.guestGroupId`) reads nothing: the chat it was for is answered from its home
 * now, and a stale guest grant that still resolved would read its workspace at the binder's tier, which is the widening
 * this retirement exists to end. The group-people route that kept guest chats in step is gone with it.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   the `guestGroupId` refusal in `groupStillShares` dropped   -> "a guest grant minted before the retirement reads nothing" fails
 *   the `/agent-texts/group/people` route kept                -> "the group-people route is gone" fails
 */

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";

async function agentPost(t: PinnedWorld["t"], path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function texter(t: PinnedWorld["t"], name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).body.status).toBe("linked");
  return userId;
}

async function resolves(t: PinnedWorld["t"], accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: unknown }).session;
}

describe("guest mode is retired", () => {
  test("a guest grant minted before the retirement reads nothing", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const ada = await texter(w.t, "ada", ADA);
    const bo = await texter(w.t, "bo", BO);
    // A chat with a home, answered as E1 answers it.
    const answer = await agentPost(w.t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender: ADA, participants: [ADA, BO, LINE], mint: true });
    expect(answer.body).toMatchObject({ status: "ready", minted: true });
    const token = answer.body.accessToken as string;
    expect(await resolves(w.t, token)).not.toBeNull();
    // The same token as a guest grant of the old kind, whose binder still owns the pin: the one case the old guest
    // rules would have resolved, so the refusal below is what is being tested, not a missing membership.
    await w.t.run(async (ctx) => {
      const groupId = await ctx.db.insert("workspaceGroups", { workspaceId: w.pinned, name: "legacy-guest-group", createdBy: w.staff, createdAt: 1 });
      const chat = (await ctx.db.query("textGroups").collect())[0]!;
      await ctx.db.patch(chat._id, {
        workspaceId: w.pinned,
        boundBy: w.staff,
        guestGroupId: groupId,
        guestFolder: "tex/chats/legacy-guest-words",
      });
      const grant = (await ctx.db.query("oauthGrants").collect()).find((entry) => entry.texGroup !== undefined)!;
      await ctx.db.patch(grant._id, {
        userId: w.staff,
        texGroup: { groupId: chat._id, coViewerIds: [], meterWorkspaceId: grant.texGroup!.meterWorkspaceId, guestGroupId: groupId, guestTagger: true },
      });
    });
    expect(await resolves(w.t, token)).toBeNull();
  });

  test("the group-people route is gone", async () => {
    const w = await pinnedWorld();
    const response = await w.t.fetch("/agent-texts/group/people", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
      body: JSON.stringify({ line: LINE, groupId: GROUP, participants: [ADA, BO, LINE] }),
    });
    expect(response.status).toBe(404);
  });
});
