/**
 * What the two data cards say when they come back from a phone
 * (`infra/router/src/messagesData.ts`), in words the person could have typed:
 *
 * - `/tex/inbox?m=<address>/<id>&m=…`, the emails they handed Tex, as
 *   "Please take care of these emails: email:<address>/<id>, …", ids Tex
 *   fetches like any other.
 * - `/tex/times?d=<minutes>&z=<zone>&s=<instant>&s=…`, the free times they
 *   picked, written out on their own clock.
 *
 * The card is untrusted input, as every card is: anything malformed is
 * dropped, and a card naming nothing is not a card (null).
 *
 * Tex offers either one with a line of its answer (`[card times]`,
 * `[card inbox]`, `apps/mcp/src/agent/outgoingPictures.js`), which arrives
 * as `offers`; the card goes after the words, only where cards go.
 */

import { cardsOn, type AppCard, type AppCardConfig } from "./appCards";
import type { SendPart } from "./outgoing";

export type DataCardKind = "times" | "inbox";
/** What a turn may offer: a data card, or the live view of the chat's jobs (`answerCards.ts`). */
export type Offer = DataCardKind | "threads";

const CARDS: Record<DataCardKind, { caption: string; subcaption: string; trailing: string; summary: string }> = {
  times: { caption: "Pick times that work", subcaption: "Tap free times from your calendar", trailing: "Pick", summary: "Pick times that work" },
  inbox: { caption: "Your inbox", subcaption: "Tap the emails for Tex", trailing: "Open", summary: "Hand Tex some email" },
};

/** The gateway's `offers`, checked: each kind once, in order, or none. Never throws. */
export function readOffers(raw: unknown): Offer[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((kind): kind is Offer => kind === "times" || kind === "inbox" || kind === "threads"))];
}

export function dataCard(kind: DataCardKind, config: AppCardConfig): AppCard {
  const words = CARDS[kind];
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: `https://context.lc/tex/${kind}`,
    interactive: false,
    fallbackText: words.summary,
    layout: { caption: words.caption, subcaption: words.subcaption, trailingCaption: words.trailing, summary: words.summary },
  };
}

/** The offered cards after the answer, where cards go. */
export function withDataCards(parts: SendPart[], offers: readonly Offer[], config: AppCardConfig | null | undefined): SendPart[] {
  const kinds = offers.filter((kind): kind is DataCardKind => kind !== "threads");
  return kinds.length > 0 && cardsOn(config) ? [...parts, ...kinds.map((kind) => ({ card: dataCard(kind, config) }))] : parts;
}

const MAX_EMAILS = 10;
const MAX_TIMES = 5;
const MAILBOX_ID = /^[^\s@/]{1,64}@[^\s/]{1,255}\/[A-Za-z0-9_-]{1,64}$/;

/** The words a data card stands for; null for any other card or one naming nothing. */
export function dataCardText(url: URL): string | null {
  if (url.pathname === "/tex/inbox") {
    const emails = [...new Set(url.searchParams.getAll("m").filter((m) => MAILBOX_ID.test(m)))].slice(0, MAX_EMAILS);
    return emails.length === 0 ? null : `Please take care of these emails: ${emails.map((m) => `email:${m}`).join(", ")}`;
  }
  if (url.pathname === "/tex/times") {
    const zone = knownZone(url.searchParams.get("z")) ?? "UTC";
    const minutes = Number(url.searchParams.get("d"));
    const times = [...new Set(url.searchParams.getAll("s").map((at) => Date.parse(at)).filter(Number.isFinite))].sort((a, b) => a - b).slice(0, MAX_TIMES);
    if (times.length === 0) return null;
    const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const length = Number.isInteger(minutes) && minutes >= 15 && minutes <= 240 ? ` (${minutes} min each)` : "";
    return `These times work for me${length}: ${times.map((at) => format.format(at)).join("; ")} (${zone})`;
  }
  return null;
}

/** An IANA zone this runtime knows, or null. */
function knownZone(value: string | null): string | null {
  if (value === null || value.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return null;
  }
}
