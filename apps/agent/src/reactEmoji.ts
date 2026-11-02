/**
 * The 64 emoji decide may choose to react with (Dev2, 2026-10-27): the same
 * list as the control plane's `apps/convex/functions/lib/reactEmoji.ts`, kept
 * here as an allowlist so an emoji from anywhere else is never sent. A test in
 * each app pins the list.
 */
export const REACT_EMOJI: readonly string[] = [
  "❤️", "👍", "👎", "😂", "🤣", "😊", "😁", "😉", "😍", "🤗", "🤔", "👀", "😮", "🤯", "😢", "😔",
  "☹️", "😬", "😅", "🤦", "🤷", "🙏", "👏", "🙌", "💪", "👌", "👋", "🫡", "🤝", "🤞", "🎉", "🥳",
  "🔥", "⭐", "✨", "💯", "🚀", "🏆", "💡", "‼️", "❓", "⏳", "📅", "⏰", "📝", "📚", "💻", "📱",
  "📧", "💰", "📈", "🏠", "✈️", "🚗", "☕", "🍕", "🥂", "🎂", "🎁", "🎵", "☀️", "🌙", "🐶", "🌱",
];

/** Decide's emoji when it is one of the 64, else the one picked from the words. */
export function reactionFor(decided: string | undefined, fromWords: string): string {
  return decided !== undefined && REACT_EMOJI.includes(decided) ? decided : fromWords;
}
