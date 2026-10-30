/**
 * Cards for people who have the app (`cardChats.ts`): a card of ours from
 * their phone marks the chat; with `APP_CARDS` "app" only a marked chat gets
 * cards; an ask gets a Yes / Not now card, whose Yes is a yes only for the
 * ask it was sent under.
 *
 * Sabotage record (applied, suite run, named check observed failing, reverted):
 *   `withCardsHere` marking every chat → "sends no card to a chat that has not shown the app" fails.
 *   `settleCard` not checking the ask's key → "an old card's Yes is not a yes" fails.
 *   `cardReply` not checking the extension → "is nothing from another app's card" fails.
 *   `cardReply` taking any `c` on an ask → "is nothing from another app's card" fails.
 *   `cardsOn` ignoring `onlyWhereApp` → "a note link stays a link until the chat has the app" fails.
 */

import { describe, expect, it } from "vitest";

import { appCardConfig, cardsOn } from "./appCards";
import { askCard, askKey, cardReply, HELLO_TEXT, settleCard, STALE_YES, withAskCard, withCardsHere } from "./cardChats";
import type { Fetch } from "./clients";
import { accept, drain, type InboxDeps } from "./inbox";
import { lineFor } from "./line";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { parseSendblueInbound, sendblueChatId } from "./sendblue";
import { keptAsk, rememberAskReply } from "./thumbs";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const KEYS = { keyId: "kid", secret: "ksecret" };
const ENV = { APP_CARD_EXTENSION_ID: "lc.context.mobile.messages", APPLE_TEAM_ID: "T".repeat(10) };
const APP_ONLY = appCardConfig({ ...ENV, APP_CARDS: "app" })!;
const ASK = "Here's the email I'd send:\n\nTo: jo@example.com\nSubject: Thursday\n\nThursday works.\n\nGive it a 👍 and I'll send it.";
const LINK = "https://context.lc/note/@dev2/1-projects/tex/launch-plan.md";

const card = (url: string, extensionBundleId = ENV.APP_CARD_EXTENSION_ID) => ({ extensionBundleId, teamId: ENV.APPLE_TEAM_ID, url, sessionIdentifier: "d4f28f24-49bb-43ce-b82f-d2f1db74ad74", revision: 1 });
const webhook = (handle: string, appCard: unknown) => ({
  content: "",
  is_outbound: false,
  message_handle: handle,
  from_number: PHONE,
  sendblue_number: LINE,
  message_type: "message",
  group_id: "",
  service: "iMessage",
  app_card: appCard,
});
const inbound = (handle: string, appCard: unknown) => parseSendblueInbound(webhook(handle, appCard)) as Message;

describe("the setting", () => {
  it("is on everywhere with \"on\", and only where the app is with \"app\"", () => {
    const everyone = appCardConfig({ ...ENV, APP_CARDS: "on" });
    expect(everyone?.onlyWhereApp).toBeUndefined();
    expect(cardsOn(everyone)).toBe(true);
    expect(APP_ONLY).toMatchObject({ extensionBundleId: ENV.APP_CARD_EXTENSION_ID, onlyWhereApp: true });
    expect(cardsOn(APP_ONLY)).toBe(false);
    expect(cardsOn({ ...APP_ONLY, here: true })).toBe(true);
    expect(cardsOn(null)).toBe(false);
  });

  it("a note link stays a link until the chat has the app", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response('{"status":"QUEUED","message_handle":"mh_1"}');
    }) as unknown as Fetch;
    const chat = sendblueChatId(LINE, PHONE);
    await lineFor({ fetch: fetcher, linqApiKey: "", sendblue: KEYS, appCard: APP_ONLY }, chat).sendText(chat, LINK, "k1");
    expect(calls.some((body) => body.app_card !== undefined)).toBe(false);
    await lineFor({ fetch: fetcher, linqApiKey: "", sendblue: KEYS, appCard: { ...APP_ONLY, here: true } }, chat).sendText(chat, LINK, "k2");
    expect(calls.filter((body) => body.app_card !== undefined)).toHaveLength(1);
  });
});

