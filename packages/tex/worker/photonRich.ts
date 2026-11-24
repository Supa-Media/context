/**
 * What iMessage shows on a text beyond its words, read into the words Tex gets (Dev, 2026-11-23: "native tags, real
 * imessage polls, running the group, reading other apps cards, and effects"). The bridge passes each as Photon gives
 * it (`infra/photon-bridge/container/map.mjs`); this reads them, as `(voice message)` is read for a voice memo:
 *
 * - a native tag: iMessage writes a tag as the bare name, so a tag on Tex read as "Tex" and the "@Tex" backstop
 *   (`groupWords.ts` `tagsTex`) never fired. Each tagged range gets its "@", so "@Tex" and "@Sam" read as tags;
 * - an effect: "(sent with Slam)" before the words, by the name Messages gives it;
 * - another app's card (Apple Cash, Check In, Find My, a game): "(Apple Cash card: $40 · Sent)", from the words on
 *   the card, never its payload or its address.
 *
 * Pure: no fetch, no storage. The Lab's made-up chats read a simulated text the same way.
 */

type Rec = Record<string, unknown>;
const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/** Apple's effect ids by the name Messages shows in its send menu. */
export const EFFECT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "com.apple.MobileSMS.expressivesend.impact": "Slam",
  "com.apple.MobileSMS.expressivesend.loud": "Loud",
  "com.apple.MobileSMS.expressivesend.gentle": "Gentle",
  "com.apple.MobileSMS.expressivesend.invisibleink": "Invisible Ink",
  "com.apple.messages.effect.CKConfettiEffect": "Confetti",
  "com.apple.messages.effect.CKFireworksEffect": "Fireworks",
  "com.apple.messages.effect.CKBalloonEffect": "Balloons",
  "com.apple.messages.effect.CKHappyBirthdayEffect": "Balloons",
  "com.apple.messages.effect.CKHeartEffect": "Love",
  "com.apple.messages.effect.CKLasersEffect": "Lasers",
  "com.apple.messages.effect.CKSparklesEffect": "Celebration",
  "com.apple.messages.effect.CKShootingStarEffect": "Shooting Star",
  "com.apple.messages.effect.CKSpotlightEffect": "Spotlight",
  "com.apple.messages.effect.CKEchoEffect": "Echo",
});

/** The name Messages gives an effect, or "an effect" for an id it does not know; null for none. */
export function effectName(id: unknown): string | null {
  if (typeof id !== "string" || id === "") return null;
  return EFFECT_NAMES[id] ?? "an effect";
}

const MAX_MENTIONS = 20;

/**
 * The words with each native tag marked "@": a range already after an "@" is left as it is, and a range outside the
 * words (Photon counts UTF-16 units, as JavaScript does) or overlapping another is skipped.
 */
export function taggedWords(text: string, mentions: unknown): string {
  if (!Array.isArray(mentions) || mentions.length === 0) return text;
  const ranges = mentions
    .slice(0, MAX_MENTIONS)
    .filter((m): m is { start: number; length: number } => isRecord(m) && Number.isInteger(m.start) && Number.isInteger(m.length) && (m.start as number) >= 0 && (m.length as number) > 0)
    .filter((m) => m.start + m.length <= text.length)
    .sort((a, b) => b.start - a.start);
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const { start, length } of ranges) {
    if (start + length > floor) continue;
    floor = start;
    if (start > 0 && out[start - 1] === "@") continue;
    if (out[start] === "@") continue;
    out = `${out.slice(0, start)}@${out.slice(start)}`;
  }
  return out;
}

/** Apple's own apps by the extension id their cards carry: named as people know them, whatever the card says. */
const APPS: ReadonlyArray<[RegExp, string]> = [
  [/PeerPaymentMessagesExtension/i, "Apple Cash"],
  [/SafetyMonitor/i, "Check In"],
  [/findmy/i, "Find My"],
  [/gamepigeon/i, "GamePigeon"],
];
const MAX_CARD_WORDS = 400;

/** The words on another app's card, said as one line: "Apple Cash card: $40 · Sent"; null when the card has none. */
export function appCardWords(app: unknown): string | null {
  if (!isRecord(app)) return null;
  const said = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  const bundle = said(app.bundle);
  const name = APPS.find(([pattern]) => pattern.test(bundle))?.[1] ?? (said(app.name) || "an app's");
  const lines = [app.caption, app.subcaption, app.trailingCaption, app.trailingSubcaption, app.imageTitle, app.imageSubtitle].map(said).filter((line) => line !== "");
  const shown = [...new Set(lines.length > 0 ? lines : [said(app.summary)].filter((line) => line !== ""))];
  if (shown.length === 0) return null;
  return `${name} card: ${shown.join(" · ")}`.slice(0, MAX_CARD_WORDS);
}

/**
 * A received text's words as Tex reads them: tags marked, then the effect, then another app's card when `card` is
 * set (the caller decides a card is another app's, not a link preview or one of ours). Untrimmed in, trimmed out.
 */
export function richWords(message: Rec, card: boolean): string {
  const raw = typeof message.text === "string" ? message.text : "";
  let text = taggedWords(raw, message.mentions).trim();
  const app = card ? appCardWords(message.app) : null;
  if (app !== null) text = text === "" ? `(${app})` : `(${app}) ${text}`;
  const effect = effectName(message.effect);
  if (effect !== null && text !== "") text = `(sent with ${effect}) ${text}`;
  return text;
}
