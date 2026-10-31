/**
 * A MAILBOX SHARED WITH ONE GROUP CHAT (`lib/textGroupMail.ts`,
 * `docs/decisions/texting-assistant/chat-mail.md`).
 *
 * "Tex, share my mail from <address> here" from the mailbox's own person, in
 * a chat bound to a shared workspace they edit, lets that chat's turns search
 * and read it live, narrowed by the share's search. Every read is spent on the
 * real `/gateway/email/*` routes with the chat's own grant.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop `ownGmail` from `shareMail`: "only the mailbox's own person" fails;
 *  - a guest chat refused again (`sharingWorkspace`, `liveMailShares` or
 *    `chatMailClearance`): "a guest chat reads it too" fails (the owner,
 *    2026-10-29: "it should work even in guest mode if I'm sharing my email
 *    explicitly");
 *  - drop `withinShare` from the search: "every search is narrowed" fails;
 *  - keep the query's brackets in `withinShare`: "a search is narrowed" fails;
 *  - drop `insideShare` from the read: "a message outside the share" fails;
 *  - drop the `writingRole` check in `liveMailShares`: "losing edit ends it" fails;
 *  - drop the `wake` or `chat` match in `wakeMailRoutines`: "new mail brings
 *    forward only" fails; drop the gap: "never sooner than" fails;
 *  - the chat's own check-in (`textGroupLooks.ts`): dropping its wake, its
 *    claim, its result, its lease, its live-chat check, its gap, the
 *    personal `watchedIn`, the arming on a turn or daily, the next slot set
 *    at claim, or the quiet/dormant drop each fails a test in "the chat
 *    checks in on its own".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, seedGoogleConnection, setupTest } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { withinShare } from "../functions/lib/gatewayRoutes/personMail";
import { MAIL_WAKE_DELAY_MS, MAIL_WAKE_GAP_MS } from "../functions/lib/routines/wake";
import { CHAT_LOOK_PATH, DORMANT_MS, FIRST_LOOK_MS, LOOK_DELAY_MS, LOOK_GAP_MS } from "../functions/lib/textGroupLooks";
import { registerClient, seedConnectedClient } from "./controlPlane/fixtures.helpers";

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "7C2E3D4F-B6C8-4F0A-9D2E-3B4C5D6E7F80";
const SEYI = "+15555550120";
const DAD = "+15555550131";
const WORK = "seyi@work.example";
const HOUR = 60 * 60 * 1000;
const realFetch = globalThis.fetch;

type T = ReturnType<typeof setupTest>;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Gmail holding one message, m1; `inside` says whether a share's own search still finds it. Queries are recorded. */
function gmail(inside = true) {
  const queries: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await realFetch(input, init);
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");
    queries.push(q ?? parsed.pathname);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/gmail/v1/users/me/messages") {
      return json({ messages: q?.includes("rfc822msgid:") && !inside ? [] : [{ id: "m1", threadId: "t1" }] });
    }
    return json({
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.parse("2024-03-02T10:00:00Z")),
      snippet: "New client intake",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Jo <jo@example.invalid>" },
          { name: "To", value: "clients@work.example" },
          { name: "Subject", value: "Intake" },
          { name: "Message-ID", value: "<intake-1@example.invalid>" },
        ],
        body: { data: btoa("Please call me back.").replace(/=+$/, ""), size: 20 },
      },
    });
  });
  return queries;
}

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function texter(t: T, name: string, phone: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  expect((await agentPost(t, "/agent-texts/link", { phone, code })).status).toBe("linked");
  return { userId, workspaceId };
}

const turn = async (t: T, sender: string, extra: Record<string, unknown> = {}) =>
  await agentPost(t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [SEYI, DAD, LINE], mint: true, ...extra });

const share = (address: string, query?: string) => ({ command: { kind: "share_mail", address, ...(query ? { query } : {}) } });

