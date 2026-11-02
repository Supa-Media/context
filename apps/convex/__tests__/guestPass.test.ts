/**
 * OPENING A NOTE FROM A TEX GUEST CHAT WITH A TEXTED CODE (`functions/guestPass.ts`, `lib/guestPhones.ts`,
 * `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * The owner, 2026-10-27: a guest with no account who taps a note link from the chat proves their number and sees
 * the note, and stays signed in. The owner, 2026-10-31: the proven number of a guest chat with no account gets a
 * light account, signed in through the ordinary `phone-verify` path, and is named on the chat's folder the way an
 * outsider is. What must hold: a code is texted only to a number in a live guest chat, and every other number hears
 * the same answer; a wrong code makes no account; a number an account holds signs into that account and no second
 * one is made; passes issued before accounts still read what the chat's group can see, read as a guest; leaving the
 * chat, guest mode going off and the owner taking a note back each end a pass at the next read; no number is kept.
 * Reads go through the real credential barrier to a bucket stub, so a note's marker in a result really came back.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - skip the `guestChatsOf` check in `reserveSend`: "a number not in the chat is texted nothing" fails;
 *  - drop the account branch in `reserveSend`: "is texted a sign-in code from any chat" fails;
 *  - drop its pause check: "paused by \"This wasn't me\"" fails;
 *  - skip the chat check in `enrol`: "an approved code for a number not in the chat makes no account" fails;
 *  - drop the holder check in `enrol`: "signs into its own account, and no second account is made" fails;
 *  - drop the `nameOutsider` call in `enrol`: "is named on the chat's folder" fails;
 *  - render the rows for a member in `guestReach`: "only what the chat's group can see" fails (the team note opens);
 *  - drop `clearChatPhones` from `clearGuests`: "guest mode off ends a legacy pass" fails on the kept rows;
 *  - drop the delete loop in `syncChatPhones`: "someone who left the chat" fails.
 *  - drop the `guestBinder` check in `enrol`: "a chat whose guest mode its binder may no longer open" fails
 *    (an account is made and named on the folder under a role its binder no longer holds).
 */

import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { META_PIXEL } from "../functions/lib/metaConversion";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { guestPhoneHash, syncChatPhones } from "../functions/lib/guestPhones";
import { hashToken } from "../functions/lib/crypto";
import { clearGuests, ensureChatFolderGrant } from "../functions/lib/textGroupGuests";
import { drainScheduled, seedTreeRows } from "./fixtures.helpers";
import { PLAN, PLAN_MARKER, SALARIES, SECRET, TEAM_MARKER, TEAM_NOTE, setBase, world, type World } from "./grants/outsider.helpers";

vi.setConfig({ testTimeout: 30_000 });

const FRIEND = "+15555550188";
const STRANGER = "+15555550199";
const GOOD_CODE = "123456";
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLDER = "tex/chats/chair-blast-tiger";

let texted: string[];

beforeEach(() => {
  texted = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
  // A session is signed with a key; a throwaway one, made here, as the sign-in tests make theirs.
  vi.stubEnv("SITE_URL", "https://context.test");
  vi.stubEnv("CONVEX_SITE_URL", "https://context.test");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("JWT_PRIVATE_KEY", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The bucket stub, with Twilio Verify beside it: texts are counted, and only `GOOD_CODE` is approved. */
function withTwilio(w: World) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.host !== "verify.twilio.com") return await w.backend.fetchImpl(input, init);
    const body = new URLSearchParams(init?.body as URLSearchParams);
    if (url.pathname.endsWith("/Verifications")) {
      texted.push(body.get("To") ?? "");
      return new Response(JSON.stringify({ status: "pending" }), { status: 201 });
    }
    if (body.get("Code") !== GOOD_CODE) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ status: "approved", valid: true }), { status: 200 });
  });
}

