/**
 * THE GUEST PHONE PASS REACHES A CHAT ANSWERED FROM ITS HOME (`functions/guestPass.ts`, `lib/guestPhones.ts`; the owner
 * kept the pass when guest mode was retired, 2026-10-31; `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * Someone in a group chat with no account taps a note link Tex sent from the chat's home in `@context-lc`, proves their
 * number with a texted code, and gets a light account named on that home to edit. What must hold: a code is texted only
 * to a number kept for a chat that has a home; the account reads its own home and nothing else in the pin beyond what
 * every account reads; the next tag keeps it on the home and a tag without the number takes it off; a muted chat, or one
 * whose sponsor may no longer text, enrols nobody; and no number is kept but as a keyed hash.
 *
 * ## Sabotage record
 *
 *   `guestChatsOf` ignoring `homeWords`                           -> "is texted a code" fails
 *   `syncHomePhones` dropped from `homeOnlyTurn`                  -> "is texted a code" fails
 *   the `ensureChatHome` call dropped from `enrol`                -> "is named on the home" fails
 *   `phoneAccountOf` dropped from `homeOnlyTurn`                  -> "the next tag keeps" fails
 *   `homeBinder` returning the sponsor for a muted chat           -> "a muted chat" fails
 *   `keepPhones` keeping rows for numbers that left               -> "a tag without the number" fails
 */

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { visibleGrantedPaths } from "../functions/lib/grants/outsider";
import { guestPhoneHash } from "../functions/lib/guestPhones";
import { nodeAt } from "../functions/lib/nodes/paths";
import { ensureChatHome } from "../functions/lib/textGroupHome";
import { asUser, createUser, createWorkspace, seedTreeRows } from "./fixtures.helpers";
import { GUIDE, OLD_BUG, PLAN, SECRET, BENCH, clearanceOf, migrate, pinnedWorld, visibleTo, type PinnedWorld } from "./pinnedReaders.helpers";

