/**
 * What the editor needs from its host to offer and draw a workspace's own
 * emoji. The host owns the list, the bytes and the Add dialog; the editor
 * only asks.
 *
 * A ref behind a facet, the arrangement `imageHost` and `formHost` use: the
 * extensions are built once and read the host at call time.
 */

import { Facet, StateEffect } from "@codemirror/state";

/** One Slackmojis search result. The picture comes through `previewSlackmoji`. */
export interface SlackmojiResult {
  readonly name: string;
  readonly url: string;
  readonly category: string | null;
}

export interface EmojiHostContext {
  /**
   * This workspace's emoji names, or `null` when the host has no list (the
   * native editor, or before the list has arrived). The menu offers only
   * what is here; the note still draws any name `load` answers for.
   */
  custom(): readonly string[] | null;
  /** A URL an `<img>` may show for `:name:`, or `null` when there is no such emoji. */
  load(name: string): Promise<string | null>;
  /**
   * Open the Add emoji dialog, and resolve to the name added, or `null` when
   * it was closed. Absent where this person cannot add one.
   */
  openAdd?(options: { query: string; tab: "upload" | "slackmojis" }): Promise<string | null>;
  /** Search Slackmojis. Absent where this person cannot add one. */
  searchSlackmojis?(query: string): Promise<readonly SlackmojiResult[]>;
  /** A Slackmojis picture, fetched by our server. */
  previewSlackmoji?(url: string): Promise<string | null>;
  /**
   * Copy a Slackmojis picture in as `:name:`. Without `exact`, a taken name
   * becomes `name-2` and so on, which is what the one-press menu row wants.
   */
  importSlackmoji?(
    result: SlackmojiResult,
    name: string,
    options?: { exact?: boolean; replace?: boolean },
  ): Promise<{ name: string } | { error: string }>;
}

export interface EmojiHostRef {
  current: EmojiHostContext | null;
}

export const emojiHost = Facet.define<EmojiHostRef, EmojiHostRef | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Tells the drawn note that the host's answers may have changed: an emoji was
 * added, renamed or removed, or the list arrived. Names drawn as text because
 * they were unknown are asked about again.
 */
export const emojiRefresh = StateEffect.define<null>();

/** The `imageHost` target a custom emoji is loaded under, over the native bridge too. */
export const EMOJI_IMAGE_TARGET = "emoji:";