/** A guest chat bound to @acme with FRIEND in it, and PLAN shared with the chat's group. */
async function guestChat(w: World) {
  withTwilio(w);
  const ids = await w.t.run(async (ctx) => {
    const groupId = await ctx.db.insert("workspaceGroups", { workspaceId: w.ws, name: "acme-chair-blast-tiger", createdBy: w.owner, createdAt: 1 });
    const chatId = await ctx.db.insert("textGroups", {
      groupKey: "a".repeat(64),
      workspaceId: w.ws,
      boundBy: w.owner,
      guestGroupId: groupId,
      guestFolder: FOLDER,
      guestToken: "chat-token-test",
      lastSeenAt: 1,
    });
    const chat = (await ctx.db.get(chatId)) as Doc<"textGroups">;
    await syncChatPhones(ctx as MutationCtx, chat, [FRIEND]);
    const shared = await setAccessRow(ctx as MutationCtx, {
      workspaceId: w.ws,
      path: PLAN,
      base: "private",
      grantees: [{ kind: "group", groupId, role: "view" }],
      actor: { userId: w.owner, role: "owner" },
    });
    if (!shared.ok) throw new Error(`setAccessRow refused: ${shared.code}`);
    return { groupId, chatId };
  });
  return ids;
}

/** Start and verify a number in a guest chat: the code it gets back, for `phone-verify`. */
async function codeFor(w: World, phone: string): Promise<string> {
  expect(await w.t.action(api.functions.guestPass.start, { phone, slug: "@acme" })).toEqual({ status: "sent", phone });
  const verified = await w.t.action(api.functions.guestPass.verify, { phone, code: GOOD_CODE });
  expect(verified.status).toBe("ok");
  expect("pass" in verified).toBe(false);
  return verified.code as string;
}

/** Signs a browser in through the ordinary `phone-verify` provider, as the guest page does. */
async function signIn(w: World, phone: string, code: string) {
  const result = await w.t.action(api.auth.signIn, { provider: "phone-verify", params: { phone, code } });
  await drainScheduled(w.t);
  return result;
}

const accountsWith = (w: World, phone: string) =>
  w.t.run(async (ctx) => await ctx.db.query("users").withIndex("by_phone", (q) => q.eq("phone", phone)).collect());

/** The accounts with a session in this test world (the fixtures sign nobody in). */
const sessionUserIds = (w: World) => w.t.run(async (ctx) => (await ctx.db.query("authSessions").collect()).map((row) => row.userId));

/** A pass issued before this change (the owner, 2026-10-27): still reads what the chat reads until it expires. */
async function legacyPass(w: World, phone: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const pass = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const phoneHash = (await guestPhoneHash(phone)) as string;
  const tokenHash = await hashToken(pass);
  await w.t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("guestPasses", { tokenHash, phoneHash, createdAt: now, lastUsedAt: now, expiresAt: now + 365 * DAY_MS });
  });
  return pass;
}

const read = (w: World, pass: string, path: string) => w.t.action(api.functions.guestPass.readNote, { pass, slug: "acme", path });

