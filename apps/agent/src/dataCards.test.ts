/**
 * The cards Tex offers on the person's own data (`dataCards.ts`): an answer's
 * `offers` become a times or inbox card after its words, only where cards go.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `withDataCards` ignoring `cardsOn` → "go only to a chat that has shown the app" fails.
 *   `readOffers` passing any string → "take only the two kinds, once each" fails.
 */

import { describe, expect, it } from "vitest";

import { appCardConfig } from "./appCards";
import type { Fetch } from "./clients";
import { dataCard, readOffers, withDataCards } from "./dataCards";
import { accept, drain, type InboxDeps } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { sendblueChatId } from "./sendblue";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const ENV = { APP_CARD_EXTENSION_ID: "lc.context.mobile.messages", APPLE_TEAM_ID: "T".repeat(10) };
const APP_ONLY = appCardConfig({ ...ENV, APP_CARDS: "app" })!;

describe("an offered data card", () => {
  it("take only the two kinds, once each", () => {
    expect(readOffers(["times", "inbox", "times", "pick", 3, null])).toEqual(["times", "inbox"]);
    expect(readOffers("times")).toEqual([]);
    expect(readOffers(undefined)).toEqual([]);
  });

  it("opens Tex's own card address, with words that stand without the app", () => {
    expect(dataCard("times", APP_ONLY)).toMatchObject({ url: "https://context.lc/tex/times", interactive: false, layout: { caption: "Pick times that work" } });
    expect(dataCard("inbox", APP_ONLY)).toMatchObject({ url: "https://context.lc/tex/inbox", fallbackText: "Hand Tex some email" });
  });

  it("go only to a chat that has shown the app, after the words", () => {
    expect(withDataCards(["When works?"], ["times"], APP_ONLY)).toEqual(["When works?"]);
    const here = withDataCards(["When works?"], ["times"], { ...APP_ONLY, here: true });
    expect(here).toHaveLength(2);
    expect(here[0]).toBe("When works?");
    expect(withDataCards(["When works?"], [], { ...APP_ONLY, here: true })).toEqual(["When works?"]);
  });

  it("follows the answer that offered it, once the chat has the app", async () => {
    type Call = { path: string; body: Record<string, unknown> };
    const calls: Call[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = init.body === undefined ? {} : JSON.parse(String(init.body));
      if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (parsed.pathname === "/agent") return Response.json({ answer: "When are you free this week?", offers: ["times", "bogus"] });
      calls.push({ path: parsed.pathname, body });
      return new Response('{"status":"QUEUED","message_handle":"mh_out"}');
    }) as unknown as Fetch;
    const deps: InboxDeps = { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "", sendblue: { keyId: "kid", secret: "ksecret" }, appCard: APP_ONLY, now: () => 1_000 };
    const storage = new MemoryStorage();
    const typed = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: sendblueChatId(LINE, PHONE), from: PHONE, messageId: eventId, text });
    const cards = () => calls.filter((call) => call.body.app_card !== undefined).map((call) => (call.body.app_card as { url: string }).url);

    await accept(storage, typed("sendblue:mh_1", "lunch with Ana next week?"), 1_000);
    await drain(storage, deps);
    expect(cards()).toEqual([]);

    await storage.put("cards:app", 1_000);
    await accept(storage, typed("sendblue:mh_2", "lunch with Ana next week?"), 1_000);
    await drain(storage, deps);
    expect(cards()).toEqual(["https://context.lc/tex/times"]);
  });
});
