/**
 * Lab drafts of Tex's Training and Dev conversations (`functions/texSets.ts`; Dev2, 2026-11-15: "make sure that through
 * the MCP it's easy for an agent to see and modify and change training, dev sets"). Two doors, one store: the Lab's
 * Testing tab as a staff member (`api.functions.texSets.*`), and `tex_dev`'s set actions over the gateway. Pinned: who
 * may write, that a repo conversation's first edit carries its base and lands at revision 1, that an edit against an
 * older revision is refused only when the same piece changed, the Test Set refused in every place it could be stored,
 * create and remove, Promote's marks, and the workflow that clears a draft once its pull request merges.
 *
 * The set actions reach `setAction` through `forGateway`, the same internal mutation the gateway route calls after its
 * own action check, so most tests call `forGateway` directly; the last proves the route passes every `set_*` action on.
 *
 * Sabotage record (temporary local edits to functions/texSets.ts, restored from a byte-identical backup, 2026-11-15):
 *   no base-required check on a first edit          "the first edit of a repo conversation needs its base ..." fails
 *   no conflicts() check on a stale edit            "the later edit to the same label field is a conflict ..." fails
 *   sound() without the test-set check              "the test set is refused in a base, in ops and in a new conversation ..." fails
 *   removing a repo row without removed: true       "removing a repo conversation marks it ..." fails
 *   merged clearing every draft, not only unchanged "the workflow clears a draft unchanged since promote ..." fails
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { addMember, createUser, createWorkspace, gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./fixtures.helpers";
import { withSession } from "../session.helpers";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
beforeEach(() => vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`));
afterEach(() => vi.unstubAllEnvs());

/** A repo conversation as the repo has it (`apps/mcp/bench/sets/<set>/<id>.json`), with one person and Tex's row. */
const BASE = {
  id: "chat-a",
  title: "Bins",
  set: "dev",
  kind: "one",
  members: ["Jo"],
  msgs: [
    { id: "m1", who: "Jo", text: "is the bin out?" },
    { id: "m2", who: "Tex", tex: true, text: "yes, this morning" },
  ],
};
const TITLE = [{ op: "title", value: "Bins 2" }];
const PR = "https://github.com/example/repo/pull/12";

async function world(role: "editor" | "member" = "editor") {
  const tenants = await twoConnectedTenants();
  const staff = await createUser(tenants.t, STAFF);
  const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
  await addMember(tenants.t, pinned, tenants.alice, role, staff);
  // The set actions through the gateway's internal door (see the header): the same check the route makes, then `setAction`.
  const door = async (action: string, args: Record<string, unknown> = {}, token = ACCESS_A): Promise<Record<string, any>> =>
    (await tenants.t.mutation(internal.functions.texLabDrafts.forGateway, { hashedAccessToken: await hashToken(token), action, args })) as Record<string, any>;
  return { ...tenants, staff, pinned, door, lab: withSession(tenants.t, staff) };
}

const drafts = async (door: (action: string) => Promise<Record<string, any>>) => (await door("set_drafts")).drafts as Array<Record<string, any>>;
const rowsOf = async (t: Awaited<ReturnType<typeof world>>["t"], convoId: string) =>
  (await t.run(async (ctx) => await ctx.db.query("texSetConvos").collect())).filter((r) => r.convoId === convoId);

describe("tex_dev's set actions and the Lab's Testing tab: who may write", () => {
  test("a stranger, a plain member and a stranger to the Lab are refused", async () => {
    const w = await world();
    expect(await w.door("set_drafts", {}, ACCESS_B)).toEqual({ status: "refused" });
    expect(await w.door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE }, ACCESS_B)).toEqual({ status: "refused" });
    const member = await world("member");
    expect(await member.door("set_drafts")).toEqual({ status: "refused" });
    expect(await member.door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE })).toEqual({ status: "refused" });
    const stranger = withSession(w.t, await createUser(w.t, "stranger@example.invalid"));
    await expect(stranger.query(api.functions.texSets.list, {})).rejects.toThrow();
    await expect(stranger.mutation(api.functions.texSets.edit, { id: "chat-a", rev: 0, ops: TITLE, base: BASE })).rejects.toThrow();
    expect(await rowsOf(w.t, "chat-a")).toHaveLength(0);
  });
});

