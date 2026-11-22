/**
 * The Lab's test chats, the control plane's half (`functions/texLabSandbox.ts`; Dev2, 2026-11-16). Only a staff
 * editor of the pinned context, on the Lab's own client or an AI client of their own, gets an answer; a chat they are
 * not in answers as one that does not exist; the session handed back never carries a token.
 *
 * Sabotage (temporary local edits, reverted, 2026-11-16):
 *   `sandboxCaller` without the staff check            "a stranger, a plain member, a non-staff editor ..." fails
 *   `sandboxCaller` letting every context_ client in    "... and Tex's own clients are refused" fails
 *   `sessionFor` without the homeUsers check            "a group chat the caller is not in ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { addMember, createUser, createWorkspace, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, registerClient, seedConnectedClient, token, twoConnectedTenants } from "./fixtures.helpers";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
beforeEach(() => vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`));
afterEach(() => vi.unstubAllEnvs());

const CONSOLE = token("lab_console");
const TEXTING = token("lab_texting");

async function world(role: "editor" | "member" = "editor") {
  const tenants = await twoConnectedTenants();
  const staff = await createUser(tenants.t, STAFF);
  const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  await addMember(tenants.t, pinned, tenants.alice, role, staff);
  await registerClient(tenants.t, "context_console");
  await seedConnectedClient(tenants.t, { workspaceId: tenants.aliceWs, userId: tenants.alice, clientId: "context_console", accessToken: CONSOLE });
  const lab = async (action: string, args: Record<string, unknown> = {}, accessToken = CONSOLE) =>
    await bodyOf(await gatewayPost(tenants.t, "/gateway/tex/lab-sandbox", { accessToken, action, args }));
  return { ...tenants, staff, pinned, lab };
}

describe("Lab test chats, control plane", () => {
  test("the Lab's own client and an AI client of a staff editor are let in", async () => {
    const w = await world();
    expect(await w.lab("who")).toMatchObject({ userId: w.alice });
    expect(await w.lab("who", {}, ACCESS_A)).toMatchObject({ userId: w.alice });
  });

  test("a stranger, a plain member, a non-staff editor and Tex's own clients are refused", async () => {
    const w = await world();
    expect(await w.lab("who", {}, ACCESS_B)).toEqual({ status: "refused" });
    await registerClient(w.t, "context_texts");
    await seedConnectedClient(w.t, { workspaceId: w.aliceWs, userId: w.alice, clientId: "context_texts", accessToken: TEXTING });
    expect(await w.lab("who", {}, TEXTING)).toEqual({ status: "refused" });
    vi.stubEnv("ADMIN_EMAILS", STAFF);
    expect(await w.lab("who")).toEqual({ status: "refused" });
    vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`);
    const m = await world("member");
    expect(await m.lab("who")).toEqual({ status: "refused" });
  });

  test("the 1:1 session is read from the person's texting grant, without its token", async () => {
    const w = await world();
    expect(await w.lab("session", { chat: "me" })).toMatchObject({ status: "not_found" });
    await registerClient(w.t, "context_texts");
    const grant = await seedConnectedClient(w.t, { workspaceId: w.aliceWs, userId: w.alice, clientId: "context_texts", accessToken: TEXTING });
    const got = await w.lab("session", { chat: "me" });
    expect(got).toMatchObject({ status: "ok", session: { grantId: grant, clientId: "context_texts", defaultWorkspaceId: w.aliceWs } });
    expect(JSON.stringify(got)).not.toContain(TEXTING);
    expect(JSON.stringify(got)).not.toMatch(/hashed|accessToken|refresh/i);
  });

  test("a group chat the caller is not in answers as one that does not exist", async () => {
    const w = await world();
    const key = "a".repeat(64);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: key, homeUsers: [w.bob], lastSeenAt: Date.now() } as never);
    });
    expect(await w.lab("session", { chat: key })).toMatchObject({ status: "not_found", error: "There is no such chat." });
    expect(await w.lab("session", { chat: "b".repeat(64) })).toMatchObject({ status: "not_found", error: "There is no such chat." });
    expect(await w.lab("session", { chat: "not-a-key" })).toMatchObject({ status: "bad_request" });
  });

  test("sets hands the Training and Dev drafts for the picker, removed ones marked, and only to a Tex developer", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      const row = { isNew: true, rev: 1, by: w.alice, via: "lab", updatedAt: Date.now() };
      await ctx.db.insert("texSetConvos", { ...row, convoId: "fresh-one", set: "dev", removed: false, data: JSON.stringify({ id: "fresh-one", set: "dev", msgs: [] }) });
      await ctx.db.insert("texSetConvos", { ...row, convoId: "gone-one", set: "training", removed: true, data: JSON.stringify({ id: "gone-one", set: "training", msgs: [] }) });
    });
    const got = (await w.lab("sets")) as { status: string; drafts: { id: string; set: string; removed: boolean; conv: string }[] };
    expect(got.status).toBe("ok");
    expect(got.drafts.map((d) => [d.id, d.set, d.removed]).sort()).toEqual([["fresh-one", "dev", false], ["gone-one", "training", true]]);
    expect(JSON.parse(got.drafts.find((d) => d.id === "fresh-one")!.conv)).toMatchObject({ id: "fresh-one" });
    expect(await w.lab("sets", {}, ACCESS_B)).toEqual({ status: "refused" });
  });

  test("a draft's graph is read by its id; main is no override", async () => {
    const w = await world();
    expect(await w.lab("draft", { draft: "main" })).toEqual({ status: "ok", graph: null });
    expect(await w.lab("draft", { draft: "nope" })).toEqual({ status: "not_found" });
    expect(await w.lab("nonsense")).toEqual({ status: "bad_request" });
  });

  // The intake sweep's list went through the forGateway handler in its test but not this route, whose action list
  // missed it: every production sweep answered "Only staff sweep every chat." (2026-11-22).
  test("the intake sweep's chat list passes the route for staff, and only for staff", async () => {
    const w = await world();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("phoneLinks", { userId: w.alice, phone: "+15555550100", linkedAt: 1 });
    });
    expect(await w.lab("intakeChats")).toMatchObject({ status: "ok", phones: ["+15555550100"] });
    expect(await w.lab("intakeChats", {}, ACCESS_B)).toEqual({ status: "refused" });
  });
});
