import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { holderKey } from "../functions/lib/texIdentity/holders";

/**
 * WHO HERE CAN OPEN A WORKSPACE THE CHAT NAMED (Dev2, 2026-11-25, rulebook rule 2: someone without access gets "a
 * neutral boundary naming who holds the keys"; `docs/decisions/texting-assistant/asker-reach.md`).
 *
 * Jo asks about @harbor-care, which Jo is not in, so Jo's turn reads nothing of it; this lookup names who here is a
 * member, for that one workspace. The chat: Sam and Sol are in @harbor-care, Jo is not; all three are in @studio-co;
 * Ana, who is not in the chat, owns @far-co.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   `workspaceHoldersHandler` reading every member, not the chat's people -> "names only people in this chat" fails
 *   `workspaceHoldersHandler` dropping the shared-only check              -> "never a personal workspace" fails
 *   `workspaceHoldersHandler` answering without a group chat's live grant -> "only a group chat's grant may ask" fails
 */

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "6E2F3A4B-C5D6-4E7F-8071-92B3C4D5E6F7";
const SAM = "+15555550200";
const SOL = "+15555550211";
const JO = "+15555550222";
const EVERYONE = [SAM, SOL, JO, LINE];

type T = PinnedWorld["t"];

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` }, body: JSON.stringify(body) });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const personal = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, personal };
}

async function turn(t: T, sender: string, participants: string[] = EVERYONE) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
}

async function holders(t: T, accessToken: unknown, workspace: string) {
  const response = await gatewayPost(t, "/gateway/agent/identity", { accessToken, holders: workspace });
  return ((await response.json()) as { holders: unknown }).holders;
}

async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const sam = await texter(w.t, "sam", SAM);
  const sol = await texter(w.t, "sol", SOL);
  const jo = await texter(w.t, "jo", JO);
  const harbor = await createWorkspace(w.t, sam.userId, "harbor-care", { kind: "shared" });
  await addMember(w.t, harbor, sol.userId, "editor");
  const studio = await createWorkspace(w.t, sam.userId, "studio-co", { kind: "shared" });
  await addMember(w.t, studio, sol.userId, "editor");
  await addMember(w.t, studio, jo.userId, "member");
  const ana = await createUser(w.t, "ana@example.invalid");
  const far = await createWorkspace(w.t, ana, "far-co", { kind: "shared" });
  await addMember(w.t, far, sol.userId, "member");
  expect(await turn(w.t, SAM)).toMatchObject({ status: "ready" });
  return { ...w, sam, sol, jo, harbor, studio, ana, far };
}

describe("who here can open a workspace the chat named", () => {
  test("Jo, who can't open @harbor-care, learns that Sam and Sol here can, by handle or by name", async () => {
    const w = await world();
    const jo = await turn(w.t, JO);
    expect(jo.reach).toEqual(["studio-co"]);
    expect(await holders(w.t, jo.accessToken, "@harbor-care")).toEqual({ slug: "harbor-care", holders: ["sam", "sol"] });
    expect(await holders(w.t, jo.accessToken, "Harbor Care")).toEqual({ slug: "harbor-care", holders: ["sam", "sol"] });
    expect(await holders(w.t, jo.accessToken, "studio-co")).toEqual({ slug: "studio-co", holders: ["jo", "sam", "sol"] });
  });

  test("names only people in this chat: Ana, who owns @far-co, is not here, and Sol is", async () => {
    const w = await world();
    const jo = await turn(w.t, JO);
    expect(await holders(w.t, jo.accessToken, "far-co")).toEqual({ slug: "far-co", holders: ["sol"] });
    // Once Sol leaves the chat, nobody here is in it, which answers the same as a workspace that doesn't exist.
    const after = await turn(w.t, JO, [SAM, JO, LINE]);
    expect(await holders(w.t, after.accessToken, "far-co")).toEqual({ slug: null, holders: [] });
    expect(await holders(w.t, after.accessToken, "no-such-place")).toEqual({ slug: null, holders: [] });
  });

  test("never a personal workspace or the pinned one", async () => {
    const w = await world();
    const jo = await turn(w.t, JO);
    expect(await holders(w.t, jo.accessToken, "sam")).toEqual({ slug: null, holders: [] });
    expect(await holders(w.t, jo.accessToken, "context-lc")).toEqual({ slug: null, holders: [] });
  });

  test("only a group chat's grant may ask: a made-up or empty token gets null", async () => {
    const w = await world();
    expect(await holders(w.t, "not-a-token", "harbor-care")).toBeNull();
    expect(await holders(w.t, "", "harbor-care")).toBeNull();
    const jo = await turn(w.t, JO);
    expect(await holders(w.t, jo.accessToken, "")).toBeNull();
  });

  test("a name is matched the way people say it", () => {
    expect(holderKey("@Crystal Care")).toBe("crystal-care");
    expect(holderKey("  crystal_care ")).toBe("crystal-care");
    expect(holderKey("Crystal  Care!")).toBe("crystal-care");
  });
});
