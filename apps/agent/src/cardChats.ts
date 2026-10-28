/**
 * Cards for people who have the Context app (the owner, 2026-10-28: "can we
 * send more interactive cards when people have the app?").
 *
 * Nothing on our side knows who installed the app, so the chat tells us: any
 * card from our own Messages extension that reaches Tex (a pick chosen, an
 * ask answered, or the drawer's "Turn on cards with Tex") marks the inbox as
 * one whose person has it. With `APP_CARDS` "app", cards go only there; with
 * "on", everywhere. Without the app a card is a bubble that opens the App
 * Store, which is why "app" is the setting.
 *
 * Three cards come back from their phone, each read as the words the person
 * could have typed (`cardReply`):
 * - a pick, "I pick 2: Lugo's" (`pickCard.ts`);
 * - an ask's Yes or Not now, "yes" or "no", which the gateway then checks
 *   exactly as a typed one. The card carries a key of the ask it was sent
 *   under; tapped after a newer reply, it is no longer a yes (`settleCard`);
 * - the drawer's hello, which only says they have the app.
 */

import { cardsOn, type AppCard, type AppCardConfig } from "./appCards";
import type { InboxStorage } from "./inbox";
import type { SendPart } from "./outgoing";
import { ourCardUrl, pickedText } from "./pickCard";
import type { Message } from "./reply";
import { isAsk, keptAsk } from "./thumbs";

/** When a card of ours last came from this inbox's person. */
const HERE_KEY = "cards:app";
const ASK_URL = "https://context.lc/tex/ask";
const ASK_KEY = /^[a-z0-9]{1,8}$/;

export const HELLO_TEXT = "I have the Context app, so you can send me cards here.";
/** A Yes tapped on an ask that is no longer the last one: not a yes, and says why. */
export const STALE_YES = "I tapped Yes on an older card, not on your last ask.";

/** What a card from their phone says, in their words, and the ask it answers; null for anything else. */
export type CardReply = { text: string; ask?: string };

export function cardReply(appCard: unknown): CardReply | null {
  const url = ourCardUrl(appCard);
  if (url === null) return null;
  if (url.pathname === "/tex/hello") return { text: HELLO_TEXT };
  if (url.pathname === "/tex/ask") {
    const ask = url.searchParams.get("k") ?? "";
    const chose = url.searchParams.get("c");
    if (!ASK_KEY.test(ask) || (chose !== "1" && chose !== "2")) return null;
    return { text: chose === "1" ? "yes" : "no", ask };
  }
  const picked = pickedText(appCard);
  return picked === null ? null : { text: picked };
}

/** A short key of an ask's words, so a card tapped later is matched to the ask it was sent under. */
export function askKey(ask: string): string {
  let hash = 0x811c9dc5;
  for (const unit of ask) hash = Math.imul(hash ^ unit.codePointAt(0)!, 0x01000193) >>> 0;
  return hash.toString(36);
}

/** The deps with cards on for this chat when `APP_CARDS` is "app" and its person has shown they have the app. */
export async function withCardsHere<T extends { appCard?: AppCardConfig | null }>(storage: InboxStorage, deps: T): Promise<T> {
  const config = deps.appCard;
  if (!config?.onlyWhereApp) return deps;
  try {
    if ((await storage.get<number>(HERE_KEY)) === undefined) return deps;
  } catch {
    return deps;
  }
  return { ...deps, appCard: { ...config, here: true } };
}

/** On arrival: a card of ours marks the chat as having the app, and a Yes on an old ask stops being a yes. */
export async function settleCard(storage: InboxStorage, message: Message, now: number): Promise<Message> {
  if (message.viaCard === undefined) return message;
  await storage.put<number>(HERE_KEY, now);
  const sentUnder = message.viaCard.ask;
  if (sentUnder === undefined || message.text !== "yes") return message;
  const ask = await keptAsk(storage, now);
  return ask !== undefined && askKey(ask) === sentUnder ? message : { ...message, text: STALE_YES };
}

/** The card under an ask: Yes, or Not now, with a tap. */
export function askCard(ask: string, config: AppCardConfig): AppCard {
  const summary = "Go ahead? Reply yes or no.";
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: `${ASK_URL}?k=${askKey(ask)}`,
    interactive: false,
    fallbackText: summary,
    layout: { caption: "Go ahead?", subcaption: "Tap Yes or Not now, or reply yes", trailingCaption: "Answer", summary },
  };
}

/** The ask card after a reply that carries an ask, where cards go. */
export function withAskCard(parts: SendPart[], texts: readonly string[], config: AppCardConfig | null | undefined): SendPart[] {
  const ask = texts.find(isAsk);
  return ask !== undefined && cardsOn(config) ? [...parts, { card: askCard(ask, config) }] : parts;
}
