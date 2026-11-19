/**
 * A GOOGLE CALENDAR SHARED WITH ONE GROUP CHAT (`lib/textGroupCalendar.ts`, `personCalendar.ts` `chatCalendarRead`).
 *
 * "Tex, share my calendar here" from the calendar's own person, in a chat they are one of the people of, lets that
 * chat's turns read it live through `/gateway/calendar/days` with the chat's own grant, the same way mail shared with a
 * chat is read (`textGroupMailHomes.test.ts`). A group turn reads no one's calendar otherwise.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - drop `ownCalendar` from `shareCalendar`: "someone else's address is refused" fails;
 *  - drop `inChat` from `shareCalendar`: "a non-member cannot share" fails;
 *  - drop the `speaksUpOf` check in `liveCalendarShares`: "a muted chat reads nothing" fails;
 *  - ignore `account` in `chatCalendarRead`: "an account not shared is refused" fails;
 *  - read every share instead of this chat's: "a chat never reads a calendar shared into another chat" fails;
 *  - return a read with no share instead of `not_allowed`: "a group grant with no share is refused" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { shareCalendar } from "../functions/lib/textGroupCalendar";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";
import { bodyOf } from "./controlPlane/fixtures.helpers";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "5A1B2C3D-4E5F-4061-8728-394A5B6C7D8E";
const OTHER_GROUP = "6B2C3D4E-5F60-4172-8839-4A5B6C7D8E9F";
const SEYI = "+15555550120";
const DAD = "+15555550131";
const WORK = "seyi@work.example";
const HOUR = 60 * 60 * 1000;
const DATE = "2026-10-23";

type T = PinnedWorld["t"];

/** Google Calendar holding one dinner; anything else goes to the fetch already stubbed. */
function calendar() {
  const before = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://www.googleapis.com/calendar/")) return await before(input, init);
    return new Response(
      JSON.stringify({
        timeZone: "America/New_York",
        items: [{ id: "e1", summary: "Dinner with Ada", start: { dateTime: `${DATE}T19:00:00-04:00` }, end: { dateTime: `${DATE}T21:00:00-04:00` } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
}

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

/** Seyi's Google calendar, connected to Seyi's own personal workspace and readable by AI. */
async function connectCalendar(t: T, workspaceId: Id<"workspaces">, userId: Id<"users">, address: string) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy: userId, address, googleAccountId: `id-${address}` });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["calendar"],
      scopes: ["https://www.googleapis.com/auth/calendar.events.readonly"],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + HOUR,
    }),
  );
  return id;
}

/** The pinned world; Seyi and Dad are both in the chat; Seyi's work calendar is connected to Seyi's own workspace. */
async function world() {
  const w = await pinnedWorld();
  await migrate(w);
  const seyi = await texter(w.t, "seyi", SEYI);
  const dad = await texter(w.t, "dad", DAD);
  const care = await createWorkspace(w.t, seyi.userId, "crystal-care", { kind: "shared" });
  await addMember(w.t, care, dad.userId, "editor");
  await connectCalendar(w.t, seyi.workspaceId, seyi.userId, WORK);
  const turn = async (sender: string, extra: Record<string, unknown> = {}) =>
    await agentPost(w.t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: [SEYI, DAD, LINE], mint: true, ...extra });
  return { w, t: w.t, seyi, dad, turn };
}

/** A command on a chat's own grant, as the agent's tools make it. */
const command = async (t: T, token: string, cmd: Record<string, unknown>) =>
  t.mutation(internal.functions.texCommands.applyTexCommand, { hashedAccessToken: await hashToken(token), command: cmd as never });

/** One read of a day's calendars on a grant, as the gateway route answers it. */
const days = async (t: T, accessToken: string, workspaceId: Id<"workspaces">, extra: Record<string, unknown> = {}) =>
  await bodyOf(await gatewayPost(t, "/gateway/calendar/days", { accessToken, expectedWorkspaceId: workspaceId, date: DATE, ...extra }));