describe("a guest in the chat with no account", () => {
  test("is texted a code, and the code makes a light account and signs the browser in", async () => {
    const w = await world();
    await guestChat(w);
    const code = await codeFor(w, FRIEND);
    expect(texted).toEqual([FRIEND]);
    // The approved code made the account; the browser signs in with the code the page is given, not the texted one.
    expect(await accountsWith(w, FRIEND)).toHaveLength(1);
    const signedIn = await signIn(w, FRIEND, code);
    expect(signedIn.tokens).toBeTruthy();
    const [account] = await accountsWith(w, FRIEND);
    expect(account).toBeDefined();
    expect(account!.phoneVerificationTime).toBeDefined();
    expect(await sessionUserIds(w)).toContain(account!._id);
    // The code is one use: the same code signs nobody in again.
    expect((await signIn(w, FRIEND, code)).tokens).toBeNull();
  });

  test("the new account is not reported to an ad network as a sign-up", async () => {
    vi.stubEnv("META_CAPI_TOKEN", "fake-meta-token");
    META_PIXEL.id = "1234567890123456";
    try {
      const w = await world();
      await guestChat(w);
      await codeFor(w, FRIEND);
      expect(await accountsWith(w, FRIEND)).toHaveLength(1);
      const scheduled = await w.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
      expect(scheduled.map((job) => job.name).filter((name) => /Conversions/.test(name))).toEqual([]);
    } finally {
      META_PIXEL.id = null;
      vi.unstubAllEnvs();
    }
  });

  test("the new account makes no guest pass, and the chat's numbers are left as they were", async () => {
    const w = await world();
    await guestChat(w);
    const code = await codeFor(w, FRIEND);
    await signIn(w, FRIEND, code);
    const rows = await w.t.run(async (ctx) => ({
      passes: await ctx.db.query("guestPasses").collect(),
      phones: await ctx.db.query("chatGuestPhones").collect(),
    }));
    expect(rows.passes).toEqual([]);
    expect(rows.phones.map((row) => row.phoneHash)).toEqual([await guestPhoneHash(FRIEND)]);
  });

  test("is named on the chat's folder to edit, as an outsider is, once the folder has its grant", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    // The chat's first note is written in its folder, then the folder gets the group's grant (`ensureChatFolderGrant`).
    await seedTreeRows(w.t, w.ws, [`${FOLDER}/flights.md`]);
    await w.t.run(async (ctx) => {
      await ensureChatFolderGrant(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, w.owner);
    });
    expect((await w.t.run((ctx) => ctx.db.get(chatId)))?.guestFolderGranted).toBe(true);
    await signIn(w, FRIEND, await codeFor(w, FRIEND));
    const [account] = await accountsWith(w, FRIEND);
    const chat = await w.t.run((ctx) => ctx.db.get(chatId));
    expect(chat?.guestFolderUsers).toEqual([account!._id]);
  });

  test("a chat whose guest mode its binder may no longer open makes no account and names nobody", async () => {
    // `guestBinder` is the gate the chat's own turns pass: its group is there, and the person who turned guest
    // mode on is still an owner or editor of the workspace, with texting not paused. An enrolment names that
    // person's authority on the folder (`nameOutsider` asserts `role: "owner"` to `setAccessRow`), so it has to
    // ask the same question the turn asks.
    const w = await world();
    const { chatId } = await guestChat(w);
    await seedTreeRows(w.t, w.ws, [`${FOLDER}/flights.md`]);
    await w.t.run(async (ctx) => {
      await ensureChatFolderGrant(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, w.owner);
    });
    // Taken off the workspace since: the chat row still says guest mode, and says they turned it on.
    await w.t.run(async (ctx) => {
      const membership = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", w.ws).eq("userId", w.owner))
        .unique();
      if (membership === null) throw new Error("the binder has no membership to take away");
      await ctx.db.delete(membership._id);
    });

    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "@acme" })).toEqual({ status: "sent", phone: FRIEND });
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await accountsWith(w, FRIEND)).toEqual([]);
    expect((await w.t.run((ctx) => ctx.db.get(chatId)))?.guestFolderUsers).toBeUndefined();
  });

  test("a legacy pass still reads only what the chat's group can see: team, private and unshared notes stay shut", async () => {
    const w = await world();
    await guestChat(w);
    await setBase(w, "1-projects", "team");
    const pass = await legacyPass(w, FRIEND);
    const note = await read(w, pass, PLAN);
    expect(note.status).toBe("ok");
    expect(note.status === "ok" ? note.text : "").toContain(PLAN_MARKER);
    for (const path of [TEAM_NOTE, SECRET, SALARIES, "1-projects/missing.md", "../index.md", "1-projects/"]) {
      const answer = await read(w, pass, path);
      expect(answer).toEqual({ status: "unavailable" });
      expect(JSON.stringify(answer)).not.toContain(TEAM_MARKER);
    }
    // The workspace named in the link is the one read: another one's slug opens nothing.
    expect(await w.t.action(api.functions.guestPass.readNote, { pass, slug: "globex", path: PLAN })).toEqual({ status: "unavailable" });
  });

  test("the owner taking the note back from the group ends a legacy pass at the next read", async () => {
    const w = await world();
    await guestChat(w);
    const pass = await legacyPass(w, FRIEND);
    await w.t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: PLAN, base: "private", grantees: [], actor: { userId: w.owner, role: "owner" } });
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("someone who left the chat reads nothing at the next read", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await legacyPass(w, FRIEND);
    await w.t.run(async (ctx) => {
      await syncChatPhones(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, ["+15555550111"]);
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("guest mode off ends a legacy pass, and the chat's numbers go with it", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await legacyPass(w, FRIEND);
    await w.t.run(async (ctx) => {
      await clearGuests(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">);
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
    expect(await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").collect())).toEqual([]);
  });

  test("a chat no longer in guest mode reaches nothing, whatever numbers are left over", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await legacyPass(w, FRIEND);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(chatId, { guestGroupId: undefined });
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("signing out, a made-up pass and an expired one all say signed out", async () => {
    const w = await world();
    await guestChat(w);
    const pass = await legacyPass(w, FRIEND);
    expect(await read(w, "x".repeat(43), PLAN)).toEqual({ status: "signed_out" });
    expect(await read(w, "short", PLAN)).toEqual({ status: "signed_out" });
    const other = await legacyPass(w, FRIEND);
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query("guestPasses").collect()) await ctx.db.patch(row._id, { expiresAt: 1 });
    });
    expect(await read(w, other, PLAN)).toEqual({ status: "signed_out" });
    await w.t.action(api.functions.guestPass.signOut, { pass });
    expect(await read(w, pass, PLAN)).toEqual({ status: "signed_out" });
  });
});

describe("a number an account holds", () => {
  const MEMBER = "+15555550177";

  test("is texted a sign-in code from any chat, guest mode or not, and makes no guest pass", async () => {
    const w = await world();
    withTwilio(w);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("users", { phone: MEMBER, phoneVerificationTime: 1, createdAt: 1 });
    });
    // In no guest chat at all, as in a members chat like the team's own.
    expect(await w.t.action(api.functions.guestPass.start, { phone: MEMBER, slug: "acme" })).toEqual({ status: "sent", phone: MEMBER, account: true });
    expect(texted).toEqual([MEMBER]);
    // The code is for the ordinary sign-in: it makes no pass and no account.
    expect(await w.t.action(api.functions.guestPass.verify, { phone: MEMBER, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await w.t.run(async (ctx) => await ctx.db.query("guestPasses").collect())).toEqual([]);
    expect(await accountsWith(w, MEMBER)).toHaveLength(1);
  });

  test("signs into its own account, and no second account is made", async () => {
    const w = await world();
    withTwilio(w);
    const holder = await w.t.run(async (ctx) => await ctx.db.insert("users", { phone: FRIEND, phoneVerificationTime: 1, createdAt: 1 }));
    await guestChat(w);
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" })).toEqual({ status: "sent", phone: FRIEND, account: true });
    const signedIn = await signIn(w, FRIEND, GOOD_CODE);
    expect(signedIn.tokens).toBeTruthy();
    expect(await sessionUserIds(w)).toContain(holder);
    expect(await accountsWith(w, FRIEND)).toHaveLength(1);
  });

  test("who types the code into the guest page in a guest chat gets no second account, and no code", async () => {
    const w = await world();
    await guestChat(w);
    const holder = await w.t.run(async (ctx) => await ctx.db.insert("users", { phone: FRIEND, phoneVerificationTime: 1, createdAt: 1 }));
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" })).toEqual({ status: "sent", phone: FRIEND, account: true });
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect((await accountsWith(w, FRIEND)).map((row) => row._id)).toEqual([holder]);
  });

  test("paused by \"This wasn't me\", gets no sign-in code, only what a guest gets", async () => {
    const w = await world();
    await guestChat(w);
    await w.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { phone: FRIEND, phoneVerificationTime: 1, createdAt: 1 });
      await ctx.db.insert("phoneSignInPauses", { userId, pausedAt: 1 });
    });
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" })).toEqual({ status: "sent", phone: FRIEND });
    expect(texted).toEqual([FRIEND]);
  });
});

