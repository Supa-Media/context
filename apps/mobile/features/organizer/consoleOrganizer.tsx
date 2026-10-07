import { useMemo } from "react";
import type { ToastSpec } from "../design/components/Toast";
import type { ConsoleRouter } from "../console/layout/types";
import { changesCount } from "./rules";
import { ORGANIZER_TOAST_PREFIX, type OrganizerView } from "./useOrganizer";

/**
 * Auto-organize's pieces of the console layout: the routed view it hands
 * down, and the toasts it shares with the file browser.
 *
 * The view itself comes from `useLiveConsoleData` (`data.organizer`), the
 * one place the layout reaches the control plane; absent on the demo and in
 * every harness that mocks that hook, and then nothing here draws anything.
 */
export function useConsoleOrganizer(
  organizer: OrganizerView | undefined,
  router: ConsoleRouter,
  changesOpen = false,
): OrganizerView | undefined {
  return useMemo(
    () => (organizer === undefined ? undefined : routeOrganizer(organizer, router, changesOpen)),
    [organizer, router, changesOpen],
  );
}

/**
 * Settings and What changed are query parameters: Show me closes Settings
 * and opens What changed on its Tidy up tab, and What changed rides beside
 * the open note as `?changes=1` so Back and a shared link both find it.
 */
export function routeOrganizer(
  organizer: OrganizerView,
  router: Pick<ConsoleRouter, "setParams">,
  changesOpen = false,
): OrganizerView {
  return {
    ...organizer,
    // Every "look over the suggestions" is What changed, on its Tidy up tab.
    openReview: () => {
      organizer.openReview();
      router.setParams({ changes: "1", settings: undefined });
    },
    openSettings: () => router.setParams({ settings: "premium" }),
    pageOpen: changesOpen && changesCount(organizer.status) !== null,
    openPage: () => router.setParams({ changes: "1", settings: undefined }),
    closePage: () => router.setParams({ changes: undefined }),
  };
}

/**
 * One host for every toast, so two never stack in two places. A dismiss goes
 * back to whichever list the toast came from.
 */
export function consoleToasts(
  files: { toasts: readonly ToastSpec[]; dismissToast: (id: string) => void },
  organizer: OrganizerView | undefined,
): { toasts: readonly ToastSpec[]; onDismiss: (id: string) => void } {
  if (organizer === undefined || organizer.toasts.length === 0) {
    return { toasts: files.toasts, onDismiss: files.dismissToast };
  }
  return {
    toasts: [...files.toasts, ...organizer.toasts],
    onDismiss: (id) =>
      id.startsWith(ORGANIZER_TOAST_PREFIX) ? organizer.dismissToast(id) : files.dismissToast(id),
  };
}
