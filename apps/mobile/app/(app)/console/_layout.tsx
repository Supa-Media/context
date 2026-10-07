import { useRef } from "react";
import { Slot, useRouter, usePathname } from "expo-router";
import { Avatar } from "../../../features/console/AccountBlock";
import { ConsoleFrame } from "../../../features/console/ConsoleFrame";
import { routeForPath } from "../../../features/console/nav";
import { useLiveConsoleData } from "../../../features/console/useLiveConsoleData";
/*
  The layout's pieces live in `features/console/`, not beside this file: every
  file under `app/` is a route to Expo Router, so a module placed here would be
  one. The frame itself is `ConsoleFrame`, which the homepage renders too.
*/
import {
  useConsoleParams,
  useContextRouteResolution,
  useQuickNoteAction,
} from "../../../features/console/layout/routeCommands";

/**
 * The console, as an application rather than a page.
 *
 * ## What this used to be
 *
 * A `ScrollView` containing a decorative backdrop containing a 1200px centred
 * wrap, with a "Context.lc / Sign out" header above it and a "Free. You bring
 * the bucket · MIT · self-hostable" footer below. That is landing-page
 * furniture, and wrapping a working tool in it produced exactly what it looks
 * like: a card floating in a marketing page, with the file tree scrolling
 * inside a fixed 432px box inside a document that also scrolled.
 *
 * Now the frame owns the viewport and the regions scroll individually. The
 * wordmark and the footer are gone — a header whose only job is to hold a
 * sign-out button is a header you can delete, and the identity moved to the
 * foot of the rail where every application puts it.
 *
 * The landing page still mounts `ConsoleShell` with its fake window chrome,
 * and should: there the console is a *picture* of the product.
 *
 * ## Why the explorer is mounted here and not in the pane
 *
 * The file tree is a region of the frame, not content inside Browse. Mounting
 * it here is what lets it be a resizable column on a desktop and a drawer on a
 * phone without Browse knowing which. It is passed only for routes that have a
 * tree: Map and Connections are app-level panes spanning every context, and
 * `AppFrame` draws no column and no drawer button when the slot is absent.
 *
 * The layout still owns the Convex subscriptions and the URL-is-the-truth rule
 * for which context you are in — both unchanged.
 */
export default function ConsoleLayout() {
  const data = useLiveConsoleData();
  const router = useRouter();
  const pathname = usePathname();
  const route = routeForPath(pathname);
  const { quickParams, openSettingsSection, checkoutReturn, connectAgent, changesOpen, mapOpen } = useConsoleParams();
  const handledQuickNote = useRef(false);
  /*
    What only a real console address has: which context the URL names, applied,
    and the quick note it may carry. The homepage has neither — its address is
    `/?page=` — so these stay here rather than in the frame they share.
  */
  const cleanQuickNoteHref = useContextRouteResolution({ route, data, router, pathname });
  useQuickNoteAction({ quickParams, handledQuickNote, data, cleanQuickNoteHref, router });

  return (
    <ConsoleFrame
      data={data}
      route={route}
      pathname={pathname}
      router={router}
      params={{ openSettingsSection, checkoutReturn, connectAgent, changesOpen, mapOpen }}
    >
      <Slot />
    </ConsoleFrame>
  );
}

export { Avatar };