describe("tex_dev's set actions: edits", () => {
  test("the first edit of a repo conversation needs its base, lands as revision 1, and set_drafts lists it", async () => {
    const { door } = await world();
    expect(await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE })).toMatchObject({ status: "not_found" });
    const first = await door("set_edit", { id: "chat-a", rev: 0, ops: [{ op: "edit", msg: "m1", field: "text", value: "is the bin out yet?" }], base: BASE });
    expect(first).toMatchObject({ status: "ok", id: "chat-a", rev: 1, said: ['m1 text → is the bin out yet?'] });
    const listed = (await drafts(door)).find((d) => d.id === "chat-a");
    expect(listed).toMatchObject({ set: "dev", rev: 1, isNew: false, removed: false });
    expect(JSON.parse(listed!.conv).msgs[0].text).toBe("is the bin out yet?");
  });

  test("a second edit at revision 1 lands as revision 2; two edits from revision 1 to different messages both land", async () => {
    const { door } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE }); // rev 1
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "edit", msg: "m1", field: "text", value: "is the bin out?!" }] })).toMatchObject({ status: "ok", rev: 2 });
    // Made against revision 1, on the other message: the change since touched only m1, so it lands.
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "edit", msg: "m2", field: "text", value: "yes, this morning." }] })).toMatchObject({ status: "ok", rev: 3 });
    const got = (await drafts(door)).find((d) => d.id === "chat-a");
    expect(JSON.parse(got!.conv).msgs.map((m: { text: string }) => m.text)).toEqual(["is the bin out?!", "yes, this morning."]);
  });

  test("the later edit to the same label field is a conflict, with its pieces and the conversation as it is now; the Lab sees the same", async () => {
    const { door, lab } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE }); // rev 1
    const label = (act: string) => [{ op: "field", msg: "m1", node: "decide", field: "act", value: act }];
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: label("respond") })).toMatchObject({ status: "ok", rev: 2 });
    const lost = await door("set_edit", { id: "chat-a", rev: 1, ops: label("quiet") });
    expect(lost).toMatchObject({ status: "conflict", rev: 2, keys: ["l:m1:decide:act"] });
    expect(JSON.parse(lost.conv).msgs[0].labels).toEqual({ decide: { act: "respond" } });
    expect((await drafts(door)).find((d) => d.id === "chat-a")!.rev).toBe(2);
    // The Lab's door answers the conflict as an answer, not an error.
    const fromLab = await lab.mutation(api.functions.texSets.edit, { id: "chat-a", rev: 1, ops: label("quiet") });
    expect(fromLab).toMatchObject({ status: "conflict", rev: 2, keys: ["l:m1:decide:act"] });
    // Labels on different fields of one message, made against the same revision, both land.
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "field", msg: "m1", node: "decide", field: "why", value: "asks_tex" }] })).toMatchObject({ status: "ok", rev: 3 });
  });

  test("the Lab's edit lands as the same revision line the tool sees", async () => {
    const { door, lab } = await world();
    await lab.mutation(api.functions.texSets.edit, { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "title", value: "From the tool" }] })).toMatchObject({ status: "ok", rev: 2 });
    expect((await lab.query(api.functions.texSets.list, {})).drafts.find((d: { id: string }) => d.id === "chat-a")).toMatchObject({ rev: 2, by: "@alfa", via: expect.stringContaining("mcp_client_alpha") });
  });
});

describe("the test set", () => {
  test("the test set is refused in a base, in ops and in a new conversation, from both doors", async () => {
    const { t, door, lab } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE }); // rev 1, so the refusals below are the set's own
    const testBase = { ...BASE, id: "chat-t", set: "test" };
    expect(await door("set_edit", { id: "chat-t", rev: 0, ops: TITLE, base: testBase })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/Test Set is people only/) });
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "set", value: "test" }] })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/Test Set is people only/) });
    expect(await door("set_create", { conv: { ...BASE, id: "chat-n", set: "test" } })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/Test Set/) });
    expect(await door("set_create", { id: "chat-n", set: "test" })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/Test Set/) });
    await expect(lab.mutation(api.functions.texSets.edit, { id: "chat-a", rev: 1, ops: [{ op: "set", value: "test" }] })).rejects.toThrow(/Test Set is people only/);
    await expect(lab.mutation(api.functions.texSets.create, { conv: { ...BASE, id: "chat-n", set: "test" } })).rejects.toThrow(/Test Set is people only/);
    expect(await rowsOf(t, "chat-t")).toHaveLength(0);
    expect(await rowsOf(t, "chat-n")).toHaveLength(0);
    expect((await drafts(door)).map((d) => d.id)).toEqual(["chat-a"]);
  });
});

