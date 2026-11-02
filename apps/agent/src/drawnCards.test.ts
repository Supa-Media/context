/**
 * A card Tex drew goes as a Context card where cards go (`sendParts.ts`):
 * the drawing is the card's picture and its title the caption, and the photo
 * goes instead when the line refuses the card.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `withDrawnCards` ignoring `cardsOn` → "stays a photo while cards are off" fails.
 *   `sendCardPart` dropping the fallback → "sends the photo when the line refuses the card" fails.
 *   `readPictures` dropping `title` → "keeps a drawn card's title, cleaned" fails.
 *   `drawnCard` leaving out `p` → "names where the drawing is kept" fails.
 */

import { describe, expect, it } from "vitest";

import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import { readPictures, type SendPart } from "./outgoing";
import type { Message } from "./reply";
import { sendblueChatId } from "./sendblue";
import { drawnCard, pictureKey, withDrawnCards } from "./sendParts";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };
const CONFIG = { extensionBundleId: "lc.context.mobile.messages", teamId: "T".repeat(10) };

describe("a drawn card's title from the gateway", () => {
  it("keeps a drawn card's title, cleaned and cut short; a picture without one has none", () => {
    const [titled, plain] = readPictures([
      { name: "p1.png", mediaType: "image/png", data: btoa("png"), title: "  Team\nlunch  " },
      { name: "p2.png", mediaType: "image/png", data: btoa("png"), title: 42 },
    ]);
    expect(titled).toEqual({ name: "p1.png", mediaType: "image/png", data: btoa("png"), title: "Team lunch" });
    expect(plain).toEqual({ name: "p2.png", mediaType: "image/png", data: btoa("png") });
    expect((readPictures([{ name: "p.png", mediaType: "image/png", data: btoa("png"), title: "x".repeat(300) }])[0] as { title: string }).title).toHaveLength(100);
  });
});

describe("withDrawnCards", () => {
  const media = { url: "https://agent.example/media/1.png" };

  it("turns a titled drawing into a Context card showing it, with the photo kept for a refusal", () => {
    const parts = withDrawnCards(["Here it is.", { media, title: "Team lunch" }], CONFIG);
    expect(parts[0]).toBe("Here it is.");
    expect(parts[1]).toEqual({ card: drawnCard("Team lunch", media.url, CONFIG), fallback: media });
    expect(drawnCard("Team lunch", media.url, CONFIG)).toMatchObject({
      appName: "Context",
      ...CONFIG,
      url: "https://context.lc/tex/card?t=Team%20lunch",
      interactive: false,
      layout: { caption: "Team lunch", imageUrl: media.url, summary: "Team lunch" },
    });
  });

  it("names where the drawing is kept, so the opened card shows it again, and nothing for any other address", () => {
    const kept = `https://agent.example/media/${"a".repeat(64)}/${"b".repeat(64)}.png`;
    expect(drawnCard("Team lunch", kept, CONFIG).url).toBe(`https://context.lc/tex/card?t=Team%20lunch&p=${"a".repeat(64)}.${"b".repeat(64)}.png`);
    expect(pictureKey(kept)).toBe(`${"a".repeat(64)}.${"b".repeat(64)}.png`);
    for (const other of ["https://agent.example/media/1.png", `https://agent.example/media/${"a".repeat(64)}/${"b".repeat(64)}.vcf`, `https://agent.example/x/${"a".repeat(64)}/${"b".repeat(64)}.png`, "not a url"]) {
      expect(pictureKey(other)).toBeNull();
    }
  });

  it("stays a photo while cards are off, for a picture with no title, and for one uploaded rather than addressed", () => {
    const parts: SendPart[] = [{ media, title: "Team lunch" }];
    expect(withDrawnCards(parts, null)).toEqual(parts);
    expect(withDrawnCards(parts, { ...CONFIG, onlyWhereApp: true })).toEqual(parts);
    expect(withDrawnCards([{ media }], CONFIG)).toEqual([{ media }]);
    expect(withDrawnCards([{ media: { attachment_id: "a" }, title: "x" }], CONFIG)).toEqual([{ media: { attachment_id: "a" }, title: "x" }]);
  });
});

describe("an answer with a drawn card", () => {
  type Call = { path: string; body: Record<string, unknown> };
  const message = (eventId: string): Message => ({ kind: "message", eventId, chatId: sendblueChatId(LINE, PHONE), from: PHONE, messageId: eventId, text: "show me a card" });

  function fake(calls: Call[], cardStatus = 202): Fetch {
    return (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = init.body === undefined ? {} : JSON.parse(String(init.body));
      if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (parsed.pathname === "/agent") return Response.json({ answer: "Here's the card.", pictures: [{ name: "p1.png", mediaType: "image/png", data: btoa("png"), title: "Team lunch" }] });
      calls.push({ path: parsed.pathname, body });
      return new Response('{"status":"QUEUED","message_handle":"mh_out"}', { status: body.app_card ? cardStatus : 200 });
    }) as unknown as Fetch;
  }

  let hosted: (string | undefined)[] = [];
  function deps(fetcher: Fetch): InboxDeps {
    hosted = [];
    return {
      fetch: fetcher,
      controlPlaneOrigin: "https://cp.example",
      workerSecret: "s",
      gatewayOrigin: "https://gw.example",
      linqApiKey: "linq-key",
      sendblue: KEYS,
      appCard: CONFIG,
      hostPicture: async (picture) => (hosted.push(picture.title), picture.mediaType === "text/vcard" ? "https://agent.example/media/card.vcf" : "https://agent.example/media/1.png"),
      now: () => 1_000,
    };
  }

  const pictures = (calls: Call[]) => calls.filter((call) => String(call.body.media_url ?? "").endsWith(".png"));
  const cards = (calls: Call[]) => calls.filter((call) => call.body.app_card !== undefined);

  it("sends the words, then the drawing as a Context card, and not as a bare photo", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_d1"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls)));
    expect(cards(calls)).toHaveLength(1);
    expect(cards(calls)[0].body).toMatchObject({ app_card: { url: "https://context.lc/tex/card?t=Team%20lunch", layout: { caption: "Team lunch", imageUrl: "https://agent.example/media/1.png" } } });
    expect(pictures(calls)).toHaveLength(0);
    expect((await storage.list({ prefix: "pending:" })).size).toBe(0);
    // The title goes with the bytes, so the drawing is kept as long as a card's (`media.ts` `CARD_FOR_MS`).
    expect(hosted[0]).toBe("Team lunch");
  });

  it("sends the photo when the line refuses the card, so the drawing always arrives", async () => {
    const storage = new MemoryStorage();
    await accept(storage, message("sendblue:mh_d2"), 1_000);
    const calls: Call[] = [];
    await drain(storage, deps(fake(calls, 403)));
    expect(cards(calls)).toHaveLength(1);
    expect(pictures(calls)).toHaveLength(1);
    expect(calls.indexOf(pictures(calls)[0])).toBeGreaterThan(calls.indexOf(cards(calls)[0]));
    expect((await storage.list({ prefix: "pending:" })).size).toBe(0);
  });
});
