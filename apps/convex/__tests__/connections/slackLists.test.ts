import { afterEach, describe, expect, test, vi } from "vitest";
import { slackCallShaped } from "../../functions/lib/providers/slackLists";

/**
 * Slack's directory listings, read whole: "find Segun" is one call that
 * returns active people only, cut to what identifies them, however many pages
 * Slack splits the workspace into (`functions/lib/providers/slackLists.ts`).
 */

afterEach(() => vi.unstubAllGlobals());

type Sent = { method: string; form: URLSearchParams };

function person(id: string, realName: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: realName.toLowerCase().replace(/\s+/g, "."),
    real_name: realName,
    tz: "America/New_York",
    profile: { real_name: realName, display_name: "", email: `${id.toLowerCase()}@example.invalid`, image_512: "https://example.invalid/x.png", status_text: "" },
    ...extra,
  };
}

/** Three pages, deactivated accounts and bots first, the way Slack orders a large workspace. */
const PAGES = [
  [person("USLACKBOT", "Slackbot"), person("U1", "Old Member", { deleted: true }), person("U2", "Drive Bot", { is_bot: true })],
  [person("U3", "Amy Perez"), person("U4", "Gone Again", { deleted: true })],
  [person("U5", "Ségun Olujide"), person("U6", "David Walker")],
];

function stubDirectory(sent: Sent[], failPage?: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = String(input).split("/").pop() ?? "";
      const form = new URLSearchParams(String(init?.body ?? ""));
      sent.push({ method, form });
      const page = form.get("cursor") === null ? 0 : Number(form.get("cursor")?.replace("page-", ""));
      if (page === failPage) return Response.json({ ok: false, error: "ratelimited" });
      if (method === "users.list") {
        const next = page + 1 < PAGES.length ? `page-${page + 1}` : "";
        return Response.json({ ok: true, members: PAGES[page], response_metadata: { next_cursor: next } });
      }
      if (method === "conversations.list") {
        return Response.json({
          ok: true,
          channels: [
            { id: "C1", name: "general", is_member: true, num_members: 40, topic: { value: "Everything" }, purpose: { value: "" } },
            { id: "C2", name: "old-project", is_archived: true },
          ],
          response_metadata: { next_cursor: "" },
        });
      }
      return Response.json({ ok: true, user: { id: "U3" } });
    }),
  );
}

describe("users.list", () => {
  test("every page is read in one call, and only active people come back, trimmed", async () => {
    const sent: Sent[] = [];
    stubDirectory(sent);
    const { body } = await slackCallShaped("xoxp-fake", "users.list", {});
    expect(sent.map((s) => s.form.get("cursor"))).toEqual([null, "page-1", "page-2"]);
    expect(sent.every((s) => s.form.get("limit") === "200")).toBe(true);
    expect(body).toMatchObject({ ok: true, count: 3 });
    const members = (body as { members: Array<Record<string, unknown>> }).members;
    expect(members.map((m) => m.id)).toEqual(["U3", "U5", "U6"]);
    expect(members[0]).toEqual({ id: "U3", name: "amy.perez", real_name: "Amy Perez", email: "u3@example.invalid", tz: "America/New_York" });
    expect(JSON.stringify(body)).not.toContain("image_512");
  });

  test("match finds one person by any word of their name or email, accents aside, and never reaches Slack", async () => {
    const sent: Sent[] = [];
    stubDirectory(sent);
    const { body } = await slackCallShaped("xoxp-fake", "users.list", { match: "segun" });
    expect((body as { members: Array<{ id: string }> }).members.map((m) => m.id)).toEqual(["U5"]);
    expect(sent.some((s) => s.form.has("match") || s.form.has("include_inactive"))).toBe(false);
    const byEmail = await slackCallShaped("xoxp-fake", "users.list", { match: "u6@example" });
    expect((byEmail.body as { members: Array<{ id: string }> }).members.map((m) => m.id)).toEqual(["U6"]);
  });

  test("include_inactive returns deactivated people and bots too", async () => {
    stubDirectory([]);
    const { body } = await slackCallShaped("xoxp-fake", "users.list", { include_inactive: "true" });
    expect((body as { members: unknown[] }).members).toHaveLength(7);
    expect(body).not.toHaveProperty("only");
  });

  test("a limit stops at a page's end and gives its cursor, or cuts a page and says to narrow", async () => {
    stubDirectory([]);
    const atPageEnd = await slackCallShaped("xoxp-fake", "users.list", { limit: 1 });
    expect(atPageEnd.body).toMatchObject({ count: 1, more: "pass cursor page-2 for the rest" });
    const cut = await slackCallShaped("xoxp-fake", "users.list", { limit: 1, include_inactive: "true" });
    expect(cut.body).toMatchObject({ count: 1, more: expect.stringContaining("match") });
  });

  test("a first page Slack refuses is Slack's answer as it stands; a later one returns what was read", async () => {
    stubDirectory([], 0);
    expect((await slackCallShaped("xoxp-fake", "users.list", {})).body).toEqual({ ok: false, error: "ratelimited" });
    stubDirectory([], 2);
    const { body } = await slackCallShaped("xoxp-fake", "users.list", {});
    expect(body).toMatchObject({ ok: true, count: 1, stopped: expect.stringContaining("ratelimited") });
  });
});

