/**
 * What the checker said about one word. `suggestions` is empty for a word it
 * accepts, and may be empty for one it flags but cannot place.
 */
export interface SpellingCheck {
  misspelled: boolean;
  suggestions: string[];
}
