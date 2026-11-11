/**
 * MAIL SHARED WITH A CHAT THAT HAS ITS OWN HOME (`lib/textGroupMail.ts`; the owner, 2026-11-11).
 *
 * A chat is bound to no workspace: it has its own home in the pin (`tex/groups/<words>/`) and reaches whatever every
 * one of its people shares (`lib/textGroupReach.ts`). Its turns' calls go to the home by default. A share is the
 * chat's, so a read on the chat's own grant finds it whichever of the grant's workspaces the call names.
 *
 * Found 2026-11-11 in the Crystal Care chat's ledger: 48 of 48 mail reads on the home were refused ("cannot read the
 * person's email") while the 3 that happened to name the reached workspace went through, because the clearance asked
 * for the one workspace `chatWorkspace` picked.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - put back the `chatWorkspace` match in `chatMailClearance`: "reads from the chat's home" fails;
 *  - drop the `covered` check there: "a workspace the grant does not cover" fails;
 *  - `inChat` true for anyone in a chat with a home: "only one of the chat's people" and "leaving the chat" fail;
 *  - skip the home in `wakeMailRoutines`: "new mail brings forward the chat's own routine" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { MAIL_WAKE_DELAY_MS } from "../functions/lib/routines/wake";
import type { Id } from "../_generated/dataModel";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { shareMail } from "../functions/lib/textGroupMail";
import { migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const LINE = "+15555550001";
const GROUP = "5A1B2C3D-4E5F-4061-8728-394A5B6C7D8E";
const SEYI = "+15555550120";
const DAD = "+15555550131";
const GUEST = "+15555550177";
const WORK = "seyi@work.example";
const HOUR = 60 * 60 * 1000;

type T = PinnedWorld["t"];

/** Gmail holding one message, m1; anything else goes to the fetch already stubbed (the pin's bucket). */
function gmail() {
  const before = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://gmail.googleapis.com/")) return await before(input, init);
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (new URL(url).pathname === "/gmail/v1/users/me/messages") return json({ messages: [{ id: "m1", threadId: "t1" }] });
    return json({
      id: "m1",
      threadId: "t1",
      internalDate: String(Date.parse("2024-03-02T10:00:00Z")),
      snippet: "Payment advice",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Payer <pay@example.invalid>" },
          { name: "Subject", value: "Payment advice" },
          { name: "Message-ID", value: "<pay-1@example.invalid>" },
        ],
        body: { data: btoa("Paid.").replace(/=+$/, ""), size: 5 },
      },
    });
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

const share = { command: { kind: "share_mail", address: WORK } };

/** The pinned world; Seyi and Dad both in @crystal-care; Seyi's work Gmail connected to Seyi's own workspace. */
async function world(people: string[] = [SEYI, DAD, LINE]) {
  const w = await pinnedWorld();
  await migrate(w);
  const seyi = await texter(w.t, "seyi", SEYI);
  const dad = await texter(w.t, "dad", DAD);
  const care = await createWorkspace(w.t, seyi.userId, "crystal-care", { kind: "shared" });
  await addMember(w.t, care, dad.userId, "editor");
  const id = await seedGoogleConnection(w.t, { workspaceId: seyi.workspaceId, boundBy: seyi.userId, address: WORK });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: seyi.workspaceId });
  await w.t.run((ctx) => ctx.db.patch(id, { encryptedAccessToken, accessTokenExpiresAt: Date.now() + HOUR }));
  const turn = async (sender: string, extra: Record<string, unknown> = {}) =>
    await agentPost(w.t, "/agent-texts/group", { line: LINE, groupId: GROUP, sender, participants: people, mint: true, ...extra });
  return { w, t: w.t, seyi, dad, care, turn };
}

const search = async (t: T, accessToken: string, workspaceId: Id<"workspaces">) =>
  (await (await gatewayPost(t, "/gateway/email/search", { accessToken, expectedWorkspaceId: workspaceId, query: "payment advice", outsideSync: true })).json()) as Record<string, unknown>;