describe("conversations.list and the rest", () => {
  test("archived channels are asked away from Slack and filtered, and each is trimmed", async () => {
    const sent: Sent[] = [];
    stubDirectory(sent);
    const { body } = await slackCallShaped("xoxp-fake", "conversations.list", { types: "public_channel" });
    expect(sent[0].form.get("exclude_archived")).toBe("true");
    expect(sent[0].form.get("types")).toBe("public_channel");
    expect((body as { channels: unknown[] }).channels).toEqual([{ id: "C1", name: "general", is_member: true, num_members: 40, topic: "Everything" }]);
  });

  test("any other method is passed through untouched", async () => {
    const sent: Sent[] = [];
    stubDirectory(sent);
    const answer = await slackCallShaped("xoxp-fake", "users.info", { user: "U3", match: "kept" });
    expect(answer.body).toEqual({ ok: true, user: { id: "U3" } });
    expect(sent[0].form.get("match")).toBe("kept");
  });
});

describe("a post addressed to a person", () => {
  function stubPosting(sent: Sent[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = String(input).split("/").pop() ?? "";
        const form = new URLSearchParams(String(init?.body ?? ""));
        sent.push({ method, form });
        if (method === "users.lookupByEmail") {
          return form.get("email") === "olu@example.invalid" ? Response.json({ ok: true, user: { id: "U5" } }) : Response.json({ ok: false, error: "users_not_found" });
        }
        if (method === "conversations.open") return Response.json({ ok: true, channel: { id: `D-${form.get("users")}` } });
        return Response.json({ ok: true, channel: form.get("channel"), ts: "1.2" });
      }),
    );
  }

  test("by the email they use in Slack, goes to the DM with them", async () => {
    const sent: Sent[] = [];
    stubPosting(sent);
    const { body } = await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "olu@example.invalid", text: "hi" });
    expect(sent.map((s) => s.method)).toEqual(["users.lookupByEmail", "conversations.open", "chat.postMessage"]);
    expect(sent[2].form.get("channel")).toBe("D-U5");
    expect(sent[2].form.get("text")).toBe("hi");
    expect(body).toMatchObject({ ok: true, channel: "D-U5" });
  });

  test("by user id, opens the DM; an email nobody there uses posts nothing", async () => {
    const sent: Sent[] = [];
    stubPosting(sent);
    await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "U05ABC", text: "hi" });
    expect(sent.map((s) => [s.method, s.form.get("channel") ?? s.form.get("users")])).toEqual([
      ["conversations.open", "U05ABC"],
      ["chat.postMessage", "D-U05ABC"],
    ]);
    sent.length = 0;
    const { body } = await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "nobody@example.invalid", text: "hi" });
    expect(body).toEqual({ ok: false, error: "users_not_found" });
    expect(sent.map((s) => s.method)).toEqual(["users.lookupByEmail"]);
  });

  test("a channel id is posted to as given", async () => {
    const sent: Sent[] = [];
    stubPosting(sent);
    await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "C1", text: "hi" });
    expect(sent.map((s) => [s.method, s.form.get("channel")])).toEqual([["chat.postMessage", "C1"]]);
  });
});