/** Seyi owns @crystal-care and has their work Gmail connected; Dad edits it; the chat uses it. */
async function family(t: T) {
  const seyi = await texter(t, "seyi", SEYI);
  const dad = await texter(t, "dad", DAD);
  const care = await createWorkspace(t, seyi.userId, "crystal-care", { kind: "shared" });
  await addMember(t, care, dad.userId, "editor");
  const id = await seedGoogleConnection(t, { workspaceId: seyi.workspaceId, boundBy: seyi.userId, address: WORK });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: seyi.workspaceId });
  await t.run((ctx) => ctx.db.patch(id, { encryptedAccessToken, accessTokenExpiresAt: Date.now() + HOUR }));
  expect((await turn(t, SEYI, { mint: false })).status).toBe("ready");
  return { seyi, dad, care, connectionId: id };
}

async function chatToken(t: T, sender = SEYI): Promise<string> {
  const ready = await turn(t, sender);
  expect(ready.status).toBe("ready");
  return ready.accessToken as string;
}

const search = async (t: T, accessToken: string, care: Id<"workspaces">) =>
  (await (await gatewayPost(t, "/gateway/email/search", { accessToken, expectedWorkspaceId: care, query: "intake", outsideSync: true })).json()) as Record<string, unknown>;

const read = async (t: T, accessToken: string, care: Id<"workspaces">) =>
  (await (await gatewayPost(t, "/gateway/email/read", { accessToken, expectedWorkspaceId: care, address: WORK, id: "m1" })).json()) as Record<string, unknown>;

describe("sharing a mailbox with the chat", () => {
  test("a search is narrowed by the share's own search", () => {
    expect(withinShare("intake", { filter: "to:clients@work.example" })).toBe("(to:clients@work.example) (intake)");
    expect(withinShare("intake", {})).toBe("intake");
    // A query can't close the share's brackets and widen it.
    expect(withinShare("x) OR (in:anywhere", { filter: "to:clients@work.example" })).toBe("(to:clients@work.example) (x  OR  in:anywhere)");
  });

  test("before any share, the chat reads no mail", async () => {
    gmail();
    const t = setupTest();
    const { care } = await family(t);
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: false, refused: "not_allowed" });
  });

  test("its own person shares it; the chat's turns are told, and every search is narrowed", async () => {
    const queries = gmail();
    const t = setupTest();
    const { care } = await family(t);
    expect(await turn(t, SEYI, share(WORK.toUpperCase(), "to:clients@work.example"))).toEqual({ status: "mail_shared", address: WORK, narrowed: true });
    const ready = await turn(t, DAD);
    expect(ready.mail).toEqual([{ handle: "seyi", address: WORK }]);
    const found = await search(t, ready.accessToken as string, care);
    expect(found).toMatchObject({ ok: true, results: [expect.objectContaining({ id: "m1", subject: "Intake" })] });
    // Never the personal "outside the synced notes" window: the chat holds none of this mail.
    expect(queries[0]).toBe("(to:clients@work.example) (intake)");
    const audit = await t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(audit.filter((row) => row.action === "mail.shared_with_chat").map((row) => row.workspaceId)).toEqual([care]);
  });

  test("only the mailbox's own person shares it, and only a connected Gmail", async () => {
    gmail();
    const t = setupTest();
    const { care } = await family(t);
    expect(await turn(t, DAD, share(WORK))).toEqual({ status: "mail_refused" });
    expect(await turn(t, SEYI, share("someone-else@work.example"))).toEqual({ status: "mail_refused" });
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: false, refused: "not_allowed" });
  });

  test("never into a chat on a personal workspace", async () => {
    gmail();
    const t = setupTest();
    const { seyi } = await family(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("textGroups").collect()) await ctx.db.patch(row._id, { workspaceId: seyi.workspaceId });
    });
    expect(await turn(t, SEYI, share(WORK))).toEqual({ status: "mail_refused" });
  });


  test("a message outside the share is not found, one inside is read", async () => {
    gmail(false);
    const t = setupTest();
    const { care } = await family(t);
    await turn(t, SEYI, share(WORK, "to:clients@work.example"));
    expect(await read(t, await chatToken(t), care)).toEqual({ ok: false, refused: "not_found" });

    gmail(true);
    expect(await read(t, await chatToken(t), care)).toMatchObject({ ok: true, message: { id: "m1", subject: "Intake" } });
  });

  test("stopping sharing ends the reads, and only the sharer can", async () => {
    gmail();
    const t = setupTest();
    const { care } = await family(t);
    await turn(t, SEYI, share(WORK));
    expect(await turn(t, DAD, { command: { kind: "unshare_mail" } })).toEqual({ status: "mail_unshared", count: 0 });
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: true });
    expect(await turn(t, SEYI, { command: { kind: "unshare_mail", address: WORK } })).toEqual({ status: "mail_unshared", count: 1 });
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: false, refused: "not_allowed" });
  });

  test("losing edit, or disconnecting the Gmail, ends it without a word", async () => {
    gmail();
    const t = setupTest();
    const { care, seyi, connectionId } = await family(t);
    await turn(t, SEYI, share(WORK));
    await t.run((ctx) => ctx.db.patch(connectionId, { disconnectedAt: Date.now() }));
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: false, refused: "not_allowed" });
    await t.run((ctx) => ctx.db.patch(connectionId, { disconnectedAt: undefined }));
    expect(await search(t, await chatToken(t), care)).toMatchObject({ ok: true });
    const membership = await t.run(
      async (ctx) =>
        await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace_user", (q) => q.eq("workspaceId", care).eq("userId", seyi.userId))
          .unique(),
    );
    await t.run((ctx) => ctx.db.patch(membership!._id, { role: "member" }));
    expect(await search(t, await chatToken(t, DAD), care)).toMatchObject({ ok: false, refused: "not_allowed" });
  });
});

