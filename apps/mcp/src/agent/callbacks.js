/**
 * OLD MOMENTS ARE OFFERED, NOT HIDDEN (Dev2, 2026-11-11: group time awareness, plan v3 step 3).
 *
 * "There is value in Tex being able to roast or come up with a joke from something that happened in the past":
 * code puts the right context in front of Tex, each piece with its age and how the chat took it, and Tex decides
 * freely what to say. Before this, a group's untagged chatter was shown word for word at any age, undated in
 * relative terms and buried in the transcript, so a four-day-old aside read like this morning's (the Tex Devs
 * OAuth roast, 2026-11-06).
 *
 * Each turn this picks up to `MAX_CALLBACKS` older texts (from before the last 24 hours) that fit what is being
 * said now, ranked by:
 *  - fit: rare words shared with the newest texts, the person named, the conversation it most likely continues;
 *  - how it landed: tapbacks and laughs on it, replies typed under it;
 *  - age: older counts a little less, never to nothing;
 *  - wear: one Tex already brought back this week counts half, since models repeat a joke.
 *
 * Pure code, no model call and nothing written: matching words first (decision E, recommended), embeddings only if
 * the group bench shows this misses.
 */

import { oneLine, speaker } from "./logRender.js";
import { dayAgo } from "./chatTime.js";

export const MAX_CALLBACKS = 5;
const MAX_WORDS = 240;
const DAY = 24 * 3_600_000;
const SHOWN = new Set(["text", "picture", "file", "link"]);

/** Words too common to say two texts are about the same thing. */
const STOP = new Set(
  ("about above after again also always another anyone anything around because been before being below between both cant could " +
    "didnt does doesnt doing done dont down each even ever every from going gonna good have having here hers into just know " +
    "like lmao lmfao make many maybe more most much must need never nothing okay only other ours over really right said same " +
    "should since some something still such sure take than thank thanks that thats their them then there these they thing " +
    "things think this those though through today tomorrow very want wants was were what whats when where which while will " +
    "with would yeah yall yes yesterday your youre yours haha hahaha lol omg gonna wanna gotta tex").split(" "),
);

