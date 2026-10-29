/** What `messagesCards.ts` and `messagesData.ts` share: a page's shape and escaping. */

/** `size`: compact docks the page where the keyboard goes, so the chat above stays in view (the owner, 2026-10-29). */
export type Page = { title: string; body: string; size?: "expanded" | "compact"; script?: "bridge" | "data"; view?: string };

export function escaped(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
