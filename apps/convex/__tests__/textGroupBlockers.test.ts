import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";

/**
 * A GROUP CHAT IS TOLD WHO KEEPS IT FROM A WORKSPACE (Dev2, 2026-11-16, after a chat lost its shared workspace
 * overnight when someone joined who isn't a member, and Tex could only say "this chat can't see it").
 *
 * Since 2026-11-25 a text reads its asker's own shared workspaces (`docs/decisions/texting-assistant/asker-reach.md`).
 * The turn's answer names, for each of the asker's shared workspaces the whole chat does not share, who here is not a
 * member of it and who here has no linked account (`lib/textGroupBlockers.ts`), so Tex can judge what fits the room.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `reachBlockers` naming a workspace the asker isn't in  -> "a workspace the asker isn't in is never named" fails
 *   `reachBlockers` not skipping reached workspaces       -> "a chat that reaches everything names nothing" fails
 *   guests left out of the blockers                       -> "a person with no account is named by label" fails
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
const CY = "+15555550122";
const GUEST = "+15555550133";

type T = PinnedWorld["t"];
type Blocker = { slug: string; who: string; why: string };

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId };
}

async function turn(t: T, sender: string, participants: string[]) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
}

/** Ada and Bo share @ember-co and @fjord-co; Cy has an account and is in neither. Ada's first turn makes her the sponsor. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const cy = await texter(w.t, "cy", CY);
  const ember = await createWorkspace(w.t, bo.userId, "ember-co", { kind: "shared" });
  await addMember(w.t, ember, ada.userId, "editor");
  const fjord = await createWorkspace(w.t, bo.userId, "fjord-co", { kind: "shared" });
  await addMember(w.t, fjord, ada.userId, "editor");
  expect(await turn(w.t, ADA, [ADA, BO, LINE])).toMatchObject({ status: "ready", reach: ["ember-co", "fjord-co"] });
  return { ...w, ada, bo, cy, ember, fjord };
}

const blockedOf = (answer: Record<string, unknown>) => (answer.blocked ?? []) as Blocker[];

describe("who keeps a chat from a workspace", () => {
  test("a chat that reaches everything names nothing", async () => {
    const w = await world();
    expect(blockedOf(await turn(w.t, BO, [ADA, BO, LINE]))).toEqual([]);
  });

  test("someone who joins and isn't a member is named for each of the asker's workspaces, which the asker still reads", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: ["ember-co", "fjord-co"] });
    const blocked = blockedOf(answer);
    expect(blocked.map((entry) => entry.slug)).toEqual(["ember-co", "fjord-co"]);
    for (const entry of blocked) expect(entry).toMatchObject({ why: "not_member" });
    expect(new Set(blocked.map((entry) => entry.who)).size).toBe(1);
    expect(blocked[0].who).not.toMatch(/\+?\d{7,}/);
    // Adding them to one gives that one back and names only the other.
    await addMember(w.t, w.ember, w.cy.userId, "member");
    const after = await turn(w.t, ADA, [ADA, BO, CY, LINE]);
    expect(after).toMatchObject({ reach: ["ember-co", "fjord-co"] });
    expect(blockedOf(after).map((entry) => entry.slug)).toEqual(["fjord-co"]);
  });

  test("a person with no account is named by label, never by number", async () => {
    const w = await world();
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    expect(answer).toMatchObject({ reach: ["ember-co", "fjord-co"] });
    const blocked = blockedOf(answer);
    expect(blocked.map((entry) => entry.slug)).toEqual(["ember-co", "fjord-co"]);
    for (const entry of blocked) expect(entry).toMatchObject({ why: "no_account", who: expect.stringMatching(/^guest-[0-9a-f]{4}$/) });
    expect(JSON.stringify(blocked)).not.toContain(GUEST.slice(2));
  });

  test("a guest who asks is told nothing", async () => {
    const w = await world();
    expect(blockedOf(await turn(w.t, GUEST, [ADA, BO, GUEST, LINE]))).toEqual([]);
  });

  test("the asker's own workspace the sponsor isn't in is read, and the sponsor named as not in it", async () => {
    const w = await world();
    // Bo and Cy share @gale-co; Ada, the sponsor, does not. Bo asks with Cy here.
    const gale = await createWorkspace(w.t, w.bo.userId, "gale-co", { kind: "shared" });
    await addMember(w.t, gale, w.cy.userId, "editor");
    const answer = await turn(w.t, BO, [ADA, BO, CY, LINE]);
    expect(answer).toMatchObject({ reach: ["ember-co", "fjord-co", "gale-co"] });
    const blocked = blockedOf(answer);
    expect(blocked.map((entry) => entry.slug)).toEqual(["ember-co", "fjord-co", "gale-co"]);
    expect(blocked.find((entry) => entry.slug === "gale-co")).toMatchObject({ who: "ada", why: "not_member" });
  });

  test("a workspace the asker isn't in is never named, though the sponsor is in it", async () => {
    const w = await world();
    // Ada, the sponsor, and Bo share both; Cy asks and is in neither, so nothing is Cy's to name.
    const answer = await turn(w.t, CY, [ADA, BO, CY, LINE]);
    expect(answer).toMatchObject({ reach: [] });
    expect(blockedOf(answer)).toEqual([]);
  });
});