describe("new mail wakes the chat's mail routine", () => {
  async function routine(t: T, care: Id<"workspaces">, writer: Id<"users">, extra: Record<string, unknown>) {
    const groupKey = (await t.run(async (ctx) => await ctx.db.query("textGroups").first()))!.groupKey;
    return await t.run(
      async (ctx) =>
        await ctx.db.insert("routines", {
          workspaceId: care,
          path: `tex/routines/daily/${String(extra.name ?? "mail")}.md`,
          writerUserId: writer,
          writerSource: "signal",
          cadence: { unit: "day", every: 1 },
          paused: false,
          send: "text",
          to: [],
          chat: groupKey.slice(0, 16),
          nextRunAt: Date.now() + 12 * HOUR,
          updatedAt: Date.now(),
          ...(extra.wake === false ? {} : { wake: "mail" as const }),
          ...(extra.chat !== undefined ? { chat: extra.chat as string } : {}),
          ...(extra.lastRunAt !== undefined ? { lastRunAt: extra.lastRunAt as number } : {}),
        }),
    );
  }

  test("new mail brings forward only a waking routine of a chat it is shared with", async () => {
    gmail();
    const t = setupTest();
    const { care, seyi, connectionId } = await family(t);
    await t.run((ctx) => ctx.db.patch(connectionId, { push: { gmail: { address: WORK } } }));
    await turn(t, SEYI, share(WORK));
    const waking = await routine(t, care, seyi.userId, {});
    const plain = await routine(t, care, seyi.userId, { name: "plain", wake: false });
    const elsewhere = await routine(t, care, seyi.userId, { name: "elsewhere", chat: "0123456789abcdef" });
    const before = Date.now();
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    const rows = await t.run(async (ctx) => await Promise.all([waking, plain, elsewhere].map((id) => ctx.db.get(id))));
    expect(rows[0]!.nextRunAt).toBeGreaterThanOrEqual(before + MAIL_WAKE_DELAY_MS);
    expect(rows[0]!.nextRunAt).toBeLessThan(before + MAIL_WAKE_DELAY_MS + HOUR / 60);
    expect(rows[1]!.nextRunAt).toBeGreaterThan(before + 11 * HOUR);
    expect(rows[2]!.nextRunAt).toBeGreaterThan(before + 11 * HOUR);
  });

  test("never sooner than the gap after its last look, and not at all once unshared", async () => {
    gmail();
    const t = setupTest();
    const { care, seyi, connectionId } = await family(t);
    await t.run((ctx) => ctx.db.patch(connectionId, { push: { gmail: { address: WORK } } }));
    await turn(t, SEYI, share(WORK));
    const lastRunAt = Date.now();
    const id = await routine(t, care, seyi.userId, { lastRunAt });
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    expect((await t.run((ctx) => ctx.db.get(id)))!.nextRunAt).toBe(lastRunAt + MAIL_WAKE_GAP_MS);

    await t.run((ctx) => ctx.db.patch(id, { nextRunAt: Date.now() + 12 * HOUR }));
    await turn(t, SEYI, { command: { kind: "unshare_mail" } });
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    expect((await t.run((ctx) => ctx.db.get(id)))!.nextRunAt).toBeGreaterThan(Date.now() + 11 * HOUR);
  });
});

