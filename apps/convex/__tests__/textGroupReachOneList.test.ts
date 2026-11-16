import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost } from "./fixtures.helpers";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { syncSignInNumber } from "../functions/lib/numberList";

/**
 * ONE LIST OF NUMBERS, AND REACH BY MEMBERSHIP (Dev2, 2026-11-16: "there should only be 1 list, having an account
 * gives you access to Tex, there is no separation" and "some guests are added to workspaces so the entire premise is
 * wrong"; `lib/textGroupAccounts.ts` `linkedUser`, `lib/textGroupReach.ts`, `lib/textGroupBlockers.ts`).
 *
 * A number is a person's account whether it was linked by a code texted to Tex or confirmed at the app's phone
 * sign-in. Someone with no account at all counts in a workspace that invited their number, at that invitation's role,
 * and keeps the chat from every other one; revoking the invitation drops it on the chat's next call.
 *
 * ## Sabotage record (run by hand; each must fail a test here)
 *
 *   the sign-in number left off the list (`syncSignInNumber`) -> "an account made by a phone sign-in ..." fails
 *   `invitedByNumber` keeping the row's role                  -> "... at the invitation's role" fails
 *   `liveReach` called without the grant's `reachGuests`      -> "revoking the invitation ..." fails
 *   `reachBlockers` naming a guest invited by number          -> "... named only where they aren't invited" fails
 *   `reachOf` ignoring `guests`                               -> textGroupReach "a person with no account means home only" fails
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
const NIA = "+15555550144";
const GUEST = "+15555550133";

type T = PinnedWorld["t"];
type Row = { workspaceId: string; slug?: string; role?: string };
type Session = { workspaces: Row[] };
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
  return userId;
}

/** An account made by the app's phone sign-in: the number confirmed on it, never linked by a code texted to Tex. */
async function signedInByPhone(t: T, name: string, phone: string) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { phone, phoneVerificationTime: Date.now(), isActive: true, createdAt: Date.now() });
    await syncSignInNumber(ctx, id); // what every sign-in that confirms a number does (`lib/numberList.ts`)
    return id;
  });
  await createWorkspace(t, userId, name, { kind: "personal" });
  return userId;
}

async function inviteByNumber(t: T, workspaceId: Id<"workspaces">, invitedBy: Id<"users">, phone: string, role: "editor" | "member") {
  return await t.run(async (ctx) =>
    await ctx.db.insert("workspaceInvitations", {
      workspaceId,
      inviteeKind: "phone",
      invitee: phone,
      role,
      invitedBy,
      token: `test-token-${phone}`,
      status: "pending",
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    } as never),
  );
}

async function turn(t: T, sender: string, participants: string[]) {
  return await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });
}

async function resolves(t: T, accessToken: string): Promise<Session | null> {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Session | null }).session;
}

/** Ada and Bo text Tex; both are in @ember-co (Ada edits) and @fjord-co (Ada edits). Bo owns both. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const ember = await createWorkspace(w.t, bo, "ember-co", { kind: "shared" });
  await addMember(w.t, ember, ada, "editor");
  const fjord = await createWorkspace(w.t, bo, "fjord-co", { kind: "shared" });
  await addMember(w.t, fjord, ada, "editor");
  return { ...w, ada, bo, ember, fjord };
}

const slugsOf = (session: Session | null) => (session?.workspaces ?? []).map((row) => row.slug);

describe("one list of numbers", () => {
  test("an account made by a phone sign-in, never texted to Tex, is a person in the chat, not a guest", async () => {
    const w = await world();
    const nia = await signedInByPhone(w.t, "nia", NIA);
    await addMember(w.t, w.ember, nia, "editor");
    const answer = await turn(w.t, ADA, [ADA, BO, NIA, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: ["ember-co"] });
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).toContain("ember-co");
    // Nia is named as herself where she isn't a member, never as someone with no account.
    expect((answer.blocked ?? []) as Blocker[]).toEqual([{ slug: "fjord-co", who: "nia", why: "not_member" }]);
  });
});

describe("someone with no account counts where their number is invited", () => {
  test("a guest invited by number to @ember-co lets the chat reach it, at the invitation's role", async () => {
    const w = await world();
    await inviteByNumber(w.t, w.ember, w.bo, GUEST, "member");
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    expect(answer).toMatchObject({ status: "ready", reach: ["ember-co"] });
    const session = await resolves(w.t, answer.accessToken as string);
    expect(session?.workspaces.find((row) => row.slug === "ember-co")?.role).toBe("member");
    expect(slugsOf(session)).not.toContain("fjord-co");
  });

  test("the guest is named only where they aren't invited", async () => {
    const w = await world();
    await inviteByNumber(w.t, w.ember, w.bo, GUEST, "editor");
    // Nia, in neither, keeps the chat from both, so both are named; the guest only for the one they aren't invited to.
    await signedInByPhone(w.t, "nia", NIA);
    const blocked = ((await turn(w.t, ADA, [ADA, BO, GUEST, NIA, LINE])).blocked ?? []) as Blocker[];
    expect(blocked.map((row) => [row.slug, row.who === "nia" ? "nia" : "guest", row.why])).toEqual([
      ["ember-co", "nia", "not_member"],
      ["fjord-co", "nia", "not_member"],
      ["fjord-co", "guest", "no_account"],
    ]);
  });

  test("revoking the invitation drops the workspace on the chat's next call", async () => {
    const w = await world();
    const invitation = await inviteByNumber(w.t, w.ember, w.bo, GUEST, "editor");
    const answer = await turn(w.t, ADA, [ADA, BO, GUEST, LINE]);
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).toContain("ember-co");
    await w.t.run(async (ctx) => void (await ctx.db.patch(invitation, { status: "revoked" })));
    expect(slugsOf(await resolves(w.t, answer.accessToken as string))).not.toContain("ember-co");
  });
});