describe("a card sent back from their phone", () => {
  const ask = `https://context.lc/tex/ask?k=${askKey(ASK)}`;

  it("is their words: a hello, a yes or no to an ask, or a pick", () => {
    expect(cardReply(card("https://context.lc/tex/hello"))).toEqual({ text: HELLO_TEXT });
    expect(cardReply(card(`${ask}&c=1`))).toEqual({ text: "yes", ask: askKey(ASK) });
    expect(cardReply(card(`${ask}&c=2`))).toEqual({ text: "no", ask: askKey(ASK) });
    expect(cardReply(card("https://context.lc/tex/pick?o=A&o=B&c=2"))).toEqual({ text: "I pick 2: B" });
  });

  it("is the emails they handed Tex, or the free times they picked, in words", () => {
    expect(cardReply(card("https://context.lc/tex/inbox?m=me%40example.invalid%2F18c0ffee&m=me%40example.invalid%2F18c0ffef&m=me%40example.invalid%2F18c0ffee"))).toEqual({
      text: "Please take care of these emails: email:me@example.invalid/18c0ffee, email:me@example.invalid/18c0ffef",
    });
    expect(cardReply(card("https://context.lc/tex/times?d=30&z=America%2FNew_York&s=2026-10-31T14%3A00%3A00.000Z&s=2026-10-30T17%3A00%3A00.000Z"))).toEqual({
      text: "These times work for me (30 min each): Fri, Oct 30, 1:00 PM; Sat, Oct 31, 10:00 AM (America/New_York)",
    });
    // Anything malformed is dropped; a card naming nothing is not one.
    expect(cardReply(card("https://context.lc/tex/inbox?m=no-at-sign%2F1&m=a%40b.example%2F..%2Fx"))).toBeNull();
    expect(cardReply(card("https://context.lc/tex/times?z=Mars%2FOlympus&d=9999&s=2026-10-30T17%3A00%3A00.000Z"))).toEqual({ text: "These times work for me: Fri, Oct 30, 5:00 PM (UTC)" });
    expect(cardReply(card("https://context.lc/tex/times?s=tomorrow"))).toBeNull();
    expect(cardReply(card("https://context.lc/tex/inbox?m=me%40example.invalid%2F18c0ffee", "com.example.orders.MessagesExtension"))).toBeNull();
  });

  it("is nothing from another app's card, another site, an ask with no answer or key, or a note's card", () => {
    expect(cardReply(card(`${ask}&c=1`, "com.example.orders.MessagesExtension"))).toBeNull();
    expect(cardReply(card(`${ask}&c=1`.replace("context.lc", "context.lc.evil.example")))).toBeNull();
    expect(cardReply(card(`${ask}&c=1`.replace("https:", "http:")))).toBeNull();
    expect(cardReply(card(ask))).toBeNull();
    expect(cardReply(card(`${ask}&c=3`))).toBeNull();
    expect(cardReply(card(`${ask}&c=yes`))).toBeNull();
    expect(cardReply(card("https://context.lc/tex/ask?c=1"))).toBeNull();
    expect(cardReply(card("https://context.lc/tex/ask?k=NOT-A-KEY&c=1"))).toBeNull();
    expect(cardReply(card(LINK))).toBeNull();
    expect(cardReply(null)).toBeNull();
  });

  it("reaches Tex marked as a card, with the ask it answers", () => {
    expect(inbound("mh_h", card("https://context.lc/tex/hello"))).toMatchObject({ kind: "message", text: HELLO_TEXT, viaCard: {} });
    expect(inbound("mh_y", card(`${ask}&c=1`))).toMatchObject({ text: "yes", viaCard: { ask: askKey(ASK) } });
    expect(parseSendblueInbound({ ...webhook("mh_t", undefined), content: "yes" })).not.toHaveProperty("viaCard");
  });
});

describe("arriving", () => {
  const yes = (handle: string, under = ASK) => inbound(handle, card(`https://context.lc/tex/ask?k=${askKey(under)}&c=1`));

  it("a card marks the chat as having the app; a typed text does not", async () => {
    const storage = new MemoryStorage();
    const deps = { appCard: APP_ONLY };
    await settleCard(storage, { ...(parseSendblueInbound({ ...webhook("mh_t", undefined), content: "hi" }) as Message) }, 1_000);
    expect(cardsOn((await withCardsHere(storage, deps)).appCard)).toBe(false);
    await settleCard(storage, inbound("mh_h", card("https://context.lc/tex/hello")), 1_000);
    expect(cardsOn((await withCardsHere(storage, deps)).appCard)).toBe(true);
    expect((await withCardsHere(storage, { appCard: null })).appCard).toBeNull();
  });

  it("an ask's Yes is a yes while that ask is the last one", async () => {
    const storage = new MemoryStorage();
    await rememberAskReply(storage, ["One thing first.", ASK], 1_000);
    expect((await settleCard(storage, yes("mh_y1"), 2_000)).text).toBe("yes");
  });

  it("an old card's Yes is not a yes: a newer ask, no ask, or none kept", async () => {
    const storage = new MemoryStorage();
    expect((await settleCard(storage, yes("mh_y0"), 2_000)).text).toBe(STALE_YES);
    await rememberAskReply(storage, [ASK.replace("Thursday works", "Friday works")], 1_000);
    expect((await settleCard(storage, yes("mh_y2"), 2_000)).text).toBe(STALE_YES);
    await rememberAskReply(storage, ["Sent."], 3_000);
    expect((await settleCard(storage, yes("mh_y3"), 4_000)).text).toBe(STALE_YES);
    // Not now stays a no whatever the ask: saying no is always safe.
    const no = inbound("mh_n", card(`https://context.lc/tex/ask?k=${askKey(ASK)}&c=2`));
    expect((await settleCard(storage, no, 4_000)).text).toBe("no");
  });
});