describe("the chat checks in on its own", () => {
  async function shared(t: T) {
    const fam = await family(t);
    await t.run((ctx) => ctx.db.patch(fam.connectionId, { push: { gmail: { address: WORK } } }));
    await turn(t, SEYI, share(WORK));
    return fam;
  }
  const lookRow = async (t: T) => (await t.run(async (ctx) => await ctx.db.query("textGroups").first()))!;
  const patchLook = async (t: T, fields: Record<string, unknown>) =>
    await t.run(async (ctx) => ctx.db.patch((await ctx.db.query("textGroups").first())!._id, fields));
  const dueRuns = async (t: T) => ((await agentPost(t, "/agent-texts/routines/due", {})).runs ?? []) as Array<Record<string, unknown>>;

  test("a bound chat has its next daily look with nothing set up, handed out as a chat run as its binder", async () => {
    const t = setupTest();
    await family(t);
    await turn(t, SEYI);
    const row = await lookRow(t);
    expect(row.nextLookAt).toBeGreaterThan(Date.now());
    expect(row.nextLookAt).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    await patchLook(t, { nextLookAt: Date.now() - 1 });
    const claimedAt = Date.now();
    const runs = await dueRuns(t);
    expect(runs).toEqual([expect.objectContaining({ path: CHAT_LOOK_PATH, chat: row.groupKey, phones: [SEYI] })]);
    expect(runs[0]!.since).toBeGreaterThanOrEqual(claimedAt - FIRST_LOOK_MS);
    expect(runs[0]!.since).toBeLessThan(claimedAt);
    // Handing it out sets the next slot at once.
    expect((await lookRow(t)).nextLookAt).toBeGreaterThan(Date.now());
  });

  test("the daily arming reaches a bound chat that has had no turn since", async () => {
    const t = setupTest();
    await family(t);
    await patchLook(t, { nextLookAt: undefined });
    await t.mutation(internal.functions.heartbeats.armLinkedHeartbeats, {});
    expect((await lookRow(t)).nextLookAt).toBeGreaterThan(Date.now());
  });

  test("new mail brings the look forward, and the cron hands it out once, leased", async () => {
    gmail();
    const t = setupTest();
    await shared(t);
    const before = Date.now();
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    const row = await lookRow(t);
    expect(row.nextLookAt).toBeGreaterThanOrEqual(before + LOOK_DELAY_MS);
    expect(row.nextLookAt).toBeLessThan(Date.now() + LOOK_DELAY_MS + 60_000);
    await patchLook(t, { nextLookAt: Date.now() - 1 });

    const runs = await dueRuns(t);
    expect(runs).toEqual([expect.objectContaining({ path: CHAT_LOOK_PATH, chat: row.groupKey, phones: [SEYI] })]);
    expect(runs[0]!.accessToken).toBeUndefined();
    expect(await dueRuns(t)).toEqual([]);
    // Not again while this one is still out.
    await patchLook(t, { nextLookAt: Date.now() - 1 });
    expect(await dueRuns(t)).toEqual([]);
    const outcome = await agentPost(t, "/agent-texts/routines/result", { runId: runs[0]!.runId, outcome: "skipped", texted: 0 });
    expect(outcome.status).not.toBe("unknown");
    const after = await lookRow(t);
    expect(after.lookRunId).toBeUndefined();
    expect(after.lastLookAt).toBeGreaterThanOrEqual(before);
    expect((await t.run(async (ctx) => await ctx.db.query("auditEvents").collect())).map((row) => row.action)).toContain("chat.look");
  });

  test("a burst of mail is one look, never sooner than the gap after the last", async () => {
    gmail();
    const t = setupTest();
    await shared(t);
    const lastLookAt = Date.now();
    await patchLook(t, { lastLookAt, nextLookAt: undefined });
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    expect((await lookRow(t)).nextLookAt).toBe(lastLookAt + LOOK_GAP_MS);
  });

  test("a chat that can no longer hear it drops the look", async () => {
    gmail();
    const t = setupTest();
    await shared(t);
    await patchLook(t, { mutedAt: Date.now(), nextLookAt: Date.now() - 1 });
    expect(await dueRuns(t)).toEqual([]);
    expect((await lookRow(t)).nextLookAt).toBeUndefined();
  });

  test("a quiet or long-silent chat looks only when mail is shared with it, and its next turn arms it again", async () => {
    gmail();
    const t = setupTest();
    await family(t);
    const silentSince = Date.now() - DORMANT_MS - 1;
    // A look's own turn is nobody talking: it never keeps a silent chat looking.
    await patchLook(t, { lastSeenAt: silentSince });
    await turn(t, SEYI, { routine: true });
    expect((await lookRow(t)).lastSeenAt).toBe(silentSince);
    await patchLook(t, { nextLookAt: Date.now() - 1 });
    expect(await dueRuns(t)).toEqual([]);
    expect((await lookRow(t)).nextLookAt).toBeUndefined();
    await patchLook(t, { engagement: "quiet", lastSeenAt: Date.now(), nextLookAt: Date.now() - 1 });
    expect(await dueRuns(t)).toEqual([]);

    await turn(t, SEYI);
    expect((await lookRow(t)).nextLookAt).toBeGreaterThan(Date.now());
    const { connectionId } = { connectionId: (await t.run(async (ctx) => await ctx.db.query("googleConnections").first()))!._id };
    await t.run((ctx) => ctx.db.patch(connectionId, { push: { gmail: { address: WORK } } }));
    await turn(t, SEYI, share(WORK));
    await patchLook(t, { lastSeenAt: Date.now() - DORMANT_MS - 1, nextLookAt: Date.now() - 1 });
    expect(await dueRuns(t)).toEqual([expect.objectContaining({ path: CHAT_LOOK_PATH })]);
  });

  test("the person's own check-in is told which of their mailboxes a chat watches", async () => {
    const queries = gmail();
    const t = setupTest();
    const { seyi } = await shared(t);
    const own = "cat_seyi_own_check_in_not_real";
    await registerClient(t, "context_heartbeat");
    await seedConnectedClient(t, { workspaceId: seyi.workspaceId, userId: seyi.userId, clientId: "context_heartbeat", accessToken: own, scopes: ["context:read", "context:write", "context:private"] });
    const answer = await search(t, own, seyi.workspaceId);
    expect(answer.mailboxes).toEqual([expect.objectContaining({ address: WORK, watchedIn: ["crystal-care"] })]);
    expect(queries.length).toBeGreaterThan(0);
  });
});