describe("reading a channel, a thread and a search", () => {
  function stubMessages(sent: Sent[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = String(input).split("/").pop() ?? "";
        const form = new URLSearchParams(String(init?.body ?? ""));
        sent.push({ method, form });
        if (method === "conversations.list") {
          return Response.json({ ok: true, channels: [{ id: "C9", name: "General" }], response_metadata: { next_cursor: "" } });
        }
        if (method === "users.info") {
          const names: Record<string, string> = { U05ABC: "Segun", U06DEF: "Amy" };
          const id = form.get("user") ?? "";
          return names[id] ? Response.json({ ok: true, user: { id, profile: { display_name: names[id] } } }) : Response.json({ ok: false, error: "user_not_found" });
        }
        if (method === "conversations.history" || method === "conversations.replies") {
          return Response.json({
            ok: true,
            has_more: true,
            response_metadata: { next_cursor: "older" },
            messages: [
              {
                ts: "2.0",
                user: "U05ABC",
                text: "Hey <@U06DEF>, see this",
                thread_ts: "2.0",
                reply_count: 3,
                reactions: [{ name: "eyes", count: 2 }],
                blocks: [{ type: "rich_text", elements: ["x".repeat(500)] }],
                user_profile: { image_72: "https://example.invalid/a.png" },
              },
              { ts: "2.5", user: "U06DEF", text: "Done", thread_ts: "2.0", files: [{ name: "plan.pdf" }] },
            ],
          });
        }
        if (method === "search.messages") {
          return Response.json({
            ok: true,
            messages: { total: 1, matches: [{ channel: { id: "C9", name: "general" }, username: "segun", user: "U05ABC", ts: "2.0", text: "ship it <@U06DEF>", permalink: "https://example.invalid/p", blocks: [] }] },
          });
        }
        return Response.json({ ok: true, channel: form.get("channel"), ts: "3.0" });
      }),
    );
  }

  test("a channel named as #name is found by name, and its messages come back short and named", async () => {
    const sent: Sent[] = [];
    stubMessages(sent);
    const { body } = await slackCallShaped("xoxp-fake", "conversations.history", { channel: "#general" });
    expect(sent.find((s) => s.method === "conversations.history")?.form.get("channel")).toBe("C9");
    expect(sent.find((s) => s.method === "conversations.history")?.form.get("limit")).toBe("50");
    expect(body).toMatchObject({ ok: true, count: 2, order: "newest first", more: "pass cursor older for older messages" });
    const [first, second] = (body as { messages: Array<Record<string, unknown>> }).messages;
    expect(first).toEqual({ ts: "2.0", from: "Segun", user: "U05ABC", text: "Hey @Amy, see this", reply_count: 3, reactions: "eyes×2" });
    expect(second).toEqual({ ts: "2.5", from: "Amy", user: "U06DEF", text: "Done", thread_ts: "2.0", files: ["plan.pdf"] });
    expect(JSON.stringify(body)).not.toContain("rich_text");
  });

  test("a thread reads oldest first; a channel no one has is refused before Slack is asked for messages", async () => {
    const sent: Sent[] = [];
    stubMessages(sent);
    expect((await slackCallShaped("xoxp-fake", "conversations.replies", { channel: "C9", ts: "2.0" })).body).toMatchObject({ order: "oldest first" });
    sent.length = 0;
    const missing = await slackCallShaped("xoxp-fake", "conversations.history", { channel: "#nowhere" });
    expect(missing.body).toMatchObject({ ok: false, error: "channel_not_found" });
    expect(sent.map((s) => s.method)).toEqual(["conversations.list"]);
  });

  test("a reply in a thread posts to the channel by name, with its thread", async () => {
    const sent: Sent[] = [];
    stubMessages(sent);
    await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "#general", thread_ts: "2.0", text: "On it" });
    const post = sent.find((s) => s.method === "chat.postMessage");
    expect([post?.form.get("channel"), post?.form.get("thread_ts"), post?.form.get("text")]).toEqual(["C9", "2.0", "On it"]);
  });

  test("a search hit says its channel, author, words and link", async () => {
    stubMessages([]);
    const { body } = await slackCallShaped("xoxp-fake", "search.messages", { query: "ship" });
    expect(body).toEqual({
      ok: true,
      total: 1,
      matches: [{ channel: "#general", channel_id: "C9", from: "segun", user: "U05ABC", ts: "2.0", text: "ship it @Amy", permalink: "https://example.invalid/p" }],
    });
  });
});

/**
 * `#name` names one channel, and a destination is resolved exactly.
 *
 * `fold` is a *search* helper — "Ségun is found by segun" — and resolving a
 * `#name` with it made two different channels the same word. Slack channel
 * names may hold any script, so anyone in that Slack can make a channel whose
 * folded name equals another's, and `find` took whichever Slack listed first:
 * a post the person said yes to for `#general` could be delivered somewhere
 * else, and a read of `#general` could come back with that channel instead.
 */
describe("a channel named as #name resolves to exactly one channel", () => {
  function stubChannels(sent: Sent[], channels: Array<{ id: string; name: string }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = String(input).split("/").pop() ?? "";
        const form = new URLSearchParams(String(init?.body ?? ""));
        sent.push({ method, form });
        if (method === "conversations.list") return Response.json({ ok: true, channels, response_metadata: { next_cursor: "" } });
        return Response.json({ ok: true, channel: form.get("channel"), ts: "3.0" });
      }),
    );
  }

  test("a lookalike listed first never takes the name of the channel that holds it exactly", async () => {
    const sent: Sent[] = [];
    stubChannels(sent, [
      { id: "C7", name: "générâl" },
      { id: "C9", name: "general" },
    ]);
    await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "#general", text: "the quarter's numbers" });
    expect(sent.find((s) => s.method === "chat.postMessage")?.form.get("channel")).toBe("C9");
  });

  test("two channels that fold alike are refused rather than guessed between", async () => {
    const sent: Sent[] = [];
    stubChannels(sent, [
      { id: "C7", name: "générâl" },
      { id: "C8", name: "generâl" },
    ]);
    const answer = await slackCallShaped("xoxp-fake", "chat.postMessage", { channel: "#general", text: "the quarter's numbers" });
    expect(answer.body).toMatchObject({ ok: false, error: "channel_ambiguous" });
    expect(sent.some((s) => s.method === "chat.postMessage")).toBe(false);
  });

  test("a read of #name is resolved the same way, so it never returns another channel's messages", async () => {
    const sent: Sent[] = [];
    stubChannels(sent, [
      { id: "C7", name: "ｇｅｎｅｒａｌ" },
      { id: "C9", name: "general" },
    ]);
    await slackCallShaped("xoxp-fake", "conversations.history", { channel: "#general" });
    expect(sent.find((s) => s.method === "conversations.history")?.form.get("channel")).toBe("C9");
  });
});
