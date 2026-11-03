import { describe, expect, it, vi } from "vitest";

import { groupLineFor } from "./groupLine";
import { lineFor } from "./line";
import { linksIn, linkPictureFinder, MAX_LINK_PICTURES, sendWithLinkPictures, tappable } from "./linkPreviews";
import { sendblueChatId } from "./sendblue";
import type { Fetch } from "./clients";

const KEYS = { keyId: "k", secret: "s" };
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PAGE = '<html><head><meta property="og:image" content="/share.png"></head><body>hi</body></html>';

describe("which links a text carries", () => {
  it("drops the sentence's punctuation and a bracket the link did not open, once each, in order", () => {
    expect(linksIn("See https://a.example/x. Also (https://b.example/y) and https://a.example/x!")).toEqual(["https://a.example/x", "https://b.example/y"]);
    expect(linksIn("https://en.example/wiki/Foo_(bar)")).toEqual(["https://en.example/wiki/Foo_(bar)"]);
    expect(linksIn("Nothing here.")).toEqual([]);
  });

  it("stops at the most pictures one text sends", () => {
    const text = Array.from({ length: 6 }, (_, i) => `https://s${i}.example/`).join(" and ");
    expect(linksIn(text)).toHaveLength(MAX_LINK_PICTURES);
  });
});

describe("keeping a link tappable", () => {
  it("never leaves a link at either end of its text", () => {
    expect(tappable("What I'm working on, live: https://context.lc/messages/threads?k=a.b")).toBe(
      "What I'm working on, live: https://context.lc/messages/threads?k=a.b.",
    );
    expect(tappable("https://www.reddit.com/r/x/")).toBe("Link: https://www.reddit.com/r/x/.");
    expect(tappable("Read https://a.example/x.")).toBe("Read https://a.example/x.");
    expect(tappable("https://a.example/x has it")).toBe("Link: https://a.example/x has it");
  });

  it("leaves words, and a link with words on both sides, as they are", () => {
    for (const text of ["Saved it.", "Read https://a.example/x first, then reply.", ""]) expect(tappable(text)).toBe(text);
  });
});

describe("sending a text's link pictures", () => {
  it("sends each link's picture first, then the words, and a picture that fails never holds the words", async () => {
    const sent: string[] = [];
    const find = vi.fn(async (link: string) => (link.includes("none") ? null : `https://host.example/${new URL(link).hostname}.png`));
    const answer = await sendWithLinkPictures(
      "Try https://a.example/1, https://none.example/2 and https://b.example/3",
      find,
      async (address) => {
        if (address.includes("a.example")) throw new Error("refused");
        sent.push(address);
      },
      async (words) => (sent.push(words), "mh_1"),
    );
    expect(answer).toBe("mh_1");
    expect(sent).toEqual(["https://host.example/b.example.png", "Try https://a.example/1, https://none.example/2 and https://b.example/3."]);
  });

  it("sends words with no link as they are, and never looks for a picture", async () => {
    const find = vi.fn(async () => "x");
    const sent: string[] = [];
    await sendWithLinkPictures("Saved it.", find, async () => {}, async (words) => sent.push(words));
    expect(find).not.toHaveBeenCalled();
    expect(sent).toEqual(["Saved it."]);
  });

  it("finds nothing without a host to serve the picture from", async () => {
    const fetcher = vi.fn();
    expect(await linkPictureFinder(fetcher as unknown as Fetch, undefined, undefined)("https://a.example/")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

type Call = { url: string; body?: Record<string, unknown> };
/** Sendblue plus one web site: the page, then its share picture. */
function world(calls: Call[]): Fetch {
  return (async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.sendblue.com") {
      calls.push({ url: parsed.pathname, body: JSON.parse(String(init.body)) });
      return new Response('{"message_handle":"mh_1"}', { status: 200 });
    }
    calls.push({ url });
    if (parsed.pathname === "/r/post") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (parsed.pathname === "/share.png") return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
    return new Response(null, { status: 404 });
  }) as unknown as Fetch;
}

describe("a web link on a Sendblue line", () => {
  const LINK = "https://forum.example/r/post";
  const hosted: string[] = [];
  const hostPicture = async (picture: { mediaType: string; data: string }) => {
    hosted.push(`${picture.mediaType}:${picture.data}`);
    return "https://agent.example/media/p.png";
  };

  it("goes as the page's picture, then the link kept tappable, in a 1:1 chat", async () => {
    const calls: Call[] = [];
    hosted.length = 0;
    const chatId = sendblueChatId("+18135550100", "+14155550123");
    await lineFor({ fetch: world(calls), linqApiKey: "", sendblue: KEYS, hostPicture }, chatId).sendText(chatId, LINK, "k", "mh_0");
    expect(hosted).toEqual([`image/png:${btoa(String.fromCharCode(...PNG_BYTES))}`]);
    const sends = calls.filter((call) => call.body);
    expect(sends.map((call) => call.body!.media_url ?? call.body!.content)).toEqual(["https://agent.example/media/p.png", `Link: ${LINK}.`]);
    expect(sends.every((call) => (call.body!.reply_to as { message_handle?: string })?.message_handle === "mh_0")).toBe(true);
  });

  it("goes the same way in a group", async () => {
    const calls: Call[] = [];
    await groupLineFor({ fetch: world(calls), sendblue: KEYS, hostPicture }, "group-1").sendText(
      { line: "+18135550100", groupId: "group-1" },
      `Found it: ${LINK}`,
    );
    const sends = calls.filter((call) => call.body);
    expect(sends.map((call) => call.body!.media_url ?? call.body!.content)).toEqual(["https://agent.example/media/p.png", `Found it: ${LINK}.`]);
    expect(sends.every((call) => call.body!.group_id === "group-1")).toBe(true);
  });

  it("still sends the words when the page has no picture or cannot be read", async () => {
    const calls: Call[] = [];
    const chatId = sendblueChatId("+18135550100", "+14155550123");
    await lineFor({ fetch: world(calls), linqApiKey: "", sendblue: KEYS, hostPicture }, chatId).sendText(chatId, "See https://forum.example/gone", "k");
    expect(calls.filter((call) => call.body).map((call) => call.body!.content)).toEqual(["See https://forum.example/gone."]);
  });
});
