import { directedTarget } from "./readings";

/** A target as a narrow column writes it: `under 800 ms` → `< 800 ms`, `at least 7` → `≥ 7`. */
export function shortTarget(target: string): string {
  const signs: ReadonlyArray<[RegExp, string]> = [
    [/^\s*(under|below|less than)\s+/i, "< "],
    [/^\s*at most\s+/i, "≤ "],
    [/^\s*(over|above|more than)\s+/i, "> "],
    [/^\s*at least\s+/i, "≥ "],
  ];
  const said = directedTarget(target);
  for (const [word, sign] of signs) if (word.test(said)) return said.replace(word, sign).trim();
  return target.trim();
}
