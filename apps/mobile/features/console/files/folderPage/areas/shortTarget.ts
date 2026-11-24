/** A target as a narrow column writes it: `under 800 ms` → `< 800 ms`, `at least 7` → `≥ 7`. */
export function shortTarget(target: string): string {
  const signs: ReadonlyArray<[RegExp, string]> = [
    [/^\s*(under|below|less than)\s+/i, "< "],
    [/^\s*at most\s+/i, "≤ "],
    [/^\s*(over|above|more than)\s+/i, "> "],
    [/^\s*at least\s+/i, "≥ "],
  ];
  for (const [word, sign] of signs) if (word.test(target)) return target.replace(word, sign).trim();
  return target.trim();
}
