import { useCallback } from "react";
import { useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { densityFor } from "../../../features/app/frame";
import { useConsoleData } from "../../../features/console/ConsoleDataContext";
import { CONSOLE_ROOT } from "../../../features/console/nav";
import { ownWorkspace } from "../../../features/console/rail";
import { SharedPane, meLabel } from "../../../features/console/shared/SharedPane";
import { SHARED_HREF, sharedNoteHref } from "../../../features/console/shared/sharedInbox";

/**
 * `/console/shared` — @shared, everything people shared with you by name
 * (Dev2, 2026-10-14, board A2), and `?note=<token>` for one of them open in
 * place (board A3). Reached from the @shared row in the account menu, on
 * every density; see `features/app/reachability.ts`.
 */
export default function SharedRoute() {
  const router = useRouter();
  const data = useConsoleData();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ note?: string }>();
  const note = typeof params.note === "string" && params.note !== "" ? params.note : null;
  const onOpen = useCallback((token: string) => router.push(sharedNoteHref(token)), [router]);
  const onList = useCallback(() => router.push(SHARED_HREF), [router]);
  // Search's way out, for Search's reason: a phone has no sidebar behind this page.
  const onBack = useCallback(() => router.replace(CONSOLE_ROOT), [router]);
  const onGo = useCallback((href: string) => router.push(href), [router]);
  return (
    <SharedPane
      note={note}
      phone={densityFor(width) === "compact"}
      me={meLabel(ownWorkspace(data.contexts)?.slug)}
      onOpen={onOpen}
      onList={onList}
      onBack={onBack}
      onGo={onGo}
    />
  );
}
