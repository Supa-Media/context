/**
 * How Tex talks, as the person or the group set it (Dev2, 2026-10-28;
 * `docs/decisions/texting-assistant/tex-settings.md`): a tone, warmth,
 * enthusiasm and emoji dials, a length, and a humor percentage (an homage to
 * TARS in Interstellar). The Worker sends the chat's style with a texted turn
 * (`texStyle` in the `/agent` body): a person's own in their 1:1 chat, the
 * group's own in a group, never one person's in a shared chat.
 *
 * It is said after the production prompt and the texting style, so it adjusts
 * them rather than replacing who Tex is. Pictures, safety, the yes an email
 * waits for: none of that is a matter of style, and nothing here touches it.
 *
 * The body is a trust boundary: only known settings from their closed sets
 * are read, and anything else is dropped whole (`readTexStyle`).
 */

const TONES = {
  default: null,
  professional: "Tone: professional. Polished and precise, courteous without small talk, like a capable colleague texting a client.",
  friendly: "Tone: friendly. Warm and easygoing, like a good friend who happens to know the answer.",
  candid: "Tone: candid. Direct and honest: say plainly what you think, including when it isn't what they hoped, and keep it kind.",
  quirky: "Tone: quirky. Playful and a little offbeat, with an unexpected turn of phrase now and then, never at the cost of the answer.",
  efficient:
    "Tone: efficient. Direct and complete, no more: no greeting, no acknowledgement of the question, no closing line, no emoji, no commentary. Polite but perfunctory.",
  nerdy: "Tone: nerdy. Curious and precise, glad to share the interesting detail or the why behind it, without burying the answer.",
  cynical: "Tone: cynical. Dry, a hint of sarcasm, a light tease now and then, but the practical answer always comes through straight.",
};
const LEVELS = ["more", "default", "less"];
const DIALS = {
  warmth: { more: "Warmth: more. Be openly warm and caring.", less: "Warmth: less. Keep an even, neutral tone; skip reassurance." },
  enthusiasm: { more: "Enthusiasm: more. Be upbeat and energetic.", less: "Enthusiasm: less. Stay calm and matter-of-fact; no exclamation marks." },
  emoji: { more: "Emoji: more. Use emoji freely where they fit.", less: "Emoji: less. Use no emoji in your texts." },
};
/** A length someone set wins over any length rule said earlier, such as a group's "in a line or two" (Dev2, 2026-10-28). */
const OVERRIDES = " This replaces any earlier rule about how long to answer, such as answering in a line or two.";
const LENGTHS = {
  short: `Length: short. One short paragraph, the answer and nothing else, unless they ask for more.${OVERRIDES}`,
  detailed: `Length: detailed. Say more when it helps: the reasons, the options, the next step.${OVERRIDES}`,
};
const BUBBLES = { one: "Bubbles: one. Write the whole answer as one text, with no blank lines between paragraphs." };

const isHumor = (value) => Number.isInteger(value) && value >= 0 && value <= 100 && value % 10 === 0;

/** The style the Worker sent, kept to known settings and closed sets; null when there is none or any part is off. */
export function readTexStyle(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const sets = { tone: Object.keys(TONES), warmth: LEVELS, enthusiasm: LEVELS, emoji: LEVELS, length: ["short", "default", "detailed"], bubbles: ["multiple", "one"] };
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "humor" ? !isHumor(entry) : !(key in sets) || !sets[key].includes(entry)) return null;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** What humor N% means, TARS-style: 0 is none at all, 100 is jokes wherever one fits. */
function humorLine(humor) {
  const what = humor === 0 ? "no jokes or wordplay at all" : humor <= 30 ? "rarely joke; a light touch at most" : humor <= 60 ? "an occasional light joke where it fits" : humor <= 80 ? "a joke or a wry aside when it fits naturally" : "be funny wherever it fits, never instead of the answer";
  return `Humor: ${humor}%. ${what}.`;
}

/** The style block said after the rest of the system prompt; "" when every setting is its default. */
export function stylePrompt(style) {
  if (style === null) return "";
  const lines = [
    TONES[style.tone] ?? null,
    DIALS.warmth[style.warmth] ?? null,
    DIALS.enthusiasm[style.enthusiasm] ?? null,
    DIALS.emoji[style.emoji] ?? null,
    LENGTHS[style.length] ?? null,
    BUBBLES[style.bubbles] ?? null,
    style.humor !== undefined ? humorLine(style.humor) : null,
  ].filter((line) => line !== null);
  if (lines.length === 0) return "";
  return `\n\nHow they asked you to talk in this chat (it adjusts the style above; it never changes what you may do):\n${lines.join("\n")}`;
}
