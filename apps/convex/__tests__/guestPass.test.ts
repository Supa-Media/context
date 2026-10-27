/**
 * OPENING A NOTE FROM A TEX GUEST CHAT WITH A TEXTED CODE (`functions/guestPass.ts`, `lib/guestPhones.ts`,
 * `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * The owner, 2026-10-27: a guest with no account who taps a note link from the chat proves their number and sees
 * the note, and stays signed in. What must hold: a code is texted only to a number in a live guest chat, and every
 * other number hears the same answer; a pass reads exactly what the chat's group can see, read as a guest; leaving
 * the chat, guest mode going off and the owner taking a note back each end it at the next read; no number is kept.
 * Reads go through the real credential barrier to a bucket stub, so a note's marker in a result really came back.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - skip the `guestChatsOf` check in `reserveSend`: "a number not in the chat is texted nothing" fails;
 *  - skip it in `issue`: "an approved code for a number not in the chat makes no pass" fails;
 *  - render the rows for a member in `guestReach`: "only what the chat's group can see" fails (the team note opens);
 *  - drop `clearChatPhones` from `clearGuests`: "guest mode off ends it" fails on the kept rows;
 *  - drop the delete loop in `syncChatPhones`: "someone who left the chat" fails.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { setAccessRow } from "../functions/lib/nodes/setAccess";
import { guestPhoneHash, syncChatPhones } from "../functions/lib/guestPhones";
import { clearGuests } from "../functions/lib/textGroupGuests";
import { PLAN, PLAN_MARKER, SALARIES, SECRET, TEAM_MARKER, TEAM_NOTE, setBase, world, type World } from "./grants/outsider.helpers";

vi.setConfig({ testTimeout: 30_000 });

const FRIEND = "+15555550188";
const STRANGER = "+15555550199";
const GOOD_CODE = "123456";

let texted: string[];

beforeEach(() => {
  texted = [];
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_test_not_real");
  vi.stubEnv("TWILIO_AUTH_TOKEN", "test-token-not-real");
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "VA_test_not_real");
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
      guestFolder: "tex/chats/chair-blast-tiger",
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

async function passFor(w: World, phone: string): Promise<string> {
  expect(await w.t.action(api.functions.guestPass.start, { phone, slug: "@acme" })).toEqual({ status: "sent", phone });
  const verified = await w.t.action(api.functions.guestPass.verify, { phone, code: GOOD_CODE });
  expect(verified.status).toBe("ok");
  return verified.pass as string;
}

const read = (w: World, pass: string, path: string) => w.t.action(api.functions.guestPass.readNote, { pass, slug: "acme", path });

describe("a guest in the chat", () => {
  test("is texted a code, and the code opens the note shared with the chat", async () => {
    const w = await world();
    await guestChat(w);
    const pass = await passFor(w, FRIEND);
    expect(texted).toEqual([FRIEND]);
    const note = await read(w, pass, PLAN);
    expect(note.status).toBe("ok");
    expect(note.status === "ok" ? note.text : "").toContain(PLAN_MARKER);
    // The same pass opens it again later, with no code: they stay signed in.
    expect((await read(w, pass, PLAN)).status).toBe("ok");
    expect(texted).toHaveLength(1);
  });

  test("only what the chat's group can see: team, private and unshared notes stay shut, as one answer", async () => {
    const w = await world();
    await guestChat(w);
    await setBase(w, "1-projects", "team");
    const pass = await passFor(w, FRIEND);
    for (const path of [TEAM_NOTE, SECRET, SALARIES, "1-projects/missing.md", "../index.md", "1-projects/"]) {
      const answer = await read(w, pass, path);
      expect(answer).toEqual({ status: "unavailable" });
      expect(JSON.stringify(answer)).not.toContain(TEAM_MARKER);
    }
    // The workspace named in the link is the one read: another one's slug opens nothing.
    expect(await w.t.action(api.functions.guestPass.readNote, { pass, slug: "globex", path: PLAN })).toEqual({ status: "unavailable" });
  });

  test("the owner taking the note back from the group ends it at the next read", async () => {
    const w = await world();
    await guestChat(w);
    const pass = await passFor(w, FRIEND);
    await w.t.run(async (ctx) => {
      await setAccessRow(ctx as MutationCtx, { workspaceId: w.ws, path: PLAN, base: "private", grantees: [], actor: { userId: w.owner, role: "owner" } });
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("someone who left the chat reads nothing at the next read", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await passFor(w, FRIEND);
    await w.t.run(async (ctx) => {
      await syncChatPhones(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">, ["+15555550111"]);
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("guest mode off ends it, and the chat's numbers go with it", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await passFor(w, FRIEND);
    await w.t.run(async (ctx) => {
      await clearGuests(ctx as MutationCtx, (await ctx.db.get(chatId)) as Doc<"textGroups">);
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
    expect(await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").collect())).toEqual([]);
  });

  test("a chat no longer in guest mode reaches nothing, whatever numbers are left over", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await passFor(w, FRIEND);
    await w.t.run(async (ctx) => {
      await ctx.db.patch(chatId, { guestGroupId: undefined });
    });
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });

  test("signing out, a made-up pass and an expired one all say signed out", async () => {
    const w = await world();
    await guestChat(w);
    const pass = await passFor(w, FRIEND);
    expect(await read(w, "x".repeat(43), PLAN)).toEqual({ status: "signed_out" });
    expect(await read(w, "short", PLAN)).toEqual({ status: "signed_out" });
    const other = await passFor(w, FRIEND);
    await w.t.run(async (ctx) => {
      for (const row of await ctx.db.query("guestPasses").collect()) await ctx.db.patch(row._id, { expiresAt: 1 });
    });
    expect(await read(w, other, PLAN)).toEqual({ status: "signed_out" });
    await w.t.action(api.functions.guestPass.signOut, { pass });
    expect(await read(w, pass, PLAN)).toEqual({ status: "signed_out" });
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

  test("an approved code for a number not in the chat makes no pass", async () => {
    const w = await world();
    await guestChat(w);
    expect(await w.t.action(api.functions.guestPass.verify, { phone: STRANGER, code: GOOD_CODE })).toEqual({ status: "unavailable" });
    expect(await w.t.run(async (ctx) => await ctx.db.query("guestPasses").collect())).toEqual([]);
  });

  test("a wrong code makes no pass, and guessing is limited", async () => {
    const w = await world();
    await guestChat(w);
    await w.t.action(api.functions.guestPass.start, { phone: FRIEND, slug: "acme" });
    const answers: string[] = [];
    for (let i = 0; i < 11; i++) answers.push((await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: "000000" })).status);
    expect(answers.slice(0, 10).every((status) => status === "wrong")).toBe(true);
    expect(answers[10]).toBe("too_many");
    expect(await w.t.action(api.functions.guestPass.verify, { phone: FRIEND, code: GOOD_CODE })).toEqual({ status: "too_many" });
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
    const pass = await passFor(w, FRIEND);
    const rows = await w.t.run(async (ctx) => ({
      phones: await ctx.db.query("chatGuestPhones").collect(),
      passes: await ctx.db.query("guestPasses").collect(),
      codes: await ctx.db.query("phoneCodes").collect(),
    }));
    const kept = JSON.stringify([rows.phones, rows.passes]);
    expect(kept).not.toContain(FRIEND.slice(2));
    expect(kept).not.toContain(pass);
    const { hashToken } = await import("../functions/lib/crypto");
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

  test("a message whose people changed moves them too, tag or not (syncGuestPeople)", async () => {
    const w = await world();
    const { chatId } = await guestChat(w);
    const pass = await passFor(w, FRIEND);
    const LINE = "+15555550001";
    await w.t.mutation(internal.functions.textGroups.syncGuestPeople, { line: LINE, groupKey: "a".repeat(64), participants: [LINE, STRANGER] });
    const kept = await w.t.run(async (ctx) => await ctx.db.query("chatGuestPhones").withIndex("by_chat", (q) => q.eq("chatId", chatId)).collect());
    expect(kept.map((row) => row.phoneHash)).toEqual([await guestPhoneHash(STRANGER)]);
    expect(await read(w, pass, PLAN)).toEqual({ status: "unavailable" });
  });
});
