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
    route: "/admin/[...section]",
    file: "app/(app)/admin/[...section].tsx",
    reachable: false,
    reason:
      "The staff console at one of its tabs (`/admin/search/speed`). The same " +
      "page as `/admin`, which redirects here, and reached the same way: by the " +
      "address, or by the console's own tabs once there.",
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
    route: "/not-me",
    file: "app/not-me.tsx",
    reachable: false,
    reason:
      "The \"This wasn't me\" page, opened only from the link in a new-sign-in email. " +
      "The link carries a single-use token made for that one sign-in, so a control " +
      "in the app would have no token to put in it (`functions/signInAlerts.ts`).",
    marker: "from a new-sign-in email",
  },
  {
    route: "/stop-new-email",
    file: "app/stop-new-email.tsx",
    reachable: false,
    reason:
      "Stops a new email's seven-day wait, opened only from the link mailed to the " +
      "account's current emails. Its token exists only in that mail; inside the app " +
      "the same thing is Settings › Account's Stop it (`AccountSafetyCard`).",
    marker: "stop a new email's seven-day wait",
  },
  {
    route: "/connect/[provider]",
    file: "app/connect/[provider]/index.tsx",
    reachable: false,
    reason:
      "The URL a connector's provider (Slack, and later others) redirects back to, " +
      "registered with that provider. The app sends people out to the provider and " +
      "the provider sends them here with a code and a state; opening it from inside " +
      "the app would land on a callback without the browser-kept completion secret " +
      "that started the connection.",
    marker: "the URL a connector's provider",
  },
  {
    route: "/connect/[provider]/[token]",
    file: "app/connect/[provider]/[token].tsx",
    reachable: false,
    reason:
      "The private link Tex texts when it needs a provider connected for the person. " +
      "The token exists in that one text message, and the page opens only for the " +
      "signed-in person who asked for it.",
    marker: "the private link Tex texts when it needs a provider connected",
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
  {
    route: "/signin/[token]",
    file: "app/signin/[token].tsx",
    reachable: false,
    reason:
      "The sign-in link Tex texts once the notes of somebody set up by text " +
      "are ready. The token exists in that one text message and nowhere in " +
      "the app, and it signs in only the phone it was texted to.",
    marker: "the link Tex texts once a texted setup's notes are ready",
  },
  {
    route: "/texts/[token]",
    file: "app/texts/[token].tsx",
    reachable: false,
    reason:
      "The link the texting assistant sends a phone nobody has linked. The " +
      "token exists in that one text message and nowhere in the app, and the " +
      "page only means something to the person holding that phone.",
    marker: "the link the texting assistant sends a phone nobody has",
  },
  {
    route: "/text",
    file: "app/text.tsx",
    reachable: false,
    reason:
      "Where somebody signed in on tex.lc lands: Tex's number to text, and the console under it. " +
      "Reached from tex.lc's sign-up and sign-in, never from the app.",
    marker: "tex.lc's page for somebody signed in",
  },
  {
    route: "/add-gmail",
    file: "app/(app)/add-gmail.tsx",
    reachable: false,
    reason:
      "The link Tex texts for another Gmail. It exists in that text message; in the app the same " +
      "connect is Settings › Connected apps.",
    marker: "the link Tex texts for another Gmail",
  },
  {
    route: "/waitlist",
    file: "app/waitlist.tsx",
    reachable: false,
    reason:
      "Where somebody who joined Tex's waitlist on tex.lc stands, read with the receipt their browser " +
      "was handed at joining: reached from tex.lc's landing and sign-up, never from the app.",
    marker: "where somebody who joined the waitlist stands",
  },
  {
    route: "/vault/[token]",
    file: "app/vault/[token].tsx",
    reachable: false,
    reason:
      "The private link Tex texts when it needs a login saved or shared. The " +
      "token exists in that one text message, and the page opens only for the " +
      "signed-in person who asked for it.",
    marker: "the private link Tex texts when it needs a login",
  },
  {
    route: "/tex/[handle]",
    file: "app/tex/[handle].tsx",
    reachable: false,
    reason:
      "The person's own view of the browser Tex drives for them. Tex texts " +
      "the address when they must sign in somewhere, and the page opens only " +
      "for the signed-in owner of that handle.",
    marker: "the page Tex texts when they have to sign in somewhere",
  },
];
