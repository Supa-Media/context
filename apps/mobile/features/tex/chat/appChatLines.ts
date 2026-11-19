/**
 * Pure edits to the lines the chat page holds, for the optimistic changes the
 * hook makes before the route answers. Kept apart from the hook so each rule
 * can be read and tested on its own.
 */
import { isPending, type AppChatRow, type ChatLine, type RowReaction } from "./appChatGateway";

/** The server row with this id, or `undefined`. Pending lines never match. */
export function serverRowOf(lines: readonly ChatLine[], id: string): AppChatRow | undefined {
  return lines.find((line): line is AppChatRow => !isPending(line) && line.id === id);
}

/** Replace the server row with this id by `change`; every other line stays as it is. */
export function patchRow(lines: readonly ChatLine[], id: string, change: (row: AppChatRow) => AppChatRow): ChatLine[] {
  return lines.map((line) => (!isPending(line) && line.id === id ? change(line) : line));
}

/**
 * The row's tapbacks after the person taps `emoji`. Their own tapback is
 * replaced by it, or taken back when it is the same emoji already there (as in
 * Messages). Tex's are kept.
 */
export function reactionsAfterTap(row: AppChatRow, emoji: string): RowReaction[] {
  const current = row.reactions ?? [];
  const mine = current.find((reaction) => reaction.who === "me");
  const others = current.filter((reaction) => reaction.who !== "me");
  return mine?.emoji === emoji ? others : [...others, { who: "me", emoji }];
}

/** The row with its reactions set; the field is gone when there are none. */
export function withReactions(row: AppChatRow, reactions: RowReaction[] | undefined): AppChatRow {
  const next: AppChatRow = { ...row };
  if (reactions === undefined || reactions.length === 0) {
    delete next.reactions;
  } else {
    next.reactions = reactions;
  }
  return next;
}

/** The reply reference for a row on the page: its id, and its words when it has some. */
export function replyRefFor(lines: readonly ChatLine[], id: string): { id: string; text?: string } {
  const row = serverRowOf(lines, id);
  return row !== undefined && row.text.length > 0 ? { id, text: row.text } : { id };
}

/** Every object URL a pending line still shows. */
export function previewUrlsInUse(lines: readonly ChatLine[]): Set<string> {
  const urls = new Set<string>();
  for (const line of lines) {
    if (isPending(line)) for (const url of line.previews ?? []) urls.add(url);
  }
  return urls;
}
