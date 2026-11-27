/**
 * THE CHATS A MEMBER'S CONTACTS MAY NAME GUESTS IN (`functions/texPage.ts` `guestsFor`, Dev2 2026-11-27).
 *
 * The Context app on a member's phone names the guests in that person's Tex group chats from its contacts. The
 * control plane answers only which chats are the person's, from the console grant and never the request; who is in
 * each chat, by number, is the chat's own ledger's (the gateway's `contacts.js`), so no number is kept here.
 *
 * Sabotage (run by hand, each must fail a test here): drop the `homeUsers` check in `guestsFor` and "another person's
 * chat is never listed" fails; return chats in scan order and "newest first" fails.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

const OLD = "ab".repeat(32);
const NEW = "cd".repeat(32);
const BOS = "ef".repeat(32);

type T = ReturnType<typeof setupTest>;

async function person(t: T, name: string) {
  const userId = await createUser(t, `${name}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, name, { kind: "personal" });
  const token = (await asUser(t, userId).action(api.functions.agentGrant.mintConsoleGrant, { workspaceId })).accessToken;
  return { userId, token };
}

const chat = (t: T, groupKey: string, homeUsers: Id<"users">[], lastSeenAt: number) =>
  t.run(async (ctx) => void (await ctx.db.insert("textGroups", { groupKey, homeWords: `words-${groupKey.slice(0, 4)}`, homeUsers, lastSeenAt })));

const guests = async (t: T, accessToken: string) => (await (await gatewayPost(t, "/gateway/tex/page/guests", { accessToken })).json()) as Record<string, unknown>;

describe("the chats a member's contacts may name guests in", () => {
  test("a member gets their own chats, newest first, and only their keys", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    await chat(t, OLD, [ada.userId], 1_000);
    await chat(t, NEW, [ada.userId], 2_000);
    expect(await guests(t, ada.token)).toEqual({ status: "ok", chats: [{ key: NEW }, { key: OLD }] });
  });

  test("another person's chat is never listed, and an unknown token is refused", async () => {
    const t = setupTest();
    const ada = await person(t, "ada");
    const bo = await person(t, "bo");
    await chat(t, NEW, [ada.userId], 2_000);
    await chat(t, BOS, [bo.userId], 3_000);
    expect(await guests(t, ada.token)).toEqual({ status: "ok", chats: [{ key: NEW }] });
    expect(await guests(t, "cat_not_a_token")).toEqual({ status: "refused" });
    expect(await guests(t, "")).toEqual({ status: "bad_request" });
  });
});