describe("a calendar shared with a group chat is read by that chat", () => {
  test("the owner shares it, and the chat's grant reads that calendar", async () => {
    const { w, t, turn } = await world();
    calendar();
    const seyiTurn = await turn(SEYI);
    expect(seyiTurn).toMatchObject({ status: "ready" });
    expect(await command(t, seyiTurn.accessToken as string, { kind: "share_calendar", address: WORK })).toEqual({ status: "done", addresses: [WORK] });
    const ready = await turn(DAD);
    expect(ready.calendar).toEqual([{ handle: "seyi", address: WORK }]);
    const answer = await days(t, ready.accessToken as string, w.pinned, { days: 1 });
    expect(answer).toMatchObject({ ok: true, days: [expect.objectContaining({ address: WORK, events: 1 })] });
  });

  test("a share with no address shares every calendar the person has connected", async () => {
    const { w, t, seyi, turn } = await world();
    await connectCalendar(t, seyi.workspaceId, seyi.userId, "seyi@home.example");
    const token = (await turn(SEYI)).accessToken as string;
    expect(await command(t, token, { kind: "share_calendar" })).toEqual({ status: "done", addresses: [WORK, "seyi@home.example"] });
  });

  test("only the calendar's own person shares it: someone else's address is refused", async () => {
    const { t, turn } = await world();
    const dadToken = (await turn(DAD)).accessToken as string;
    expect(await command(t, dadToken, { kind: "share_calendar", address: WORK })).toEqual({ status: "calendar_refused" });
    const seyiToken = (await turn(SEYI)).accessToken as string;
    expect(await command(t, seyiToken, { kind: "share_calendar", address: "dad@other.example" })).toEqual({ status: "calendar_refused" });
    expect(await command(t, seyiToken, { kind: "share_calendar", address: "not an address" })).toEqual({ status: "calendar_refused" });
  });

  test("a non-member cannot share", async () => {
    const { w, t, seyi, turn } = await world();
    const token = (await turn(SEYI)).accessToken as string;
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("textGroups").collect())[0]!;
      await ctx.db.patch(chat._id, { homeUsers: (chat.homeUsers ?? []).filter((id) => id !== seyi.userId) });
    });
    expect(await command(t, token, { kind: "share_calendar", address: WORK })).toEqual({ status: "calendar_refused" });
    const shared = await t.run(async (ctx) => await shareCalendar(ctx, (await ctx.db.query("textGroups").collect())[0]!, seyi.userId, WORK, Date.now()));
    expect(shared).toBeNull();
    void w;
  });

  test("unsharing stops reads, and names only the sender's own shares", async () => {
    const { w, t, turn } = await world();
    calendar();
    const seyiToken = (await turn(SEYI)).accessToken as string;
    await command(t, seyiToken, { kind: "share_calendar", address: WORK });
    const token = (await turn(DAD)).accessToken as string;
    expect(await days(t, token, w.pinned)).toMatchObject({ ok: true });
    // A fresh turn of the sharer's own: each turn mints its grant for the one who spoke.
    const seyiFresh = (await turn(SEYI)).accessToken as string;
    expect(await command(t, seyiFresh, { kind: "unshare_calendar" })).toEqual({ status: "done", count: 1 });
    expect(await days(t, token, w.pinned)).toEqual({ ok: false, refused: "not_allowed" });
    expect((await turn(DAD)).calendar).toBeUndefined();
  });

  test("a muted chat reads nothing", async () => {
    const { w, t, turn } = await world();
    calendar();
    const seyiToken = (await turn(SEYI)).accessToken as string;
    await command(t, seyiToken, { kind: "share_calendar", address: WORK });
    const token = (await turn(DAD)).accessToken as string;
    expect(await days(t, token, w.pinned)).toMatchObject({ ok: true });
    await command(t, seyiToken, { kind: "mute" });
    expect(await days(t, token, w.pinned)).toEqual({ ok: false, refused: "not_allowed" });
  });

  test("a group grant with no share is refused, never another person's calendar", async () => {
    const { w, t, turn } = await world();
    calendar();
    const token = (await turn(DAD)).accessToken as string;
    expect(await days(t, token, w.pinned)).toEqual({ ok: false, refused: "not_allowed" });
  });

  test("an account the chat was not shown is refused, and a shared one reads", async () => {
    const { w, t, turn } = await world();
    calendar();
    const seyiToken = (await turn(SEYI)).accessToken as string;
    await command(t, seyiToken, { kind: "share_calendar", address: WORK });
    const token = (await turn(DAD)).accessToken as string;
    expect(await days(t, token, w.pinned, { account: "other@work.example" })).toEqual({ ok: false, refused: "other_calendar" });
    expect(await days(t, token, w.pinned, { account: WORK })).toMatchObject({ ok: true, days: [expect.objectContaining({ address: WORK })] });
  });

  test("the settings answer lists whose calendar is shared here", async () => {
    const { t, turn } = await world();
    const seyiToken = (await turn(SEYI)).accessToken as string;
    await command(t, seyiToken, { kind: "share_calendar", address: WORK });
    const dadToken = (await turn(DAD)).accessToken as string;
    expect(await command(t, dadToken, { kind: "settings" })).toMatchObject({ status: "done", calendar: [{ handle: "seyi", address: WORK }] });
  });

  test("a chat's grant never reads a calendar shared into a different chat", async () => {
    const { w, t, turn } = await world();
    calendar();
    const seyiHere = (await turn(SEYI)).accessToken as string;
    const seyiThere = (await turn(SEYI, { groupId: OTHER_GROUP })).accessToken as string;
    await command(t, seyiThere, { kind: "share_calendar", address: WORK });
    const readHere = (await turn(DAD)).accessToken as string;
    expect(await days(t, readHere, w.pinned)).toEqual({ ok: false, refused: "not_allowed" });
    const readThere = (await turn(DAD, { groupId: OTHER_GROUP })).accessToken as string;
    expect(await days(t, readThere, w.pinned)).toMatchObject({ ok: true });
    void seyiHere;
  });
});

describe("a calendar share is the calendar's own person's, and is audited on their workspace", () => {
  test("the share lands on the sharer's personal workspace, with one audit row", async () => {
    const { t, seyi, turn } = await world();
    const token = (await turn(SEYI)).accessToken as string;
    await command(t, token, { kind: "share_calendar", address: WORK });
    const rows = await t.run(async (ctx) => (await ctx.db.query("chatCalendarShares").collect()) as Doc<"chatCalendarShares">[]);
    expect(rows).toEqual([expect.objectContaining({ userId: seyi.userId, workspaceId: seyi.workspaceId, address: WORK })]);
    const audits = await t.run(async (ctx) => (await ctx.db.query("auditEvents").collect()).filter((row) => row.action === "calendar.shared_with_chat"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ workspaceId: seyi.workspaceId });
  });
});
