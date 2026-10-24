/**
 * HOSTS ANYONE CAN PUBLISH UNDER, in one place because two rules need them.
 *
 * The proxy step refuses a key pinned to one of these exactly, because a pin
 * to it is a pin to everyone (`proxy.js`). The fill step refuses to go
 * *beneath* one, because a login saved for `github.io` would otherwise be
 * typed into anybody's page there (`entries.js`, `siteMatches`).
 *
 * An address beneath one (`my-app.workers.dev`) is one person's, and a pin is
 * that exact address, typed by the person saving the key, so it is allowed
 * (the owner, 2026-10-16: "the user is writing the domain in so they should
 * be allowed to"). Not the whole public suffix list: the hosts people
 * actually paste into a "send it to" box. A registry suffix nobody publishes
 * under directly, such as `co.uk`, is not here and is not covered.
 *
 * `apps/mobile/features/vault/vaultProxy.ts` keeps its own copy for the save
 * page, pinned to this one word for word by `vaultApiHosts.test.ts`.
 */

const SHARED_SUFFIXES = [
  "workers.dev",
  "pages.dev",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "repl.co",
  "replit.app",
  "ngrok.io",
  "ngrok.app",
  "ngrok-free.app",
  "trycloudflare.com",
  "loca.lt",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "blogspot.com",
  "wordpress.com",
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
  "beeceptor.com",
  "hookbin.com",
  "requestcatcher.com",
  "mockbin.org",
  "httpbin.org",
  "postb.in",
  "ptsv3.com",
];

export function isSharedHost(host) {
  return SHARED_SUFFIXES.includes(host);
}
