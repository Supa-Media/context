# Every website is also at `<handle>.ctxlc.site`

_Decided by the owner, 2026-10-02 (the domain picked 2026-10-03)._

A workspace's website is served at three addresses: `context.lc/@handle`,
`<handle>.ctxlc.site`, and the owner's custom domain if they connected one.
The sites domain exists so that a site can one day run its own code without
sharing an origin with `context.lc`, where people are signed in. It is on the
Public Suffix List, so every `<handle>.ctxlc.site` is its own site to a
browser: one cannot read another's cookies or storage.

What it serves is decided exactly as `/@handle` is, and by the same code:

- The router treats it as a customer domain (`infra/router/src/siteWorker.ts`):
  no sign-in, no console, no `/@other/` addresses, `noindex` on everything.
- `resolveHost` answers `<label>.ctxlc.site` from the label's name claim, and
  only while that workspace's website is on
  (`apps/convex/functions/lib/customDomains/sitesDomain.ts`). It then serves
  the release `/@handle` serves, narrowed by the same `privacy.md` at once.
  The address publishes nothing that was not already published.
- No plan check. A website is not Premium; its design is, and an unpaid
  site is already drawn in the default look wherever it is served.
- `ctxlc.site` and `www.ctxlc.site` have no site and go to `context.lc`.
- No name on the sites domain can be connected as a custom domain
  (`hostname.ts` refuses it), so no workspace can claim another's address.

What a "simplification" would cost: serving it from `context.lc`'s routing
table would put a site and a signed-in session on one origin's neighbour;
skipping the website-on check would publish a `website/` folder the owner
never turned on. `apps/convex/__tests__/customDomains/sitesDomain.test.ts` and
the "sites domain" cases in `infra/router/src/site.test.ts` fail if either
comes back.

## Site scripts run sealed, so the domain stays off the Public Suffix List

_Decided by the owner, 2026-10-03._ A site's scripts will only ever run in a
sandboxed frame without `allow-same-origin`, in their own box on the page. A
frame like that has an opaque origin and can set no cookie, so one
`<handle>.ctxlc.site` cannot plant cookies on another, and the domain needs no
Public Suffix List entry. What that gives up is page-level code: analytics and
tracking snippets, chat bubbles, cookie banners, pasted third-party scripts,
and scripts that change the whole page. Agents are told this in orient's
website guide and say it when asked for a site
(`apps/mcp/test/orientation/websiteGuide.test.mjs` fails if it goes). Page-level
JavaScript or raw static uploads on ctxlc.site need the list entry first; the
draft request is kept with the project's notes.

Not built yet: the address in Website settings (it appears once the domain's
DNS routes here), and scripts, which are the reason the domain exists.
