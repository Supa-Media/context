/**
 * Home's "Needs you" (the artifact's `needsList`): every line also counts on the sidebar row of the
 * page it opens, so the shell asks for it on every page. Thread "Build console Home, Growth and
 * Usage" fills it from the staff-only needs query; until then nothing needs you.
 */
import type { Need } from "../types";

export function useNeeds(): Need[] {
  return [];
}