vi.setConfig({ testTimeout: 60_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "8F2C3D1A-A5B7-4E9F-8C1D-2A3B4C5D6E7F";
const ADA = "+15555550100";
const BO = "+15555550111";
/** In the chat with no account. */
const FRIEND = "+15555550188";
const STRANGER = "+15555550199";
const GOOD_CODE = "123456";

type T = PinnedWorld["t"];
let texted: string[];

beforeEach(() => {
  texted = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  vi.stubEnv("SITE_URL", "https://context.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://context.test");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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

const turn = (t: T, sender: string, participants: string[]) =>
  agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants, mint: true });

/** The pinned world with Ada and Bo, a chat of them and FRIEND (no account) tagged once, and Twilio beside the bucket. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const ada = await texter(w.t, "ada", ADA);
  const bo = await texter(w.t, "bo", BO);
  const bucket = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.host !== "verify.twilio.com") return await bucket(input, init);
    const body = new URLSearchParams(init?.body as URLSearchParams);
    if (url.pathname.endsWith("/Verifications")) {
      texted.push(body.get("To") ?? "");
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }
    if (body.get("Code") !== GOOD_CODE) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
  expect(await turn(w.t, ADA, [ADA, BO, FRIEND, LINE])).toMatchObject({ status: "ready", minted: true });
  const chat = (await w.t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]))!;
  const home = `tex/groups/${chat.homeWords}`;
  // A note in the home, and one in another chat's home.
  const other = await w.t.run(async (ctx) => {
    const made = await ctx.db.insert("textGroups", { groupKey: "e".repeat(64), lastSeenAt: 1 });
    return await ensureChatHome(ctx as never, (await ctx.db.get(made))!, [w.sayo], w.sayo);
  });
  await seedTreeRows(w.t, w.pinned, [`${home}/flights.md`, `${other}/theirs.md`]);
  return { ...w, ada, bo, chatId: chat._id, home, other: other as string };
}
type World = Awaited<ReturnType<typeof world>>;

const accountsWith = (w: World, phone: string) => w.t.run(async (ctx) => await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", phone)).collect());
const homePeople = (w: World) =>
  w.t.run(async (ctx) => {
    const row = await nodeAt(ctx.db, w.pinned, w.home);
    const grants = await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", row!._id)).collect();
    return grants.map((grant) => ({ user: grant.granteeUserId, role: grant.role })).sort((a, b) => String(a.user).localeCompare(String(b.user)));
  });

async function enrolFriend(w: World): Promise<Id<"users">> {
  expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "@context-lc" })).toEqual({ status: "sent", phone: FRIEND });
  const verified = await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE });
  expect(verified.status).toBe("ok");
  const [account] = await accountsWith(w, FRIEND);
  return account!._id;
}

describe("a number in a chat answered from its home", () => {
  test("is texted a code, and the code makes a light account", async () => {
    const w = await world();
    const userId = await enrolFriend(w);
    expect(texted).toEqual([FRIEND]);
    expect(await accountsWith(w, FRIEND)).toHaveLength(1);
    expect((await accountsWith(w, FRIEND))[0]?.phoneVerificationTime).toBeDefined();
    expect(userId).toBeDefined();
  });

  test("is named on the home to edit, beside the accounts already there", async () => {
    const w = await world();
    const userId = await enrolFriend(w);
    expect(await homePeople(w)).toEqual([w.ada, w.bo, userId].sort().map((user) => ({ user, role: "edit" })));
  });

  test("reads its own home, and nothing else in the pin beyond what every account reads", async () => {
    const w = await world();
    const userId = await enrolFriend(w);
    const mine = `${w.home}/flights.md`;
    expect(await w.t.run(async (ctx) => await visibleGrantedPaths(ctx, { userId, workspaceId: w.pinned, paths: [mine, `${w.other}/theirs.md`, PLAN, SECRET, BENCH, OLD_BUG, GUIDE] }))).toEqual([mine]);
    // What the pin gives every account is the same for this one as for any other (Sayo reaches it by the pin alone).
    const everyone = await clearanceOf(w, w.sayo);
    const light = await clearanceOf(w, userId);
    expect(light.scope).toBe(everyone.scope);
    expect(await visibleTo(w, light.scope, light.grantedNames)).toEqual(await visibleTo(w, everyone.scope, everyone.grantedNames));
    expect(await visibleTo(w, light.scope, light.grantedNames)).not.toEqual(expect.arrayContaining([SECRET, PLAN, BENCH]));
  });

  test("the next tag keeps the account on the home, and a tag without the number takes it off", async () => {
    const w = await world();
    const userId = await enrolFriend(w);
    // The account is the chat's own now: still named when FRIEND tags, though no phone was ever linked to Tex.
    await turn(w.t, ADA, [ADA, BO, FRIEND, LINE]);
    expect((await homePeople(w)).map((entry) => entry.user)).toContain(userId);
    await turn(w.t, ADA, [ADA, BO, LINE]);
    expect((await homePeople(w)).map((entry) => entry.user)).not.toContain(userId);
    // And the number is no longer one the chat opens a note to.
    expect(await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").collect())).toEqual([]);
  });

  test("is kept as a keyed hash, never as a number", async () => {
    const w = await world();
    const rows = await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").collect());
    expect(rows.map((row) => row.phoneHash)).toEqual([await guestPhoneHash(FRIEND)]);
    expect(JSON.stringify(rows)).not.toContain(FRIEND.slice(2));
    expect(rows[0]?.workspaceId).toBe(w.pinned);
  });
});

describe("anybody else", () => {
  test("a number not in the chat is texted nothing, and hears the same answer", async () => {
    const w = await world();
    expect(await w.t.action(api.functions.guestPass.start, { phone: STRANGER, slug: "@context-lc" })).toEqual({ status: "sent", phone: STRANGER });
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "@nobody-here" })).toEqual({ status: "sent", phone: FRIEND });
    expect(texted).toEqual([]);
    expect(await w.t.action(api.functions.guestPass.verify, { phone: STRANGER, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await accountsWith(w, STRANGER)).toEqual([]);
  });

  test("a muted chat makes no account and names nobody", async () => {
    const w = await world();
    const before = await homePeople(w);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(w.chatId, { mutedAt: 1 });
    });
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await accountsWith(w, FRIEND)).toEqual([]);
    expect(await homePeople(w)).toEqual(before);
  });

  test("a chat whose sponsor may no longer text makes no account", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("phoneSignInPauses", { userId: w.ada, pausedAt: 1 });
    });
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await accountsWith(w, FRIEND)).toEqual([]);
  });

  test("an account holder's number is texted the ordinary sign-in code, as before", async () => {
    const w = await world();
    expect(await w.t.action(api.functions.guestPass.start, { phone: BO, slug: "@context-lc" })).toEqual({ status: "sent", phone: BO, account: true });
  });
});
