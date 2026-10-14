import type { RouteReachability } from "./reachability";

/**
 * The console's app-level panes — Connections, Search, @shared and Map — and
 * what reaches each, split out of `reachability.ts` to keep that file under
 * the size limit. Spread back into `ROUTE_REACHABILITY` in route order, so the
 * guard (`__tests__/routeReachability.test.ts`) reads one list as before.
 *
 * The density lists and file names are restated rather than imported: this
 * module is imported by `reachability.ts`, and a value import back from it
 * would read those constants before they exist.
 */

const EVERY_DENSITY = ["compact", "medium", "wide"] as const;
const POINTER = ["medium", "wide"] as const;
const PHONE = ["compact"] as const;
/** The console frame, which turns a menu press into a route. */
const CONSOLE_LAYOUT = "features/console/ConsoleFrame.tsx";
const CONSOLE_PALETTE = "features/console/layout/palette.tsx";

export const APP_PANE_REACHABILITY: readonly RouteReachability[] = [
  {
    route: "/console/connections",
    file: "app/(app)/console/connections.tsx",
    reachable: false,
    reason:
      "No door, by decision, and the same decision as the map's below. Its only " +
      'one was "Manage sharing…" on a context\'s right-click menu — a row that ' +
      "answered a per-context question by navigating out of the context, which " +
      "is what the owner asked be taken off the menu. Everything on the pane has " +
      "a home inside settings already, from the same components rather than a " +
      "copy: `MembersSection` under Settings → People, and the endpoint with the " +
      "connected AI apps under Settings → AI apps (`settings/AccountSections.tsx`). " +
      "So this is a duplicate surface losing its last entry, not a capability " +
      "leaving the product. The route and the pane are untouched and still " +
      "render: one entry point brings it back.",
    marker: "Reachable from nowhere, deliberately",
  },
  {
    route: "/console/search",
    file: "app/(app)/console/search.tsx",
    reachable: true,
    from: [
      {
        /*
          The handoff out of the palette, and the reason the page exists in the
          shape it does. The overlay is on every density — ⌘K on a pointer, the
          bottom toolbar's search key on a phone — so this claim is too, and it
          is the entry point somebody actually uses: they search, see ten rows,
          and want the rest.

          `See all results` is a row in the palette's own list rather than a
          button in its chrome, which is what makes it reachable by the keyboard
          as well as by a thumb. `Palette.tsx` is named as the control because
          that is where the row is built; the layout is named as the navigation
          because that is where the press becomes a URL.
        */
        surface:
          "“See all results”, the last row of the console's search palette",
        control: {
          file: "features/design/components/Palette.tsx",
          contains: ["seeAllItem", "onSeeAll?.(query)"],
        },
        navigation: [
          {
            file: CONSOLE_PALETTE,
            contains: ["router.push(searchHref("],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
  {
    route: "/console/shared",
    file: "app/(app)/console/shared.tsx",
    reachable: true,
    from: [
      {
        /*
          @shared (Dev2, 2026-10-14, board A): a row under your workspaces in
          the account menu, which is the one menu every density has. The sheet
          on a phone and the card on a pointer layout draw the same rows.
        */
        surface: "@shared, under your workspaces in the account sheet",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-shared"', "shared?.onOpen()", 'trigger === "phone"'],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["router.push(SHARED_HREF)"],
          },
        ],
        region: "account",
        densities: PHONE,
      },
      {
        surface: "@shared, under your workspaces in the switcher's menu",
        control: {
          file: "features/console/SwitcherMenu.tsx",
          contains: ['testID: "switcher-shared"', "shared?.onOpen()"],
        },
        navigation: [
          {
            file: CONSOLE_LAYOUT,
            contains: ["router.push(SHARED_HREF)"],
          },
        ],
        region: "switcher",
        densities: POINTER,
      },
    ],
  },
  {
    route: "/console/map",
    file: "app/(app)/console/map.tsx",
    reachable: false,
    reason:
      'No door, by decision. Its only one was the "Elsewhere in the console" ' +
      "card at the foot of settings — three destinations repeated under all " +
      "nineteen sections, drawn unconditionally *because* removing it from any " +
      "one section removed the map from the product. That is a fire escape on " +
      "every floor rather than a place in the navigation, and the owner's answer " +
      "when it was put to them was that the map can vanish. It had already lost " +
      "its rail row (`SwitcherMenu.tsx` carries the reason: Map and Connections " +
      "are facts " +
      "about a context rather than places inside one) and a phone has no left " +
      "panel at all, so there was nowhere left that it belonged. The route and " +
      "the pane are untouched and still render: this is a navigation decision, " +
      "not a deletion, and giving the map a home again is a door away.",
    marker: "Reachable from nowhere, deliberately",
  },
];
