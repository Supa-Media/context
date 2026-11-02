import { describe, expect, it, vi } from "vitest";

import { groupLineFor } from "./groupLine";
import { lineFor } from "./line";
import { linkAfterCard, noteCardDrawer } from "./noteCards";
import { sendblueChatId } from "./sendblue";
import { whapiChatId, whapiGroupId } from "./whapi";
import type { Fetch } from "./clients";
import type { NoteLink } from "./appCards";

const LINE = "+18135550100";
const PHONE = "+14155550123";
const KEYS = { keyId: "k", secret: "s" };
const LINK = "https://context.lc/note/@dev2/1-projects/tex/launch-plan.md";
const PNG = { name: "note.png", mediaType: "image/png", data: "iVBORw0KGgo=" };
const chatId = sendblueChatId(LINE, PHONE);

type Call = { path: string; body: Record<string, unknown> };
function sendblue(calls: Call[], mediaStatus = 200): Fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ path: new URL(url).pathname, body });
    return new Response('{"status":"QUEUED","message_handle":"mh_1"}', { status: body.media_url ? mediaStatus : 200 });
  }) as unknown as Fetch;
}

describe("a note link texted with its picture", () => {
  it("sends the note's card, then the link inside a sentence, both threaded", async () => {
    const calls: Call[] = [];
    const drawn: NoteLink[] = [];
    const line = lineFor(
      {
        fetch: sendblue(calls),
        linqApiKey: "",
        sendblue: KEYS,
        hostPicture: async () => "https://agent.example/media/abc.png",
        noteCardPicture: async (link) => (drawn.push(link), PNG),
      },
      chatId,
    );
    expect(await line.sendText(chatId, LINK, "k", "mh_0")).toBe("mh_1");
    expect(drawn).toEqual([{ url: LINK, slug: "dev2", folder: "1-projects/tex", caption: "Launch plan" }]);
    expect(calls.map((call) => call.body.media_url ?? call.body.content)).toEqual([
      "https://agent.example/media/abc.png",
      `Open it in Context: ${LINK} (tap the link)`,
    ]);
    expect(calls.every((call) => (call.body.reply_to as { message_handle?: string })?.message_handle === "mh_0")).toBe(true);
  });

  it("keeps the link off either end of its text, where Messages would draw a box to load", () => {
    const text = linkAfterCard({ url: LINK, slug: "dev2", folder: "", caption: "Plan" });
    expect(text.startsWith(LINK)).toBe(false);
    expect(text.trimEnd().endsWith(LINK)).toBe(false);
    expect(text).toContain(` ${LINK} `);
  });

  it("sends the link alone when no card is drawn, hosting fails, or the line refuses the picture", async () => {
    for (const deps of [
      { noteCardPicture: async () => null, hostPicture: async () => "https://agent.example/m.png" },
      { noteCardPicture: async () => PNG, hostPicture: async () => Promise.reject(new Error("no origin")) },
    ]) {
      const calls: Call[] = [];
      await lineFor({ fetch: sendblue(calls), linqApiKey: "", sendblue: KEYS, ...deps }, chatId).sendText(chatId, LINK, "k");
      expect(calls.map((call) => call.body.content)).toEqual([LINK]);
    }
    const calls: Call[] = [];
    const refused = { noteCardPicture: async () => PNG, hostPicture: async () => "https://agent.example/m.png" };
    await lineFor({ fetch: sendblue(calls, 400), linqApiKey: "", sendblue: KEYS, ...refused }, chatId).sendText(chatId, LINK, "k");
    expect(calls.map((call) => call.body.content ?? "picture")).toEqual(["picture", LINK]);
  });

  it("never draws for words, a web page, or a link inside a sentence", async () => {
    const draw = vi.fn(async () => PNG);
    const calls: Call[] = [];
    const line = lineFor({ fetch: sendblue(calls), linqApiKey: "", sendblue: KEYS, hostPicture: async () => "x", noteCardPicture: draw }, chatId);
    for (const text of ["Saved it.", "https://example.com/page", `Here: ${LINK}`]) await line.sendText(chatId, text, "k");
    expect(draw).not.toHaveBeenCalled();
    expect(calls).toHaveLength(3);
  });
});

