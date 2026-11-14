import type { PaletteItem } from "../../console/files/palette";

/**
 * Report a row the search returned being opened, at its 1-based place in the list shown (the search
 * quality log, `apps/convex/functions/searchTimings.ts`). A row the search did not return, such as a
 * loaded name match, is not reported.
 */
export function reportSearchOpen(
  onSearchOpen: ((item: PaletteItem, position: number) => void) | undefined,
  hits: readonly PaletteItem[] | undefined,
  matches: readonly { item: PaletteItem }[],
  item: PaletteItem,
): void {
  if (onSearchOpen === undefined || !hits?.some((hit) => hit.kind === item.kind && hit.id === item.id)) return;
  const at = matches.findIndex((match) => match.item.kind === item.kind && match.item.id === item.id);
  if (at >= 0) onSearchOpen(item, at + 1);
}
