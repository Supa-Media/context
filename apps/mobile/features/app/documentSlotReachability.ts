import type { RouteEntryPoint } from "./reachability";

/**
 * The pages that open in the console's document slot over Browse as a query
 * parameter on `/console/[slug]` — the live map (`?map=1`), Mail (`?mail=1`)
 * and Trash (`?trash=1`) — and what reaches each, split out of
 * `reachability.ts` to keep that file under the size limit. Spread back into
 * that route's `from` list, so the guard (`__tests__/routeReachability.test.ts`)
 * reads one list as before.
 *
 * The density lists are restated rather than imported, as in
 * `appPaneReachability.ts`: this module is imported by `reachability.ts`.
 */

const POINTER = ["medium", "wide"] as const;
const PHONE = ["compact"] as const;

export const DOCUMENT_SLOT_ENTRIES: readonly RouteEntryPoint[] = [
  /*
    The live map is not a route of its own: it is `?map=1` on this page, a
    page in the document slot over Browse. So its two ways in are claims
    about this route, and its
    navigation is `router.setParams` on the route it is already on.
  */
  {
    surface: "the live map, from the Map button in the sidebar's top row",
    control: {
      file: "features/console/files/explorer/ExplorerToolbar.tsx",
      contains: ['testID="explorer-map"', "onPress={mapRoute.toggle}"],
    },
    navigation: [
      {
        file: "features/console/map/live/route.ts",
        contains: [
          'router.setParams({ map: "1", settings: undefined, trash: undefined, vault: undefined, mail: undefined })',
        ],
      },
    ],
    region: "screen",
    densities: POINTER,
  },
  /*
    The Mail page is `?mail=1` on this page, in the document slot, as the
    Trash page is (`mailPage/MailRouteContext.tsx`): the Mail button under
    the map on the right rail (the owner's boards, 2026-11-25), and on a
    phone, which has no rail, a row of the @name menu beside the Vault.
  */
  {
    surface:
      "the Mail page, from the Mail button under the map on the right rail",
    control: {
      file: "features/console/aside/AsideStrip.tsx",
      contains: ['testID="aside-strip-mail"', "onPress={mailRoute.toggle}"],
    },
    navigation: [
      {
        file: "features/console/mailPage/MailRouteContext.tsx",
        contains: [
          'router.setParams({ mail: "1", map: undefined, trash: undefined, settings: undefined, vault: undefined })',
        ],
      },
    ],
    region: "screen",
    densities: POINTER,
  },
  {
    surface: "the Mail page, from Mail in the @name menu on a phone",
    control: {
      file: "features/console/SwitcherMenu.tsx",
      contains: [
        'trigger === "phone"',
        "phone && mail !== undefined",
        'else if (id === "mail") mail?.openMail();',
      ],
    },
    navigation: [
      {
        file: "features/console/mailPage/MailRouteContext.tsx",
        contains: [
          'router.setParams({ mail: "1", map: undefined, trash: undefined, settings: undefined, vault: undefined })',
        ],
      },
    ],
    region: "account",
    densities: PHONE,
  },
  /*
    The Trash page is `?trash=1` on this page, in the document slot, as
    the map is (`trash/TrashRouteContext.tsx`): a row of the account card
    on a pointer layout (the tree's foot until Dev2, 2026-10-18), and on a phone a row of the @name menu on Inbox,
    since Folders left its Trash line off for board 2 (2026-10-17).
  */
  {
    surface: "the Trash page, from Trash in the account card",
    control: {
      file: "features/console/SwitcherMenu.tsx",
      contains: [
        "(phoneNamed || !phone) && trash !== undefined",
        'else if (id === "trash") trash?.openTrash();',
      ],
    },
    navigation: [
      {
        file: "features/console/trash/TrashRouteContext.tsx",
        contains: [
          'router.setParams({ trash: "1", map: undefined, settings: undefined, vault: undefined, mail: undefined })',
        ],
      },
    ],
    region: "switcher",
    densities: POINTER,
  },
  {
    surface: "the Trash page, from Trash in the @name menu on a phone's Inbox",
    control: {
      file: "features/console/SwitcherMenu.tsx",
      contains: [
        'trigger === "phone"',
        'testID: "switcher-trash"',
        'else if (id === "trash") trash?.openTrash();',
      ],
    },
    navigation: [
      {
        file: "features/console/trash/TrashRouteContext.tsx",
        contains: [
          'router.setParams({ trash: "1", map: undefined, settings: undefined, vault: undefined, mail: undefined })',
        ],
      },
    ],
    region: "account",
    densities: PHONE,
  },
];
