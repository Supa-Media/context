/**
 * Whose Anthropic key a Lab or eval run asks to pay first (Dev2, 2026-11-26: "use seguns key"): a key
 * `packages/tex/src/aiKeys.json` lists, named by alias, id or owner. The workflow puts it ahead of that file's order
 * for the run's use, so a key that cannot pay falls back to the rest.
 */
import { AI_KEYS, findKey } from "@context/tex/src/aiKeys.cjs";

/** The alias of the key named; null when none was; undefined when no listed key has that name. */
export function keyOf(x: unknown): string | null | undefined {
  if (x === undefined || x === null || x === "") return null;
  return findKey(x)?.alias ?? undefined;
}

export const KEY_WORDS = `key names one of ${AI_KEYS.map((k) => `${k.owner} (${k.alias})`).join(", ")} from packages/tex/src/aiKeys.json, or is unset for that file's order`;