describe("the ask card", () => {
  it("follows a reply that carries an ask, keyed to it, only where cards go", () => {
    const here = { ...APP_ONLY, here: true as const };
    const parts = withAskCard(["Drafted it.", ASK], ["Drafted it.", ASK], here);
    expect(parts).toHaveLength(3);
    expect(parts[2]).toEqual({ card: askCard(ASK, here) });
    expect(askCard(ASK, here)).toMatchObject({ url: `https://context.lc/tex/ask?k=${askKey(ASK)}`, layout: { caption: "Go ahead?" } });
    expect(withAskCard(["Done."], ["Done."], here)).toEqual(["Done."]);
    expect(withAskCard([ASK], [ASK], APP_ONLY)).toEqual([ASK]);
    expect(withAskCard([ASK], [ASK], null)).toEqual([ASK]);
  });

  it("keys differ for different asks", () => {
    expect(askKey(ASK)).not.toBe(askKey(ASK.replace("Thursday", "Friday")));
    expect(askKey(ASK)).toMatch(/^[a-z0-9]{1,8}$/);
  });
});

describe("a chat that has shown the app", () => {
  type Call = { path: string; body: Record<string, unknown> };
  const typed = (eventId: string, text: string): Message => ({ kind: "message", eventId, chatId: sendblueChatId(LINE, PHONE), from: PHONE, messageId: eventId, text });

  function deps(calls: Call[], questions: unknown[]): InboxDeps {
    const fetcher = (async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const body = init.body === undefined ? {} : JSON.parse(String(init.body));
      if (parsed.pathname === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "t" });
      if (parsed.pathname === "/agent") {
        questions.push(body.question);
        return Response.json({ answer: ASK });
      }
      calls.push({ path: parsed.pathname, body });
      return new Response('{"status":"QUEUED","message_handle":"mh_out"}');
    }) as unknown as Fetch;
    return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "s", gatewayOrigin: "https://gw.example", linqApiKey: "", sendblue: KEYS, appCard: APP_ONLY, now: () => 1_000 };
  }
  const askCards = (calls: Call[]) => calls.filter((call) => String((call.body.app_card as { url?: string } | undefined)?.url ?? "").startsWith("https://context.lc/tex/ask"));

  it("sends no card to a chat that has not shown the app, and an ask card once it has", async () => {
    const storage = new MemoryStorage();
    const calls: Call[] = [];
    const questions: unknown[] = [];
    await accept(storage, typed("sendblue:mh_1", "email jo that thursday works"), 1_000);
    await drain(storage, deps(calls, questions));
    expect(askCards(calls)).toHaveLength(0);

    await accept(storage, { ...inbound("mh_2", card("https://context.lc/tex/hello")) }, 1_000);
    await drain(storage, deps(calls, questions));
    expect(questions[1]).toBe(HELLO_TEXT);
    expect(askCards(calls)).toHaveLength(1);
    // Keyed to the ask as it went, the text the gateway's ask was sent in.
    const sentAsk = (await keptAsk(storage, 1_000))!;
    expect(askCards(calls)[0].body).toMatchObject({ number: PHONE, from_number: LINE, app_card: { url: `https://context.lc/tex/ask?k=${askKey(sentAsk)}` } });

    await accept(storage, inbound("mh_3", card(`https://context.lc/tex/ask?k=${askKey(sentAsk)}&c=1`)), 1_000);
    await drain(storage, deps(calls, questions));
    expect(questions[2]).toBe("yes");
  });
});
