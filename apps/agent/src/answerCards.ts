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
import { threadsLine } from "./jobs";
import type { SendPart } from "./outgoing";
import { withPickCard, type Choice } from "./pickCard";
import { withDrawnCards } from "./sendParts";

/** The live view of the chat's jobs as a Context card; tapped, the extension opens the view's page (`/tex/threads` → `/messages/threads`). */
export function threadsCard(link: string, config: AppCardConfig): AppCard {
  const key = new URL(link).searchParams.get("k") ?? "";
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: `https://context.lc/tex/threads?k=${encodeURIComponent(key)}`,
    interactive: false,
    fallbackText: threadsLine(link),
    layout: { caption: "What Tex is working on", subcaption: "Tap to see each one's steps", trailingCaption: "Live", summary: "What Tex is working on" },
  };
}

/** The view, where it was offered: a card where cards go, the link in words anywhere else. A link that could not be made sends nothing. */
async function threadsPart(offers: readonly Offer[], config: AppCardConfig | null | undefined, mint: (() => Promise<string>) | undefined): Promise<SendPart[]> {
  if (!offers.includes("threads") || mint === undefined) return [];
  let link: string;
  try {
    link = await mint();
  } catch {
    return [];
  }
  return [cardsOn(config) ? { card: threadsCard(link, config) } : threadsLine(link)];
}

export async function withAnswerCards(
  parts: SendPart[],
  answer: { texts: readonly string[]; choices: Choice[]; offers: readonly Offer[] },
  config: AppCardConfig | null | undefined,
  mint: (() => Promise<string>) | undefined,
): Promise<SendPart[]> {
  const cards = withDataCards(withDrawnCards(withPickCard(parts, answer.choices, config), config), answer.offers, config);
  return withAskCard([...cards, ...(await threadsPart(answer.offers, config, mint))], answer.texts, config);
}
