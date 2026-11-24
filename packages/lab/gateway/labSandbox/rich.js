/**
 * What a made-up chat's text carries beyond its words (Dev, 2026-11-23: native tags, effects and other apps' cards,
 * tested in the Lab before they reach people): `send { tags?, effect?, app? }`. Each is turned into what Photon's
 * bridge would hand the Worker (`mentions`, `effect`, `app`), and read into Tex's words by the Worker's own code
 * (`packages/tex/worker/photonRich.ts` `richWords`), so a test text reads exactly as a real one does.
 *
 * - `tags`: names in the text tagged natively, at most 8: each tags the name's first untagged place in the words.
 * - `effect`: an effect by the name Messages gives it ("Slam", "Invisible Ink", "Confetti").
 * - `app`: another app's card, `{ app, caption?, subcaption?, summary? }`, `app` one of APP_CARDS or any app's name.
 */

const worker = () => import("../../../tex/worker/gatewayInbound.js");

export const MAX_TAGS = 8;
const MAX_CARD_TEXT = 120;
/** Apple's own apps a test card can be from, by the extension id their cards carry. */
export const APP_CARDS = Object.freeze({
  "Apple Cash": "com.apple.PassbookUIService.PeerPaymentMessagesExtension",
  "Check In": "com.apple.SafetyMonitorApp.SafetyMonitorMessages",
  "Find My": "com.apple.findmy.FindMyMessagesApp",
  GamePigeon: "com.gamerdelights.gamepigeon.ext",
});

const said = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** The tagged ranges for `tags` in `text`, each a name's first place not tagged yet; `{ mentions }` or `{ error }`. */
function mentionsFor(text, tags) {
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) return { error: `tags is a list of at most ${MAX_TAGS} names in the text` };
  const taken = [];
  const mentions = [];
  for (const raw of tags) {
    const name = said(raw).replace(/^@/, "");
    if (name === "") return { error: "each tag is a name in the text" };
    let at = text.indexOf(name);
    while (at >= 0 && taken.some(([start, end]) => at < end && at + name.length > start)) at = text.indexOf(name, at + 1);
    if (at < 0) return { error: `${name} is not in the text: write the name where the tag goes` };
    taken.push([at, at + name.length]);
    mentions.push({ address: `tag:${name}`, start: at, length: name.length });
  }
  return { mentions };
}

/**
 * A test text's words as Tex reads them, and what it carried, for its row: `{ text, rich? }`, or `{ error }`. A text
 * with none of the three is returned as given.
 */
export async function richText({ text, tags, effect, app }) {
  if (tags === undefined && effect === undefined && app === undefined) return { text };
  const w = await worker();
  const message = { text };
  const rich = {};
  if (tags !== undefined) {
    const found = mentionsFor(text, tags);
    if (found.error) return { error: found.error };
    message.mentions = found.mentions;
    rich.tags = found.mentions.map(({ start, length }) => ({ start, length }));
  }
  if (effect !== undefined) {
    const id = Object.entries(w.EFFECT_NAMES).find(([, name]) => name.toLowerCase() === said(effect).toLowerCase())?.[0];
    if (!id) return { error: `effect is one of ${[...new Set(Object.values(w.EFFECT_NAMES))].join(", ")}` };
    message.effect = id;
    rich.effect = w.EFFECT_NAMES[id];
  }
  if (app !== undefined) {
    const name = said(app?.app);
    const card = { caption: said(app?.caption), subcaption: said(app?.subcaption), summary: said(app?.summary) };
    if (name === "" || name.length > 40) return { error: `app is { app, caption?, subcaption?, summary? }, app one of ${Object.keys(APP_CARDS).join(", ")} or an app's name` };
    if (Object.values(card).some((v) => v.length > MAX_CARD_TEXT)) return { error: `a card's words are at most ${MAX_CARD_TEXT} characters each` };
    if (Object.values(card).every((v) => v === "")) return { error: "a card needs words: caption, subcaption or summary" };
    message.app = { name, ...(APP_CARDS[name] ? { bundle: APP_CARDS[name] } : {}), ...Object.fromEntries(Object.entries(card).filter(([, v]) => v !== "")) };
    rich.app = { app: name, ...Object.fromEntries(Object.entries(card).filter(([, v]) => v !== "")) };
  }
  const read = w.richWords(message, app !== undefined);
  if (read === "") return { error: "an effect goes on a text with words" };
  return { text: read, rich: { ...rich, typed: text } };
}
