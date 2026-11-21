/**
 * A name's possessive, with the curly apostrophe: "Sayo’s", and "James’" for a
 * name that ends in s (Dev2, 2026-11-21: "it should be <name>’s Tex, watch out
 * for names that end in s").
 */
export function possessive(name: string): string {
  const trimmed = name.trim();
  return /s$/i.test(trimmed) ? `${trimmed}’` : `${trimmed}’s`;
}

/** The caret's label on somebody else's run: "Sayo’s Tex". */
export function texOf(name: string): string {
  return `${possessive(name)} Tex`;
}