describe("anybody else", () => {
  test("a number not in the chat is texted nothing, and hears the same answer", async () => {
    const w = await world();
    await guestChat(w);
    expect(await w.t.action(api.functions.guestPass.start, { phone: STRANGER, slug: "acme" })).toEqual({ status: "sent", phone: STRANGER });
    // A slug nobody has, the same.
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "nobody-here" })).toEqual({ status: "sent", phone: FRIEND });
    expect(texted).toEqual([]);
  });

  test("an approved code for a number not in the chat makes no account", async () => {
    const w = await world();
    await guestChat(w);
    expect(await w.t.action(api.functions.guestPass.verify, { phone: STRANGER, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await w.t.run(async (ctx) => await ctx.db.query("guestPasses").collect())).toEqual([]);
    expect(await accountsWith(w, STRANGER)).toHaveLength(0);
  });

  test("a wrong code makes no account, guessing is limited, and a stranger's wrong code hears what a member's does", async () => {
    const w = await world();
    await guestChat(w);
    await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" });
    const answers: string[] = [];
    for (let i = 0; i < 11; i++) answers.push((await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: "000000" })).status);
    expect(answers.slice(0, 10).every((status) => status === "wrong")).toBe(true);
    expect(answers[10]).toBe("too_many");
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "too_many" });
    expect(await accountsWith(w, FRIEND)).toHaveLength(0);
    expect(await w.t.action(api.functions.guestPass.verify, { phone: STRANGER, code: "000000" })).toEqual({ status: "wrong" });
    expect(await accountsWith(w, STRANGER)).toHaveLength(0);
  });

  test("texting one number is limited to five codes an hour", async () => {
    const w = await world();
    await guestChat(w);
    const answers: string[] = [];
    for (let i = 0; i < 6; i++) answers.push((await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" })).status);
    expect(answers).toEqual(["sent", "sent", "sent", "sent", "sent", "too_many"]);
    expect(texted).toHaveLength(5);
  });
});

