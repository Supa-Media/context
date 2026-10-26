/**
 * Choosing with one tap: after a set of option cards goes as a carousel, a
 * Context card follows that says which one Tex would pick and asks them to
 * choose (the owner, 2026-10-26: App Cards, and "if you come up with UX that
 * utilizes both, great"). The carousel is for looking; the card is for
 * deciding.
 *
 * The card's URL carries the options, in order, and Tex's pick:
 * `https://context.lc/tex/pick?p=1&o=Blend%20LIC&o=Lugo's`. Tapping it opens
 * the Context app's Messages extension, which lists them; choosing one sends
 * the card back from their phone with `&c=<number>` added, and that reaches
 * Tex as the words "I pick 2: Lugo's" (`pickedText`), exactly as if they had
 * typed it. Nothing is kept on our side: the choice and the names come back
 * in the card, and they are only ever the person's own words to Tex.
 *
 * Without the extension the card is still a static bubble with Tex's pick,
 * and every option card already says "Reply 2 for more", so the card is
 * never the only way to choose. It goes only where note cards go: `APP_CARDS`
 * on (`appCards.ts`), a Sendblue one-to-one chat; a refusal sends nothing.
 */

import type { AppCard, AppCardConfig } from "./appCards";
import type { SendPart } from "./outgoing";

/** One option of a set, as the gateway read it from an option card (`apps/mcp/src/agent/outgoingPictures.js`). */
export type Choice = { name: string; price?: string; pick?: true; picture: number };

const MAX_CHOICES = 8;
const MAX_NAME = 60;
const MAX_PRICE = 20;
/** Sendblue's longest card URL. */
const MAX_URL = 2048;
const PICK_HOST = "https://context.lc";
const PICK_PATH = "/tex/pick";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The `choices` of a gateway answer, checked: two to eight named options, or none. Never throws. */
export function readChoices(raw: unknown): Choice[] {
  if (!Array.isArray(raw)) return [];
  const out: Choice[] = [];
  for (const item of raw.slice(0, MAX_CHOICES)) {
    if (!isRecord(item)) continue;
    const name = clean(item.name, MAX_NAME);
    const picture = item.picture;
    if (!name || typeof picture !== "number" || !Number.isInteger(picture) || picture < 0) continue;
    const price = clean(item.price, MAX_PRICE);
    out.push({ name, ...(price ? { price } : {}), ...(item.pick === true ? { pick: true as const } : {}), picture });
  }
  return out.length >= 2 ? out : [];
}

/** The card's state: the options in order and Tex's pick, numbered from 1. */
export function pickUrl(choices: Choice[]): string {
  const pick = choices.findIndex((choice) => choice.pick === true);
  const start = `${PICK_HOST}${PICK_PATH}?${pick >= 0 ? `p=${pick + 1}&` : ""}`;
  const at = (max: number) => start + choices.map((choice) => `o=${encodeURIComponent(choice.name.slice(0, max))}`).join("&");
  // Names are cut until the whole address fits, rather than an option dropped.
  let max = MAX_NAME;
  while (at(max).length > MAX_URL && max > 8) max -= 8;
  return at(max);
}

/**
 * The card that follows a set of option cards, or null when there is no set
 * or cards are off. Its picture is Tex's pick's own option card, when that
 * went by an address Sendblue can fetch.
 */
export function pickCard(choices: Choice[], pictures: SendPart[], config: AppCardConfig | null | undefined): AppCard | null {
  if (!config || choices.length < 2) return null;
  const media = pictures.flatMap((part) => (typeof part !== "string" && "media" in part && "url" in part.media ? [part.media.url] : []));
  const picked = choices.find((choice) => choice.pick === true);
  const image = picked !== undefined ? media[picked.picture] : undefined;
  const numbers = `1–${choices.length}`;
  const caption = picked ? `Tex's pick: ${picked.name}` : `${choices.length} options`;
  return {
    appName: "Context",
    extensionBundleId: config.extensionBundleId,
    teamId: config.teamId,
    ...(config.appStoreId ? { appStoreId: config.appStoreId } : {}),
    url: pickUrl(choices),
    interactive: false,
    fallbackText: `${caption}. Reply ${numbers} to choose.`,
    layout: {
      caption,
      subcaption: `Tap to choose, or reply ${numbers}`,
      ...(picked?.price ? { trailingCaption: picked.price } : {}),
      ...(image ? { imageUrl: image } : {}),
      summary: `${caption}. Reply ${numbers} to choose.`,
    },
  };
}

/** The pick card after an answer's pictures, where there is one to send. */
export function withPickCard(parts: SendPart[], choices: Choice[], config: AppCardConfig | null | undefined): SendPart[] {
  const card = pickCard(choices, parts, config);
  return card ? [...parts, { card }] : parts;
}

/** A Messages extension of ours: the Context app's (`lc.context.mobile.messages`, or staging's). */
const OUR_EXTENSION = /^lc\.context\.[a-z]+(?:\.[a-z]+)*\.messages$/;

/**
 * What a pick card sent back from their phone says, in their words: "I pick
 * 2: Lugo's". Null for any other card, a card from another app's extension,
 * or a pick that names no option. The card is untrusted input (Sendblue's
 * docs say so), but it is only ever as much as the person could have typed.
 */
export function pickedText(appCard: unknown): string | null {
  if (!isRecord(appCard)) return null;
  if (typeof appCard.extensionBundleId !== "string" || !OUR_EXTENSION.test(appCard.extensionBundleId)) return null;
  if (typeof appCard.url !== "string" || appCard.url.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(appCard.url);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== PICK_PATH) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "context.lc" && !host.endsWith(".context.lc")) return null;
  const options = url.searchParams.getAll("o").slice(0, MAX_CHOICES).map((name) => clean(name, MAX_NAME));
  const chose = Number(url.searchParams.get("c"));
  if (!Number.isInteger(chose) || chose < 1 || chose > options.length || !options[chose - 1]) return null;
  return `I pick ${chose}: ${options[chose - 1]}`;
}
