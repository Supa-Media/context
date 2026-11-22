// Every emulator Context can stand up, and the real hosts each one stands in for.
//
// One list, whatever an emulator's source: `emulate` is Vercel Labs' emulate
// (https://github.com/vercel-labs/emulate, Apache-2.0), `own` is one written
// here under src/own/<name>/, and anything else names where it came from. A new
// emulator is one entry: its module (the `@emulators/*` plugin shape that
// emulate's adapter runtime mounts) and the hosts it answers for.
//
// `hosts` maps a real origin's paths onto the emulator's own. Each rule is
// { host, from, to }: a request to https://<host><from>... is served at
// <emulators origin>/<service><to>... . Rules are tried in order, first match wins.

export const SERVICES = [
  {
    name: "google",
    source: "emulate",
    load: () => import("@emulators/google"),
    covers: "Google sign-in (OAuth, OpenID), Gmail, Calendar, Drive",
    hosts: [
      { host: "accounts.google.com", from: "/o/oauth2/", to: "/o/oauth2/" },
      { host: "oauth2.googleapis.com", from: "/token", to: "/oauth2/token" },
      { host: "oauth2.googleapis.com", from: "/revoke", to: "/oauth2/revoke" },
      { host: "openidconnect.googleapis.com", from: "/v1/userinfo", to: "/oauth2/v2/userinfo" },
      { host: "www.googleapis.com", from: "/oauth2/v3/userinfo", to: "/oauth2/v2/userinfo" },
      { host: "www.googleapis.com", from: "/", to: "/" },
      { host: "gmail.googleapis.com", from: "/", to: "/" },
    ],
  },
  {
    name: "resend",
    source: "emulate",
    load: () => import("@emulators/resend"),
    covers: "Resend email sending",
    hosts: [{ host: "api.resend.com", from: "/", to: "/" }],
  },
];

export function service(name) {
  return SERVICES.find((s) => s.name === name) ?? null;
}