describe("what is kept", () => {
  test("no number, only keyed hashes that a plain hash of the number doesn't match", async () => {
    const w = await world();
    await guestChat(w);
    const code = await codeFor(w, FRIEND);
    await signIn(w, FRIEND, code);
    const rows = await w.t.run(async (ctx) => ({
      phones: await ctx.db.query("chatGuestPhones").collect(),
      passes: await ctx.db.query("guestPasses").collect(),
    }));
    const kept = JSON.stringify([rows.phones, rows.passes]);
    expect(kept).not.toContain(FRIEND.slice(2));
    expect(kept).not.toContain(code);
    expect(kept).not.toContain(await hashToken(FRIEND));
    expect(rows.phones.map((row) => row.phoneHash)).toEqual([await guestPhoneHash(FRIEND)]);
  });

  test("with no storage key there are no hashes, and no codes", async () => {
    const w = await world();
    await guestChat(w);
    vi.stubEnv("STORAGE_SECRET_ENCRYPTION_KEY", "");
    expect(await guestPhoneHash(FRIEND)).toBeNull();
    expect(await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" })).toEqual({ status: "unavailable", phone: FRIEND });
    expect(texted).toEqual([]);
  });
});

describe("a tag keeps the chat's numbers", () => {
  test("each guest turn writes who is in it, and drops whoever left", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const hashes = async () =>
      (await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").withIndex("by_chat", (q) => q.eq("chatId", chatId as Id<"textGroups">)).collect()))
        .map((row) => row.phoneHash)
        .sort();
    await w.t.run(async (ctx) => {
      await syncChatPhones(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, [FRIEND, STRANGER]);
    });
    expect(await hashes()).toEqual([await guestPhoneHash(FRIEND), await guestPhoneHash(STRANGER)].sort());
    await w.t.run(async (ctx) => {
      await syncChatPhones(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, [STRANGER]);
    });
    expect(await hashes()).toEqual([await guestPhoneHash(STRANGER)]);
  });
});
