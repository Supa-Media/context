/**
 * The Context icon the picker suggests for a folder or note from its name
 * (`contextIcons.cjs`; the picker opens on Context icons since the owner's
 * pick of 2026-10-21, so its Suggested comes from the hundred too).
 *
 * Two ways, cheapest first:
 *
 *  1. **A word of the name is one of an icon's words** (`Recipes` → Food,
 *     `taxes` → Receipt). No model, no wait, nothing metered.
 *  2. **Clef**, for a name no word list knows (`Biscuit`, `Q3 offsite`): which
 *     family most likely holds the icon (twelve options), then which icon in
 *     the two likeliest families (at most two dozen). Clef picks among
 *     options it is given and never writes, so every answer is in the set.
 *
 * Pure: the control plane asks, the tests need no model.
 */

import { CONTEXT_ICONS, CONTEXT_ICON_FAMILIES, CONTEXT_ICON_FAMILY_LABEL, contextIconMarker } from "./contextIcons.cjs";
import type { ContextIcon } from "./contextIcons.cjs";
import { nameSaysSomething, nameWords, topGroups, readPicks, type SuggestDecide, type SuggestRequest } from "./iconSuggest";

/** The Context icon one of the name's own words names, or `null`. */
export function contextIconByWords(path: string): ContextIcon | null {
  const words = nameWords(path)
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 2);
  for (const word of words) {
    const singular = word.endsWith("s") ? word.slice(0, -1) : word;
    for (const icon of CONTEXT_ICONS) {
      const own = icon.words.split(" ");
      if (own.includes(word) || own.includes(singular)) return icon;
    }
  }
  return null;
}

const kindOf = (path: string): "folder" | "note" => (path.toLowerCase().endsWith(".md") ? "note" : "folder");
const stateFor = (path: string) => `A ${kindOf(path)} in someone's notes is named "${nameWords(path)}".`;

/** The first question: which family holds the best icon? Each family is listed by its icons' labels. */
export function familyRequest(path: string): SuggestRequest {
  const criteria: Record<string, string> = {};
  CONTEXT_ICON_FAMILIES.forEach((family, index) => {
    const labels = CONTEXT_ICONS.filter((icon) => icon.family === family).map((icon) => icon.label.toLowerCase());
    criteria[`g${index}`] = `${CONTEXT_ICON_FAMILY_LABEL[family]}: ${labels.join(", ")}`;
  });
  return {
    state: stateFor(path),
    questions: {
      group: {
        type: "choice",
        instructions:
          `We want one icon for this ${kindOf(path)}. Each option is a group of icons. ` +
          "Choose the group that contains the one icon that would make the best icon, even if the rest of the group has nothing to do with the name.",
        criteria,
      },
    },
  };
}

/** The second question: which icon of those families? Each option is an icon's label and words. */
export function iconRequest(path: string, families: readonly number[]): SuggestRequest | null {
  const names = new Set(families.map((index) => CONTEXT_ICON_FAMILIES[index]).filter((family) => family !== undefined));
  const criteria: Record<string, string> = {};
  CONTEXT_ICONS.forEach((icon, index) => {
    if (names.has(icon.family)) criteria[`e${index}`] = `${icon.label}: ${icon.words}`;
  });
  if (Object.keys(criteria).length === 0) return null;
  return {
    state: stateFor(path),
    questions: {
      emoji: {
        type: "choice",
        instructions: `Which icon would make the best icon for this ${kindOf(path)}, judging by its name? Pick the closest, even if none is perfect.`,
        criteria,
      },
    },
  };
}

/** The stored spelling of the suggested Context icon for `path`, or `null` for none. */
export async function suggestContextIconFor(path: string, decide: SuggestDecide): Promise<string | null> {
  if (!nameSaysSomething(path)) return null;
  const known = contextIconByWords(path);
  if (known !== null) return contextIconMarker(known.name);
  // The engine now and then fails one request; asked once more, it answers.
  const ask = async (request: SuggestRequest) => (await decide(request)) ?? (await decide(request));
  const first = familyRequest(path);
  const families = topGroups(first, await ask(first), 2);
  const second = iconRequest(path, families);
  if (second === null) return null;
  const [pick] = readPicks(second, await ask(second));
  const icon = pick === undefined ? undefined : CONTEXT_ICONS[pick];
  return icon === undefined ? null : contextIconMarker(icon.name);
}