describe("drawing the card", () => {
  const link: NoteLink = { url: LINK, slug: "dev2", folder: "1-projects/tex", caption: "Launch plan" };

  it("asks the control plane with the texting Worker's secret, for the name and workspace only", async () => {
    const fetcher = vi.fn(async () => Response.json({ png: "iVBOR" }));
    const picture = await noteCardDrawer(fetcher as unknown as Fetch, "https://cp.example", "secret")(link);
    expect(picture).toEqual({ name: "note.png", mediaType: "image/png", data: "iVBOR" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cp.example/agent-texts/note-card");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body))).toEqual({ title: "Launch plan", slug: "dev2" });
  });

  it("is null, never a throw, on a refusal, a bad body or a dead network", async () => {
    const answers = [
      async () => Response.json({ error: "not_drawn" }, { status: 404 }),
      async () => Response.json({ png: 7 }),
      async () => new Response("not json"),
      async () => {
        throw new Error("down");
      },
    ];
    for (const answer of answers) {
      expect(await noteCardDrawer(answer as unknown as Fetch, "https://cp.example", "s")(link)).toBeNull();
    }
  });
});

describe("a note link texted into a group", () => {
  const place = { line: LINE, groupId: "group-1" };

  it("sends the card, then the link inside a sentence, as in a 1:1 chat", async () => {
    const calls: Call[] = [];
    const deps = { fetch: sendblue(calls), sendblue: KEYS, hostPicture: async () => "https://agent.example/media/abc.png", noteCardPicture: async () => PNG };
    expect(await groupLineFor(deps, "group-1").sendText(place, LINK, "mh_0")).toBe("mh_1");
    expect(calls.map((call) => call.path)).toEqual(["/api/send-group-message", "/api/send-group-message"]);
    expect(calls.map((call) => call.body.media_url ?? call.body.content)).toEqual(["https://agent.example/media/abc.png", linkAfterCard({ url: LINK, slug: "dev2", folder: "", caption: "" })]);
    expect(calls.every((call) => call.body.group_id === "group-1")).toBe(true);
  });

  it("sends the link alone when there is no card, and words as they are", async () => {
    const calls: Call[] = [];
    await groupLineFor({ fetch: sendblue(calls), sendblue: KEYS, hostPicture: async () => "x", noteCardPicture: async () => null }, "group-1").sendText(place, LINK);
    const refused: Call[] = [];
    await groupLineFor({ fetch: sendblue(refused, 400), sendblue: KEYS, hostPicture: async () => "x", noteCardPicture: async () => PNG }, "group-1").sendText(place, LINK);
    const words: Call[] = [];
    const draw = vi.fn(async () => PNG);
    await groupLineFor({ fetch: sendblue(words), sendblue: KEYS, hostPicture: async () => "x", noteCardPicture: draw }, "group-1").sendText(place, "Saved it.");
    expect(calls.map((call) => call.body.content)).toEqual([LINK]);
    expect(refused.map((call) => call.body.content ?? "picture")).toEqual(["picture", LINK]);
    expect(draw).not.toHaveBeenCalled();
  });
});

describe("a note link texted on WhatsApp", () => {
  const WHAPI = { token: "wt", line: LINE };
  type WhapiCall = { path: string; body: Record<string, unknown> };
  function whapi(calls: WhapiCall[], previewStatus = 200): Fetch {
    return (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(String(init.body)) });
      const status = path === "/messages/link_preview" ? previewStatus : 200;
      return new Response(status === 200 ? '{"sent":true,"message":{"id":"wamid-1"}}' : null, { status });
    }) as unknown as Fetch;
  }
  const hostPicture = async () => "https://agent.example/media/abc.png";

  it("sends the link with the note's name and card as its preview, in a 1:1 chat and a group", async () => {
    const chat = whapiChatId(LINE, PHONE);
    const calls: WhapiCall[] = [];
    const line = lineFor({ fetch: whapi(calls), linqApiKey: "", whapi: WHAPI, hostPicture, noteCardPicture: async () => PNG }, chat);
    expect(await line.sendText(chat, LINK, "k", "wamid-0")).toBe("wamid-1");
    const group = whapiGroupId("120363012345678901@g.us");
    await groupLineFor({ fetch: whapi(calls), whapi: WHAPI, hostPicture, noteCardPicture: async () => PNG }, group).sendText({ line: LINE, groupId: group }, LINK);
    expect(calls.map((c) => c.path)).toEqual(["/messages/link_preview", "/messages/link_preview"]);
    expect(calls[0].body).toMatchObject({ body: LINK, title: "Launch plan", description: "A note in @dev2 · open it in Context", canonical: LINK, media: "https://agent.example/media/abc.png", quoted: "wamid-0" });
    expect(calls[1].body).toMatchObject({ to: "120363012345678901@g.us", title: "Launch plan" });
  });

  it("still names the note with no card, and sends the link plain when Whapi refuses the preview", async () => {
    const chat = whapiChatId(LINE, PHONE);
    const calls: WhapiCall[] = [];
    await lineFor({ fetch: whapi(calls), linqApiKey: "", whapi: WHAPI, hostPicture, noteCardPicture: async () => null }, chat).sendText(chat, LINK, "k");
    expect(calls[0]).toMatchObject({ path: "/messages/link_preview", body: { title: "Launch plan" } });
    expect("media" in calls[0].body).toBe(false);
    const refused: WhapiCall[] = [];
    await lineFor({ fetch: whapi(refused, 400), linqApiKey: "", whapi: WHAPI, hostPicture, noteCardPicture: async () => PNG }, chat).sendText(chat, LINK, "k");
    expect(refused.map((c) => c.path)).toEqual(["/messages/link_preview", "/messages/link_preview", "/messages/text"]);
    expect(refused[2].body.body).toBe(LINK);
  });

  it("sends words and other links as text", async () => {
    const chat = whapiChatId(LINE, PHONE);
    const calls: WhapiCall[] = [];
    const line = lineFor({ fetch: whapi(calls), linqApiKey: "", whapi: WHAPI, hostPicture, noteCardPicture: async () => PNG }, chat);
    for (const text of ["Saved it.", "https://example.com/page", `Here: ${LINK}`]) await line.sendText(chat, text, "k");
    expect(calls.map((c) => c.path)).toEqual(["/messages/text", "/messages/text", "/messages/text"]);
  });
});
