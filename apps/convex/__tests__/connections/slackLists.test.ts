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
