/**
 * The open workspace's emoji, as React context. Its own module so the editor
 * can read it without importing the provider's server calls and dialog.
 */

import { createContext, useContext } from "react";

import type { EmojiHostContext } from "../files/emoji/host";

/** What the provider offers: the editor's host, plus what settings needs. */
export interface CustomEmojiValue extends EmojiHostContext {
  /** Bumped whenever the list changed, so a drawn note asks again. */
  readonly generation: number;
  readonly names: readonly string[] | null;
  readonly canEdit: boolean;
  rename(from: string, to: string): Promise<string | null>;
  remove(name: string): Promise<string | null>;
}

export const CustomEmojiContext = createContext<CustomEmojiValue | null>(null);

export function useCustomEmoji(): CustomEmojiValue | null {
  return useContext(CustomEmojiContext);
}

