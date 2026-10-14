import { useCallback } from "react";
import { useRouter } from "expo-router";
import { SharedPane } from "../../../features/console/shared/SharedPane";
import { sharedOpenHref } from "../../../features/console/shared/sharedInbox";
import { CONSOLE_ROOT } from "../../../features/console/nav";

/**
 * `/console/shared` — @shared, everything people shared with you by name
 * (Dev2, 2026-10-14). Reached from the @shared row in the account menu, on
 * every density; see `features/app/reachability.ts`.
 */
export default function SharedRoute() {
  const router = useRouter();
  const onOpen = useCallback((token: string) => router.push(sharedOpenHref(token)), [router]);
  // Search's way out, for Search's reason: a phone has no rail behind this page.
  const onClose = useCallback(() => router.replace(CONSOLE_ROOT), [router]);
  return <SharedPane onOpen={onOpen} onClose={onClose} />;
}