describe("a chat with its own home reads mail shared with it", () => {
  test("reads from the chat's home, where its calls go by default, and from the workspace it reaches", async () => {
    const { w, t, care, turn } = await world();
    gmail();
    expect(await turn(SEYI)).toMatchObject({ status: "ready" });
    expect(await turn(SEYI, share)).toEqual({ status: "mail_shared", address: WORK, narrowed: false });
    const ready = await turn(DAD);
    expect(ready.mail).toEqual([{ handle: "seyi", address: WORK }]);
    const token = ready.accessToken as string;
    const grant = await t.run(async (ctx) => (await ctx.db.query("oauthGrants").collect()).find((row) => row.texGroup !== undefined)!);
    expect(grant).toMatchObject({ workspaceId: w.pinned, texGroup: { homeOnly: true } });
    expect(await search(t, token, w.pinned)).toMatchObject({ ok: true, results: [expect.objectContaining({ id: "m1" })] });
    expect(await search(t, token, care)).toMatchObject({ ok: true });
  });

  test("never through a workspace the grant does not cover", async () => {
    const { t, seyi, turn } = await world();
    gmail();
    await turn(SEYI);
    await turn(SEYI, share);
    const token = (await turn(DAD)).accessToken as string;
    expect(await search(t, token, seyi.workspaceId)).toMatchObject({ ok: false, refused: "not_allowed" });
  });

  test("a chat that reaches no workspace (a guest is in it) reads it too, from its home", async () => {
    const { w, t, turn } = await world([SEYI, DAD, GUEST, LINE]);
    gmail();
    await turn(SEYI);
    expect(await turn(SEYI, share)).toEqual({ status: "mail_shared", address: WORK, narrowed: false });
    const token = (await turn(SEYI)).accessToken as string;
    expect(await search(t, token, w.pinned)).toMatchObject({ ok: true });
  });

  test("only one of the chat's people shares into it", async () => {
    const { t, seyi, turn } = await world();
    gmail();
    await turn(SEYI);
    // Seyi is no longer one of the chat's people (the home names Dad alone).
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("textGroups").collect())[0]!;
      await ctx.db.patch(chat._id, { homeUsers: (chat.homeUsers ?? []).filter((id) => id !== seyi.userId) });
    });
    const shared = await t.run(async (ctx) => await shareMail(ctx, (await ctx.db.query("textGroups").collect())[0]!, seyi.userId, WORK, undefined, Date.now()));
    expect(shared).toBeNull();
  });

  test("leaving the chat ends the reads without a word", async () => {
    const { w, t, seyi, turn } = await world();
    gmail();
    await turn(SEYI);
    await turn(SEYI, share);
    const token = (await turn(DAD)).accessToken as string;
    expect(await search(t, token, w.pinned)).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query("textGroups").collect())[0]!;
      await ctx.db.patch(chat._id, { homeUsers: (chat.homeUsers ?? []).filter((id) => id !== seyi.userId) });
    });
    expect(await search(t, token, w.pinned)).toMatchObject({ ok: false, refused: "not_allowed" });
  });

  test("new mail brings forward the chat's own routine in its home", async () => {
    const { w, t, seyi, turn } = await world();
    gmail();
    await turn(SEYI);
    await turn(SEYI, share);
    const chat = await t.run(async (ctx) => (await ctx.db.query("textGroups").collect())[0]!);
    await t.run(async (ctx) => {
      const connection = (await ctx.db.query("googleConnections").first())!;
      await ctx.db.patch(connection._id, { push: { gmail: { address: WORK } } });
    });
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("routines", {
          workspaceId: w.pinned,
          path: `tex/groups/${chat.homeWords}/routines/mail.md`,
          writerUserId: seyi.userId,
          writerSource: "signal",
          cadence: { unit: "day", every: 1 },
          paused: false,
          send: "text",
          to: [],
          chat: chat.groupKey.slice(0, 16),
          nextRunAt: Date.now() + 12 * HOUR,
          updatedAt: Date.now(),
          wake: "mail" as const,
        }),
    );
    const before = Date.now();
    await t.mutation(internal.functions.googlePush.pokeFromPubsub, { gmailAddress: WORK });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row!.nextRunAt).toBeGreaterThanOrEqual(before + MAIL_WAKE_DELAY_MS);
    expect(row!.nextRunAt).toBeLessThan(before + MAIL_WAKE_DELAY_MS + HOUR / 60);
  });
});