describe("create and remove", () => {
  test("a new conversation is created, and removed at once; a repo id is not made again", async () => {
    const { t, door } = await world();
    const fresh = { ...BASE, id: "fresh-chat", title: "Fresh" };
    expect(await door("set_create", { conv: fresh, repoIds: ["chat-a"] })).toMatchObject({ status: "ok", id: "fresh-chat", rev: 1 });
    expect((await drafts(door)).find((d) => d.id === "fresh-chat")).toMatchObject({ isNew: true, rev: 1 });
    expect(await door("set_remove", { id: "fresh-chat" })).toEqual({ status: "ok", id: "fresh-chat", deleted: "now" });
    expect((await drafts(door)).some((d) => d.id === "fresh-chat")).toBe(false);
    expect(await rowsOf(t, "fresh-chat")).toHaveLength(0);
    expect(await door("set_edit", { id: "fresh-chat", rev: 0, ops: TITLE })).toMatchObject({ status: "not_found" });
    expect(await door("set_create", { conv: BASE, repoIds: ["chat-a"] })).toMatchObject({ status: "bad_request", error: "there is already a conversation chat-a" });
  });

  test("removing a repo conversation marks it; its edits are refused until it is restored", async () => {
    const { t, door, lab } = await world();
    expect(await door("set_remove", { id: "chat-a", base: BASE })).toEqual({ status: "ok", id: "chat-a", deleted: "at the next Promote" });
    expect((await drafts(door)).find((d) => d.id === "chat-a")).toMatchObject({ removed: true, rev: 1 });
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: TITLE })).toMatchObject({ status: "bad_request", error: expect.stringMatching(/restore it first/) });
    expect(await door("set_remove", { id: "chat-a", restore: true })).toEqual({ status: "ok", id: "chat-a", restored: true });
    expect((await drafts(door)).some((d) => d.id === "chat-a")).toBe(false);
    expect(await rowsOf(t, "chat-a")).toHaveLength(0);
    // Restored: the repo's copy is editable again, from its base at revision 0.
    expect(await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE })).toMatchObject({ status: "ok", rev: 1 });
    // The Lab removes the same way, and marks what the list shows.
    expect(await lab.mutation(api.functions.texSets.remove, { id: "chat-a", base: BASE })).toEqual({ status: "ok", id: "chat-a", deleted: "at the next Promote" });
    expect((await lab.query(api.functions.texSets.list, {})).drafts.find((d: { id: string }) => d.id === "chat-a")).toMatchObject({ removed: true });
  });
});

describe("promote", () => {
  test("set_promote marks the drafts asked, the Lab's list shows it, and an unknown id is refused", async () => {
    const { door, lab } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    expect(await door("set_promote", { ids: ["chat-a"] })).toMatchObject({ status: "ok", asked: ["chat-a"] });
    expect((await lab.query(api.functions.texSets.list, {})).drafts.find((d: { id: string }) => d.id === "chat-a")).toMatchObject({ promote: { state: "asked", pr: null } });
    expect(await door("set_promote", { ids: ["chat-zz"] })).toMatchObject({ status: "not_found", error: "no draft of chat-zz" });
  });

  test("the workflow clears a draft unchanged since promote once its pull request merges, and keeps one edited after", async () => {
    const { t, door } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    await door("set_edit", { id: "chat-b", rev: 0, ops: TITLE, base: { ...BASE, id: "chat-b" } });
    expect(await door("set_promote", {})).toMatchObject({ status: "ok", asked: ["chat-a", "chat-b"] });

    const asked = await t.query(internal.functions.texSets.asked, {});
    expect(asked.map((a) => [a.id, a.rev])).toEqual([["chat-a", 1], ["chat-b", 1]]);
    await t.mutation(internal.functions.texSets.answered, { items: asked.map((a) => ({ id: a.id, at: a.at, pr: PR })) });
    expect(await t.query(internal.functions.texSets.opened, {})).toEqual([
      { id: "chat-a", rev: 1, pr: PR },
      { id: "chat-b", rev: 1, pr: PR },
    ]);
    // Asked again after it was answered: nothing left to ask.
    expect(await t.query(internal.functions.texSets.asked, {})).toEqual([]);

    // chat-b is edited after its pull request was opened: it is not the file the pull request writes.
    expect(await door("set_edit", { id: "chat-b", rev: 1, ops: [{ op: "title", value: "Changed after" }] })).toMatchObject({ status: "ok", rev: 2 });
    expect(await t.mutation(internal.functions.texSets.merged, { pr: PR })).toEqual(["chat-a"]);
    const left = await drafts(door);
    expect(left.map((d) => [d.id, d.rev, d.promote])).toEqual([["chat-b", 2, null]]);
    expect(JSON.parse(left[0].conv).title).toBe("Changed after");
    expect(await rowsOf(t, "chat-a")).toHaveLength(0);
  });

  test("the workflow records a refusal with its reason, and only a GitHub pull request address is taken", async () => {
    const { t, door } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    await door("set_promote", { ids: ["chat-a"] });
    const [ask] = await t.query(internal.functions.texSets.asked, {});
    await t.mutation(internal.functions.texSets.answered, { items: [{ id: "chat-a", at: ask.at, why: "the file has a conflict" }] });
    expect(await t.query(internal.functions.texSets.opened, {})).toEqual([]);
    expect((await drafts(door))[0].promote).toEqual({ state: "refused", rev: 1, pr: null, why: "the file has a conflict" });
    await expect(t.mutation(internal.functions.texSets.answered, { items: [{ id: "chat-a", at: ask.at, pr: "https://example.invalid/pr/1" }] })).rejects.toThrow(/Not a pull request address/);
    await expect(t.mutation(internal.functions.texSets.merged, { pr: "nope" })).rejects.toThrow(/Not a pull request address/);
  });
});

