/**
 * The staff console's place, read from the address and written back to it.
 *
 * The route hands this its params; `AdminPane` gets the place and the window
 * and two ways to change them. A new place is a push — a Back step — and a new
 * window is a `setParams`, which replaces the address: the window is a filter
 * on the page, not somewhere you went. See `./place` for the addresses and
 * `./placeRouter` for why a push here does not mount a second console.
 */

import { useRouter } from "expo-router";
import { DEFAULT_PLACE, adminPath, parseAdminPlace, parseWindow, sectionSegments, type AdminPlace } from "./place";
import { DEFAULT_WINDOW } from "./report";

export type AdminPlaceControl = {
  place: AdminPlace;
  /** A push (a Back step) unless `replace`. */
  onPlace: (place: AdminPlace, how?: { replace?: boolean }) => void;
  days: number;
  onDays: (days: number) => void;
};

/**
 * `invalid` is the address to send an unrecognised one to: the tab's own
 * default when the tab is real (`/admin/search/nope` → `/admin/search`), the
 * console's front door otherwise.
 */
export function useAdminPlace(params: {
  section?: string | string[];
  days?: string | string[];
}): AdminPlaceControl & { invalid: string | null } {
  const router = useRouter();
  const segments = sectionSegments(params.section);
  const parsed = parseAdminPlace(segments);
  const days = parseWindow(params.days);
  const query = days === DEFAULT_WINDOW ? "" : `?days=${days}`;

  let invalid: string | null = null;
  if (parsed === null) {
    const tabOnly = parseAdminPlace(segments.slice(0, 1));
    invalid = adminPath(tabOnly ?? DEFAULT_PLACE) + query;
  }

  return {
    place: parsed ?? DEFAULT_PLACE,
    onPlace: (place, how) =>
      how?.replace ? router.replace(adminPath(place) + query) : router.push(adminPath(place) + query),
    days,
    onDays: (next) => router.setParams({ days: next === DEFAULT_WINDOW ? undefined : String(next) }),
    invalid,
  };
}
