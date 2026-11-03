/**
 * The cards a one-to-one answer ends with, in order: a drawn card as a
 * Context card (`sendParts.ts`), the pick card after a set of option cards
 * (`pickCard.ts`), the data cards it offered (`dataCards.ts`), the live view
 * of the chat's jobs (`jobs.ts`), and the ask card under something waiting on
 * a yes (`cardChats.ts`). Moved out of `inbox.ts` whole, so it stays under its
 * size limit.
 */

import { cardsOn, type AppCard, type AppCardConfig } from "./appCards";
import { withAskCard } from "./cardChats";
import { withDataCards, type Offer } from "./dataCards";
import { readHub, threadsLine, withViewLine } from "./jobs";
import { isAsk } from "./thumbs";
import type { SendPart } from "./outgoing";
import { withPickCard, type Choice } from "./pickCard";
import { withDrawnCards } from "./sendParts";

/**
 * The live view of the chat's jobs as a Context card. A hub link (`jobs.ts` `readHub`) is the card's own address,
 * which the extension opens as it is, the signed-in Tex page; the chat's own view opens in the extension
 * (`/tex/threads` → `/messages/threads`).
 */
export function threadsCard(link: string, config: AppCardConfig): AppCard {
  const hub = readHub(link);
  const key = new URL(link).searchParams.get("k") ?? "";
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: hub ?? `https://context.lc/tex/threads?k=${encodeURIComponent(key)}`,
    interactive: false,
    fallbackText: threadsLine(link),
    layout: { caption: "What Tex is working on", subcaption: hub ? "Tap to open your Tex page" : "Tap to see each one's steps", trailingCaption: "Live", summary: "What Tex is working on" },
  };
}

/**
 * The parts with the view, where it was offered: a card after them where cards go, else the link in words inside the
 * first text that is not an ask (`jobs.ts` `withViewLine`). A link that could not be made changes nothing.
 */
async function withThreads(parts: SendPart[], offers: readonly Offer[], config: AppCardConfig | null | undefined, mint: (() => Promise<string>) | undefined): Promise<SendPart[]> {
  if (!offers.includes("threads") || mint === undefined) return parts;
  let link: string;
  try {
    link = await mint();
  } catch {
    return parts;
  }
  return cardsOn(config) ? [...parts, { card: threadsCard(link, config) }] : withViewLine(parts, threadsLine(link), isAsk);
}

export async function withAnswerCards(
  parts: SendPart[],
  answer: { texts: readonly string[]; choices: Choice[]; offers: readonly Offer[] },
  config: AppCardConfig | null | undefined,
  mint: (() => Promise<string>) | undefined,
): Promise<SendPart[]> {
  const cards = withDataCards(withDrawnCards(withPickCard(parts, answer.choices, config), config), answer.offers, config);
  return withAskCard(await withThreads(cards, answer.offers, config, mint), answer.texts, config);
}
