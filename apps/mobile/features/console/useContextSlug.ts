import { useLocalSearchParams } from "expo-router";
import { slugFromSegment } from "./nav";
import { selectedContext, type ConsoleData } from "./types";

/**
 * Which context this route is for, taken from the URL.
 *
 * The `@` belongs in the address bar and nowhere else, so it is stripped here
 * and the rest of the app deals in bare slugs. Falls back to whatever the
 * console has selected, which is what keeps a mid-navigation render from
 * briefly having no context at all.
 */
export function useContextSlug(data: ConsoleData): string | null {
  const params = useLocalSearchParams<{ slug?: string | string[] }>();
  const raw = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  if (raw !== undefined && raw !== "") return slugFromSegment(raw);
  return selectedContext(data)?.slug ?? null;
}
