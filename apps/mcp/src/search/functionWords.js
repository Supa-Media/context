/**
 * Words a question is built from that say nothing about which note answers it ("how should I work with Seyi").
 *
 * The word search asks for a note holding every word typed. A question in a person's own words carries words like
 * "how", "should" and "I" that a long chat log or meeting transcript always holds and a short reference note often
 * does not, so the log matched every word, the note did not, and the note was not a word hit at all. Production,
 * 2026-11-04: "how should I work with Seyi" did not show resources/working-with-seyi.md in the first twelve; "work
 * Seyi" put it first.
 *
 * Only words that never name a topic are here. "may" (the month), "will" (the document), "us" (the country), "can"
 * and the time words ("this", "these", "next", "last", "still", "left") stay, because a person searches for them
 * ("book club this month": without "this", the club's index outranked this month's meeting, bench gh-153).
 */
export const FUNCTION_WORDS = new Set([
  "a", "an", "the",
  "i", "me", "my", "mine", "we", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "they", "them", "their", "theirs", "it", "its",
  "is", "am", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "doing", "have", "has", "had",
  "should", "would", "could", "shall", "must", "might",
  "how", "what", "why", "which", "where", "when", "who", "whom", "whose",
  "that", "those", "there", "here",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "into", "onto", "as",
  "and", "or", "but", "if", "so", "than", "then", "too", "very", "just",
]);

/** The tokens that name what a note is about: `tokens` without function words, or all of them when that leaves none. */
export function contentTokens(tokens) {
  const kept = tokens.filter((token) => !FUNCTION_WORDS.has(token.toLowerCase()));
  return kept.length > 0 ? kept : tokens;
}
