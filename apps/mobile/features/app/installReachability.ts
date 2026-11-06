import type { RouteReachability } from "./reachability";

/**
 * `/download`, the install page, and what reaches it: split out of
 * `reachability.ts` to keep that file under the size limit, and spread back
 * into `ROUTE_REACHABILITY` so the guard reads one list.
 *
 * Its way in from the app is the Tex page's "Connect a machine" screen. It is
 * also where people are sent from outside the app (a shared link, Tex's
 * reply), which the guard does not count and does not need to.
 */
const EVERY_DENSITY = ["compact", "medium", "wide"] as const;

export const INSTALL_REACHABILITY: readonly RouteReachability[] = [
  {
    route: "/download",
    file: "app/download.tsx",
    reachable: true,
    from: [
      {
        surface: "the \"Every step, and instructions for your agent\" link on the Tex page's Connect a machine screen",
        control: {
          file: "features/tex/page/TexConnectPage.tsx",
          contains: ['testID="tex-connect-guide"', "href={GUIDE_HREF}"],
        },
        navigation: [
          {
            file: "features/tex/page/TexConnectPage.tsx",
            contains: ["<Link", 'const GUIDE_HREF = "/download?tab=headless"'],
          },
        ],
        region: "screen",
        densities: EVERY_DENSITY,
      },
    ],
  },
];
