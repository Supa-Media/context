/**
 * Which emoji Tex taps on a text it is still working on (`inbox.ts`).
 *
 * A thumbs-up on every text read as a shrug: Tex gave a 👍 to "are you
 * dumb???" (Dev, 2026-10-20: "should've been ☹️ or 😔", and "give the
 * reactions some character"). Sendblue takes exactly one emoji as a tapback
 * (docs: Reactions), so the tapback fits the text: sorry when they are upset,
 * a magnifier when they asked to find something, a palette for a picture.
 *
 * Read from the person's words only, with no model: the tapback goes out
 * while the turn is still running. Never ✅, which would say done before it is.
 */

type Rule = { test: RegExp; emoji: readonly string[] };

const RULES: readonly Rule[] = [
  // Upset with Tex: sorry, never a thumbs-up.
  {
    test: /\b(dumb|stupid|idiot|useless|wtf|ffs|what the (hell|fuck)|are you (even )?(listening|reading)|did you (even )?(see|read))\b|\?{3,}|!{3,}/i,
    emoji: ["☹️", "😔"],
  },
  { test: /\b(lol|lmao|haha+|hehe)\b|😂|🤣|😭/i, emoji: ["😭", "😅"] },
  { test: /\b(awesome|amazing|let'?s go|yay|so excited|can'?t wait|love (it|this))\b|🎉|🔥/i, emoji: ["🤩"] },
  {
    test: /\b(flyer|poster|logo|design|draw|sketch|picture|photo|image|pic|illustrat\w*|colou?rs?|blue|red|green|anime|cartoon)\b/i,
    emoji: ["🎨", "🧑‍🎨"],
  },
  { test: /\b(code|coding|bug|website|site|deploy|app|api|script|github|domain|dns)\b/i, emoji: ["👨‍💻"] },
  {
    test: /\b(find|look (up|for|into)|search|track down|dig up|where('?s| is| did)|check (again|on|if|whether))\b/i,
    emoji: ["🔎", "🕵️‍♂️"],
  },
  { test: /\?\s*$|^(what|why|how|when|who|which|should|could|would|is|are|do|does|can)\b/i, emoji: ["🤔"] },
];

/** Anything else: looking at it. */
const DEFAULT = "👀";

/** The same text always gets the same one, so a retry does not change its mind. */
function pick(options: readonly string[], text: string): string {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return options[hash % options.length];
}

export function ackEmoji(text: string): string {
  const words = text.trim();
  for (const rule of RULES) if (rule.test.test(words)) return pick(rule.emoji, words);
  return DEFAULT;
}
