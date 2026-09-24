import { useEffect } from "react";
import { checkoutOutcomeFrom } from "@context/shared";
import {
  useOptionalGlobalSearchParams,
  useOptionalLocalSearchParams,
} from "../../app/useOptionalLocalSearchParams";
import { resolveContextRoute, settingsFromQuery, type ConsoleRoute } from "../nav";
import type { ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";

/**
 * The query parameters the console acts on: a quick action, the open settings
 * section, and what Stripe's return said. Both reads are the layout's own,
 * lifted out whole and in order.
 */
export function useConsoleParams() {
  const quickParams = useOptionalLocalSearchParams<{ quickAction?: string | string[] }>();
  /*
    Settings rides in the query beside `?note=`, so Browse stays mounted under
    the scrim and the note keeps its address. Global rather than local params:
    this layout is above the `[slug]` route that owns them, and reading the
    local ones here returns nothing.
  */
  const settingsParams = useOptionalGlobalSearchParams<{
    settings?: string | string[];
    checkout?: string | string[];
  }>();
  const openSettingsSection = settingsFromQuery(settingsParams.settings);
  /*
    Where Stripe put them. `?checkout=done` says the payment page handed the
    browser back — which is a different fact from "the plan is active", because
    the webhook that decides that may not have landed yet. Read here with every
    other parameter this console acts on, and carried to the one panel that has
    anything to say about the gap. Anything we did not write is nothing.
  */
  const rawCheckout = settingsParams.checkout;
  const checkoutReturn = checkoutOutcomeFrom(
    Array.isArray(rawCheckout) ? rawCheckout[0] : rawCheckout,
  );
  return { quickParams, openSettingsSection, checkoutReturn };
}

/**
 * Which context the URL says you are in, applied — and the address a quick
 * note cleans itself back to. Lifted out of the console layout whole, so the
 * effect runs where it always ran.
 */
export function useContextRouteResolution({
  route,
  data,
  router,
  pathname,
}: {
  route: ConsoleRoute;
  data: ConsoleData;
  router: ConsoleRouter;
  pathname: string;
}): string {
  const resolution = resolveContextRoute({
    route,
    contexts: data.contexts,
    selectedContextId: data.selectedContextId,
    loading: data.loading,
    // `undefined` while the query is in flight, which reads as "nobody told
    // me" rather than "there are none" — so a slow list never sends an invited
    // person to the map before their invitation has arrived.
    invitations: data.invitations,
  });
  const cleanQuickNoteHref =
    resolution.action === "redirect" ? resolution.href : pathname;

  const { selectContext } = data;
  useEffect(() => {
    if (resolution.action === "select") selectContext(resolution.contextId);
    if (resolution.action === "redirect") router.replace(resolution.href);
    // `resolution` is derived and stable enough to compare by its parts; the
    // action and its payload are the only things that should retrigger this.
  }, [
    resolution.action,
    resolution.action === "select" ? resolution.contextId : null,
    resolution.action === "redirect" ? resolution.href : null,
    router,
    selectContext,
  ]);
  return cleanQuickNoteHref;
}

/**
 * `?quickAction=note`, acted on once. The ref is the layout's own, created
 * where it always was, so this hook adds nothing to the order the layout's
 * hooks run in.
 */
export function useQuickNoteAction({
  quickParams,
  handledQuickNote,
  data,
  cleanQuickNoteHref,
  router,
}: {
  quickParams: { quickAction?: string | string[] };
  handledQuickNote: { current: boolean };
  data: ConsoleData;
  cleanQuickNoteHref: string;
  router: ConsoleRouter;
}): void {
  useEffect(() => {
    if (
      quickParams.quickAction !== "note" ||
      handledQuickNote.current ||
      data.loading ||
      !data.files.canEdit
    ) return;
    handledQuickNote.current = true;
    // Remove the command from this history entry before acting on it, so a
    // remount or a trip back through history cannot replay it.
    router.replace(cleanQuickNoteHref);
    /*
      Makes the note rather than raising a prompt for its name. The whole point
      of a quick-note link is that it is one press from wherever somebody was,
      and a modal asking what to call a note nobody has written yet is the
      opposite of that. `untitled.ts` has the name it gets and how it loses it.
    */
    data.files.createUntitled("0-inbox", "note");
    // The list is the layout's, unchanged: `handledQuickNote` is its `useRef`,
    // stable by construction, which the rule cannot see through a parameter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data.files,
    data.loading,
    cleanQuickNoteHref,
    quickParams.quickAction,
    router,
  ]);
}
