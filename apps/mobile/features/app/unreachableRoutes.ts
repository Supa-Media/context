import type { RouteReachability } from "./reachability";

/**
 * Routes that are deliberately not reachable from any control in the app, and
 * why. Part of `ROUTE_REACHABILITY` (spread into it there); kept in its own
 * file so the registry stays under the size limit. Each is a URL something
 * outside the app hands a person — a typed address, a provider's redirect, a
 * link in an email — so a control leading here would have nothing to put in it.
 */
export const DELIBERATELY_UNREACHABLE: readonly RouteReachability[] = [
  {
    route: "/admin",
    file: "app/(app)/admin/index.tsx",
    reachable: false,
    reason:
      "The staff console. It is platform-wide rather than about any one context, " +
      "so it is in no switcher and no strip — putting it there would imply it " +
      "belongs to whichever workspace is selected — and everyone gets the same URL " +
      "while `requireAdmin` on the server decides what it renders. It is reached " +
      "by typing the address, on purpose.",
    marker: "Reached by typing the address",
  },
  {
    route: "/authorize",
    file: "app/authorize.tsx",
    reachable: false,
    reason:
      "The OAuth consent screen, arrived at from an AI client's own browser " +
      "redirect carrying a `request_id` that exists for about a minute and " +
      "nowhere else. There is nothing in the app that could reproduce one, so a " +
      "control leading here would lead to a screen with nothing to consent to.",
    marker: "the OAuth consent screen",
  },
  {
    route: "/e2e-fixture",
    file: "app/e2e-fixture.tsx",
    reachable: false,
    reason:
      "The editable demo console `apps/mobile/e2e/webkit`'s Playwright suite drives. " +
      "It renders only when a build set EXPO_PUBLIC_E2E_FIXTURE at export time, which " +
      "no real export does — every ordinary build redirects it to `/` — so there is " +
      "nothing in the product for a control to lead to.",
    marker: "Only the `Editor in WebKit` CI job",
  },
  {
    route: "/connect/dropbox",
    file: "app/connect/dropbox.tsx",
    reachable: false,
    reason:
      "The URL Dropbox redirects back to, registered with Dropbox and matched " +
      "exactly. The app sends people out to Dropbox and Dropbox sends them here " +
      "with a code and a state that exist for about a minute; opening it from " +
      "inside the app would land on a callback with nothing to hand back.",
    marker: "the URL Dropbox redirects back to",
  },
  {
    route: "/connect/google",
    file: "app/connect/google.tsx",
    reachable: false,
    reason:
      "The URL Google redirects back to, registered with Google Cloud and matched " +
      "exactly. The app sends people out to Google and Google sends them here with " +
      "a code and a state; opening it from inside the app would land on a callback " +
      "without the browser-kept completion secret that started the flow.",
    marker: "the URL Google redirects back to",
  },
  {
    route: "/connect/cli",
    file: "app/connect/cli.tsx",
    reachable: false,
    reason:
      "Where the CLI's loopback sign-in page sends the browser once a sign-in is " +
      "approved or refused. Nothing in the app leads here; opening it directly " +
      "shows a result for a sign-in that is not happening.",
    marker: "sends the browser",
  },
  {
    route: "/join/[token]",
    file: "app/(auth)/join/[token].tsx",
    reachable: false,
    reason:
      "The link in a friend's invite email. The token exists in that email and " +
      "nowhere else, so nothing in the app could reproduce one. Somebody without " +
      "a link signs in or joins the waitlist at `/login`, which is reachable.",
    marker: "the link in a friend's invite email",
  },
];
