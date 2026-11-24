import { afterEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { TEXTS_CLIENT_ID } from "../functions/textLinks";

/**
 * WHOSE MEMBER CARD A GROUP CHAT'S TURN MAY READ (`lib/texIdentity/cards.ts`;
 * `docs/decisions/texting-assistant/member-cards.md`).
 *
 * Through the real `/agent-texts/group` mint and `/gateway/agent/identity` with `cards: true`: only the newest token of
 * an account holder's own tag, and only the people that tag was minted for.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the `ownTagToken !== args.hashedAccessToken` check removed
 *     → both "an earlier token names nobody ..." tests fail
 *   the client check removed
 *     → nothing fails: a 1:1 grant carries no `texGroup`, which is refused next; the check stays as the first line
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
const CY = "+15555550122";

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, workspaceId };
}

async function pin(t: T) {
  vi.stubEnv("ADMIN_EMAILS", "staff@example.invalid");
  const staff = await createUser(t, "staff@example.invalid");
  await createWorkspace(t, staff, "staff-personal");
  return await createWorkspace(t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
}

/** Ada, Bo and Cy, all linked, with one shared workspace Bo owns and the others are in. */
async function crew(t: T) {
  const ada = await texter(t, "ada", ADA);
  const bo = await texter(t, "bo", BO);
  const cy = await texter(t, "cy", CY);
  const studio = await createWorkspace(t, bo.userId, "studio", { kind: "shared" });
  await addMember(t, studio, ada.userId, "editor");
  await addMember(t, studio, cy.userId, "member");
  return { ada, bo, cy };
}

async function tag(t: T, sender: string, participants: string[]) {
  const answer = await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
  expect(answer.status).toBe("ready");
  return answer.accessToken as string;
}

async function cards(t: T, accessToken: unknown) {
  const response = await gatewayPost(t, "/gateway/agent/identity", { accessToken, cards: true });
  expect(response.status).toBe(200);
  return ((await response.json()) as { cards: Array<{ handle: string; workspaceId: string }> | null }).cards;
}

const byHandle = (list: Array<{ handle: string; workspaceId: string }> | null) => [...(list ?? [])].sort((a, b) => a.handle.localeCompare(b.handle));

for (const pinned of [true, false]) {
  describe(`member cards, ${pinned ? "a chat with its home in the pin" : "a deployment with no pin"}`, () => {
    test("an account holder's own tag reads the people it was minted for, each by their personal workspace", async () => {
      const t = setupTest();
      if (pinned) await pin(t);
      const { ada, bo, cy } = await crew(t);
      const token = await tag(t, ADA, [ADA, BO, CY, LINE]);
      expect(byHandle(await cards(t, token))).toEqual([
        { handle: "ada", workspaceId: String(ada.workspaceId) },
        { handle: "bo", workspaceId: String(bo.workspaceId) },
        { handle: "cy", workspaceId: String(cy.workspaceId) },
      ]);
    });

    test("someone who left the chat is on no newer tag's cards", async () => {
      const t = setupTest();
      if (pinned) await pin(t);
      await crew(t);
      await tag(t, ADA, [ADA, BO, CY, LINE]);
      const after = await tag(t, BO, [ADA, BO, LINE]);
      expect(byHandle(await cards(t, after)).map((card) => card.handle)).toEqual(["ada", "bo"]);
    });

    // A home's one grant takes every tag's token, so an earlier one is nobody's own tag now; with no pin each person's
    // grant is their own, and Ada's token stays her newest own tag until she tags again.
    test(pinned ? "an earlier token names nobody once someone else tagged" : "an earlier token names nobody once its person tagged again", async () => {
      const t = setupTest();
      if (pinned) await pin(t);
      await crew(t);
      const first = await tag(t, ADA, [ADA, BO, CY, LINE]);
      await tag(t, pinned ? BO : ADA, [ADA, BO, CY, LINE]);
      expect(await cards(t, first)).toBeNull();
    });
  });
}

describe("member cards, who may ask", () => {
  test("a 1:1 texting grant reads nobody's, and nor does a dead or malformed token", async () => {
    const t = setupTest();
    const { ada } = await crew(t);
    const accessToken = `cat_cards_${"0".repeat(24)}`;
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthGrants", {
        workspaceId: ada.workspaceId as Id<"workspaces">,
        userId: ada.userId as Id<"users">,
        clientId: TEXTS_CLIENT_ID,
        scopes: ["context:read", "context:write", "context:private"],
        hashedAccessToken: await hashToken(accessToken),
        hashedRefreshToken: "refresh_cards_test",
        accessTokenExpiresAt: Date.now() + 60_000,
        status: "active",
        createdAt: Date.now(),
      });
    });
    expect(await cards(t, accessToken)).toBeNull();
    expect(await cards(t, "cat_unknown_token_000000000000000000")).toBeNull();
    expect(await cards(t, 42)).toBeNull();
  });
});
