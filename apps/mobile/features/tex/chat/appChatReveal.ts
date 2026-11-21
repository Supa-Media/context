import { useEffect, useState } from "react";
import { useReducedMotion } from "../../design/useReducedMotion";

/** How long each word takes to type in, in milliseconds: the mock's 22 ms. */
export const REVEAL_MS_PER_WORD = 22;

/** A text cut into its words, each with the whitespace after it: `"a  b c"` → `["a  ", "b ", "c"]`. */
export function revealChunks(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

/**
 * How many words are showing `elapsedMs` into a reveal of `words` words: the
 * first word is there at once, and one more every `REVEAL_MS_PER_WORD`.
 */
export function revealedWords(words: number, elapsedMs: number): number {
  if (words <= 0) return 0;
  if (!(elapsedMs > 0)) return 1;
  return Math.min(words, Math.floor(elapsedMs / REVEAL_MS_PER_WORD) + 1);
}

/** The text as it reads `elapsedMs` into its reveal; the whole text once every word is showing. */
export function revealedText(text: string, elapsedMs: number): string {
  const chunks = revealChunks(text);
  const shown = revealedWords(chunks.length, elapsedMs);
  if (shown >= chunks.length) return text;
  return chunks.slice(0, shown).join("");
}

/**
 * The text a row shows while it types in. Whole at once when `reveal` is off
 * or the viewer has asked for reduced motion; otherwise it grows one word per
 * `REVEAL_MS_PER_WORD` from the moment the row mounts.
 */
export function useRevealedText(text: string, reveal: boolean): string {
  const reduced = useReducedMotion();
  const active = reveal && !reduced;
  const words = revealChunks(text).length;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const now = Date.now() - started;
      setElapsed(now);
      if (revealedWords(words, now) < words) timer = setTimeout(step, REVEAL_MS_PER_WORD);
    };
    step();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [active, words]);

  return active ? revealedText(text, elapsed) : text;
}
