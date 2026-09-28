import { useMemo } from "react";
import type { ToastSpec } from "../design/components/Toast";
import type { ConsoleRouter } from "../console/layout/types";
import { ReviewSheet } from "./Review";
import { ORGANIZER_TOAST_PREFIX, type OrganizerView } from "./useOrganizer";

/**
 * Auto-organize's pieces of the console layout: the routed view it hands
 * down, the phone's review sheet, and the toasts it shares with the file
 * browser.
 *
 * The view itself comes from `useLiveConsoleData` (`data.organizer`), the
 * one place the layout reaches the control plane; absent on the demo and in
 * every harness that mocks that hook, and then nothing here draws anything.
 */
export function useConsoleOrganizer(
  organizer: OrganizerView | undefined,
  router: ConsoleRouter,
): OrganizerView | undefined {
  return useMemo(() => (organizer === undefined ? undefined : routeOrganizer(organizer, router)), [organizer, router]);
}

/** Settings is a query parameter: Show me closes it over the list, the list's foot opens it. */
export function routeOrganizer(
  organizer: OrganizerView,
  router: Pick<ConsoleRouter, "setParams">,
): OrganizerView {
  return {
    ...organizer,
    openReview: (options) => {
      organizer.openReview();
      if (options?.closeSettings) router.setParams({ settings: undefined });
    },
    openSettings: () => router.setParams({ settings: "premium" }),
  };
}

/** The phone has no explorer foot, so the list is a sheet — RecentSheet's frame. */
export function consoleReviewSheet({
  organizer,
  phone,
  browsing,
}: {
  organizer: OrganizerView | undefined;
  phone: boolean;
  browsing: boolean;
}) {
  return organizer?.reviewOpen && phone && browsing ? <ReviewSheet organizer={organizer} /> : null;
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