/** The distinct words of a text worth matching on: four letters or more, not common. */
export function wordsOf(text) {
  const found = String(text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9][a-z0-9']{3,}/g) ?? [];
  return new Set(found.map((word) => word.replace(/'/g, "")).filter((word) => word.length >= 4 && !STOP.has(word)));
}

const LAUGH = /\blaugh|haha|\blol\b|😂|🤣|💀/i;
const QUOTED = /[“"](.{3,})$/;
const squash = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * How each text landed: tapbacks (and the laughs among them) and replies typed under it, by id. A tapback names its
 * text by quoting it (`Laughed at "…"`), so it is matched to the latest earlier text that starts with those words.
 */
export function landings(events) {
  const landed = new Map();
  const bump = (id, key) => {
    const row = landed.get(id) ?? { tapbacks: 0, laughs: 0, replies: 0 };
    row[key] += 1;
    landed.set(id, row);
  };
  events.forEach((event, index) => {
    if (typeof event.replyTo === "string" && event.kind !== "reaction") bump(event.replyTo, "replies");
    if (event.kind !== "reaction" || typeof event.text !== "string") return;
    const quoted = squash(event.text.match(QUOTED)?.[1] ?? "").replace(/[”"]$/, "").replace(/(…|\.\.\.)$/, "").trim();
    if (quoted.length < 3) return;
    for (let at = index - 1; at >= 0; at -= 1) {
      const text = events[at];
      if (text.kind === "reaction" || typeof text.text !== "string" || !squash(text.text).startsWith(quoted)) continue;
      bump(text.id, "tapbacks");
      if (LAUGH.test(event.text.split(/[“"]/)[0])) bump(text.id, "laughs"); // the tapback's own words, never the quoted text's
      return;
    }
  });
  return landed;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** How the chat took a text, in words. */
function landedWords(row) {
  if (row === undefined || row.tapbacks + row.replies === 0) return "no reactions";
  const parts = [];
  if (row.laughs > 0) parts.push(plural(row.laughs, "laugh"));
  if (row.tapbacks - row.laughs > 0) parts.push(plural(row.tapbacks - row.laughs, "tapback"));
  if (row.replies > 0) parts.push(plural(row.replies, "reply", "replies"));
  return parts.join(", ");
}

/**
 * Up to `MAX_CALLBACKS` of `pool` (older texts, oldest first) that fit what is being said now (`live`: the newest
 * texts, the ones answered last), best first. `all` is every shown event, for tapbacks, replies and wear; `tags` and
 * `suggested` the conversation each text and this turn most likely belong to (`conversationThreads.js`).
 */
export function pickCallbacks({ pool, live, all = pool, tags = null, suggested = null, now }) {
  const texts = pool.filter((event) => SHOWN.has(event.kind) && typeof event.text === "string" && event.text.trim().length >= 12 && event.from?.kind !== "system" && event.from?.kind !== "agent");
  if (texts.length === 0) return [];
  const asked = live.map((event) => String(event.text ?? "")).join("\n");
  const want = wordsOf(asked);
  const named = new Set([...asked.toLowerCase().matchAll(/@?([a-z][a-z0-9_.-]{1,30})/g)].map((match) => match[1]));
  // How rare a word is across what Tex can see: a word in every other text matches nothing in particular.
  const seen = new Map();
  for (const event of [...texts, ...live]) for (const word of wordsOf(event.text)) seen.set(word, (seen.get(word) ?? 0) + 1);
  const rarity = (word) => 1 + Math.log((texts.length + live.length) / (seen.get(word) ?? 1));
  const landed = landings(all);
  const recentTex = all.filter((event) => event.from?.kind === "tex" && now - event.at < 7 * DAY).map((event) => wordsOf(event.text));
  const scored = [];
  for (const event of texts) {
    const own = wordsOf(event.text);
    const shared = [...own].filter((word) => want.has(word));
    const name = typeof event.from?.name === "string" ? event.from.name.toLowerCase().replace(/^@+/, "") : "";
    let fit = shared.reduce((sum, word) => sum + rarity(word), 0);
    if (name !== "" && named.has(name)) fit += 2;
    if (suggested !== null && tags?.get(event.id) === suggested) fit += 2;
    if (fit < 2) continue; // nothing in particular ties it to now: one common word in common is not enough
    const row = landed.get(event.id);
    const reception = row === undefined ? 0 : row.tapbacks * 0.5 + row.laughs + row.replies * 0.5;
    const days = Math.max(0, (now - event.at) / DAY);
    let score = (fit + reception) / (1 + days / 30);
    // Tex said most of its words again this week: it was already brought back.
    const echoed = event.from?.kind !== "tex" && own.size >= 3 && recentTex.some((said) => [...own].filter((word) => said.has(word)).length >= Math.max(3, own.size * 0.6));
    if (echoed) score /= 2;
    scored.push({ event, score, row });
  }
  return scored.sort((a, b) => b.score - a.score || b.event.at - a.event.at).slice(0, MAX_CALLBACKS);
}

const DATE = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" });

/** The picked moments as the block Tex reads, "" for none. */
export function callbacksPrompt(picked, { now, timeZone = "UTC" }) {
  if (picked.length === 0) return "";
  const date = DATE(timeZone);
  const lines = picked.map(({ event, row }) => {
    const said = oneLine(String(event.text)).slice(0, MAX_WORDS);
    const cut = said.length < String(event.text).length ? "…" : "";
    return `- ${speaker(event.from)}, ${date.format(new Date(event.at))} (${dayAgo(event.at, now, timeZone)}): "${said}${cut}" (${landedWords(row)})`; // day-level, so it changes only at midnight
  });
  return (
    "(Things from earlier in this chat that may fit what's being said now, each with when it was said and how the chat took it. " +
    "Use one if it fits, a callback or a joke included, and make clear when it's from; leave them all if none fits. " +
    "If someone pushes back on one, drop it.)\n" +
    lines.join("\n")
  );
}