// Dev2, 2026-11-16: "Made some change and I couldnt undo it, please make sure we have a change history and the ability to undo".
describe("change history and putting a revision back", () => {
  test("every revision is listed newest first and any one can be put back as a new revision", async () => {
    const { door } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "edit", msg: "m1", field: "text", value: "where is the bin?" }] });
    const h = await door("set_history", { id: "chat-a" });
    expect(h).toMatchObject({ status: "ok", rev: 2, isNew: false });
    expect(h.revs.map((r: { rev: number }) => r.rev)).toEqual([2, 1]);
    expect(h.revs.every((r: { restorable: boolean }) => r.restorable)).toBe(true);

    const back = await door("set_back", { id: "chat-a", to: 1 });
    expect(back).toMatchObject({ status: "ok", rev: 3, said: ["put back revision 1"] });
    const now = JSON.parse(back.conv);
    expect(now.title).toBe("Bins 2");
    expect(now.msgs[0].text).toBe("is the bin out?");
    // Undo is a revision too: putting 2 back redoes it.
    expect(JSON.parse((await door("set_back", { id: "chat-a", to: 2 })).conv).msgs[0].text).toBe("where is the bin?");
  });

  test("revision 0 is the repo's copy, a revision out of range is refused, and the Lab's door does the same as staff", async () => {
    const { door, lab } = await world();
    await door("set_edit", { id: "chat-a", rev: 0, ops: TITLE, base: BASE });
    expect(await door("set_back", { id: "chat-a", to: 9 })).toMatchObject({ status: "bad_request" });
    expect((await lab.query(api.functions.texSets.history, { id: "chat-a" })).revs).toHaveLength(1);
    expect(await lab.mutation(api.functions.texSets.restoreTo, { id: "chat-a", to: 0 })).toMatchObject({ status: "ok", rev: 0 });
    expect(await drafts(door)).toEqual([]);
    expect(await door("set_back", { id: "chat-a", to: 1 })).toMatchObject({ status: "not_found" });
  });

  test("a message's pictures are kept, and a picture that is not an https address is refused", async () => {
    const { door } = await world();
    const pic = { url: "https://example.invalid/p.png", type: "image/png", name: "p.png" };
    const ok = await door("set_edit", { id: "chat-a", rev: 0, ops: [{ op: "edit", msg: "m1", field: "pics", value: [pic] }], base: BASE });
    expect(JSON.parse(ok.conv).msgs[0].pics).toEqual([pic]);
    expect(await door("set_edit", { id: "chat-a", rev: 1, ops: [{ op: "edit", msg: "m1", field: "pics", value: [{ url: "javascript:alert(1)" }] }] })).toMatchObject({ status: "bad_request" });
  });
});

// Found by this file's first draft (2026-11-15): the route's action list had no set_* name, so none reached the store.
test("POST /gateway/tex/dev passes every set action to the set store", async () => {
  const { t } = await world();
  for (const action of ["set_drafts", "set_edit", "set_create", "set_remove", "set_promote", "set_history", "set_back"]) {
    const answer = await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action, args: {} }));
    expect(answer.status === "bad_request" && answer.error === undefined).toBe(false);
  }
  expect(await bodyOf(await gatewayPost(t, "/gateway/tex/dev", { accessToken: ACCESS_A, action: "set_drafts", args: {} }))).toMatchObject({ status: "ok", drafts: [] });
});
