/**
 * Which emoji Tex taps on a text it is still working on (`inbox.ts`, and every
 * tag in a group, `groupInbox.ts`).
 *
 * A thumbs-up on every text read as a shrug: Tex gave a 👍 to "are you
 * dumb???" (Dev, 2026-10-20: "should've been ☹️ or 😔", and "give the
 * reactions some character"). Then 👀 on nearly everything read the same way
 * (Dev2, 2026-10-25: "it's always using the eyes emoji ... come up with a more
 * human set"): most texts are errands (email her, move my 3pm, book a table),
 * which no rule matched, and every group tag got 👀 whatever it said. So the
 * tapback answers the feeling first (upset, sad, funny, thanks, excited), then
 * the errand (a picture, code, a reminder, the calendar, finding something,
 * writing, travel, food, shopping), then a question, and anything else gets
 * one of a few "on it" faces a friend would send.
 *
 * Sendblue takes exactly one emoji as a tapback (docs: Reactions); one it
 * refuses falls back to a like (`line.ts`, `sendblueGroups.ts`).
 *
 * Read from the person's words only, with no model: the tapback goes out
 * while the turn is still running. Never ✅, which would say done before it
 * is, and never a gendered person: Tex doesn't know who is reading.
 */

type Rule = { test: RegExp; emoji: readonly string[] };

const RULES: readonly Rule[] = [
  // Upset with Tex: sorry, never a thumbs-up.
  {
    test: /\b(dumb|stupid|idiot|useless|wtf|ffs|what the (hell|fuck)|are you (even )?(listening|reading)|did you (even )?(see|read))\b|\?{3,}|!{3,}/i,
    emoji: ["☹️", "😔"],
  },
  // Something hard happened to them: care, never a smile.
  {
    test: /\b(sick|ill|hospital|funeral|passed away|died|rough (day|week)|stressed|exhausted|overwhelmed|anxious|sad|heartbroken|bad news)\b|😢|😞|💔/i,
    emoji: ["🫂", "❤️‍🩹"],
  },
  { test: /\b(lol|lmao|haha+|hehe)\b|😂|🤣|😭|💀/i, emoji: ["😂", "😭", "💀"] },
  { test: /\b(thanks?|thank you|thx|ty|appreciate (it|you)|you'?re the best|lifesaver)\b|🙏/i, emoji: ["🫶", "🥰"] },
  {
    test: /\b(awesome|amazing|let'?s go|yay|so excited|can'?t wait|love (it|this)|got the job|we did it|good news)\b|🎉|🔥|🥳/i,
    emoji: ["🥳", "🙌", "🤩"],
  },
  {
    test: /\b(flyer|poster|logo|design|draw|sketch|picture|photo|image|pic|illustrat\w*|colou?rs?|blue|red|green|anime|cartoon)\b/i,
    emoji: ["🎨"],
  },
  { test: /\b(code|coding|bug|website|site|deploy|app|api|script|github|domain|dns)\b/i, emoji: ["🧑‍💻"] },
  { test: /\b(remind|reminder|don'?t let me forget|wake me)\b/i, emoji: ["⏰"] },
  {
    test: /\b(calendar|schedule|reschedule|meeting|invite|appointment|move my|block (off|out)|free (on|at)|availability)\b/i,
    emoji: ["🗓️"],
  },
  {
    test: /\b(find|look (up|for|into)|search|track down|dig up|where('?s| is| did)|check (again|on|if|whether))\b/i,
    emoji: ["🔎", "🕵️"],
  },
  { test: /\b(email|e-mail|reply|respond|draft|write|forward|message (him|her|them)|slack)\b/i, emoji: ["✍️", "📝"] },
  { test: /\b(flight|fly|hotel|airbnb|trip|travel|uber|lyft|train|airport|passport)\b/i, emoji: ["✈️", "🧳"] },
  { test: /\b(dinner|lunch|breakfast|brunch|restaurant|reservation|table for|groceries|grocery|recipe|cook)\b/i, emoji: ["🍽️", "😋"] },
  { test: /\b(buy|order|purchase|pay|paid|invoice|receipt|refund|price|cost|budget|shop|shopping|cart)\b/i, emoji: ["🛒", "💸"] },
  { test: /\?\s*$|^(what|why|how|when|who|which|should|could|would|is|are|do|does|can)\b/i, emoji: ["🤔", "🧐"] },
];

/** Anything else: on it, the way a friend says it. 👀 is one of them, no longer all of them. */
const ON_IT: readonly string[] = ["🫡", "👌", "💪", "🤝", "👀"];

/** The same text always gets the same one, so a retry does not change its mind. */
function pick(options: readonly string[], text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return options[hash % options.length];
}

export function ackEmoji(text: string): string {
  const words = text.trim();
  for (const rule of RULES) if (rule.test.test(words)) return pick(rule.emoji, words);
  return pick(ON_IT, words);
}
