# Custom domains

_Decided 2026-09-24. See `docs/decisions/README.md` for the index._

The link-only serving model below records the original custom-domain decision.
The later, explicitly enabled `website/` authoring surface is documented in
[Bucket-backed websites](../websites.md) and is resolved before these legacy
named links.

### A custom domain is a third locator, never a wider tier

A Premium workspace can connect a domain it owns, such as `docs.acme.com`.
`docs.acme.com/intake` then opens the same share row that
`context.lc/@acme/intake` opens, through the same `readShortLink` and the same
live `privacy.md`. The root opens one short link that the owner picks as the
homepage. Nothing is copied, nothing new is published, and no setting makes a
note public. A domain serves the links that already exist and does not serve
a folder or a note by path. This is the short-link argument
([short-links-and-collect](./short-links-and-collect.md)) applied to a third
address.

Only `anyone` links can be chosen as the homepage, because every visitor who
types the address sees it. A members-only link opened on a domain shows a
"Members only" card that continues on `context.lc`. **No sign-in ever happens
on a customer's origin**, because a session stored in that origin's browser
storage could be read by whoever serves that domain next. The web app mounts
`SiteRoot` instead of the route tree on any host that isn't ours
(`app/_layout.tsx`), so no console, sign-in or settings screen can render there,
whether from a typed URL or a client-side navigation. The router never forwards
`/api/auth/*` from a customer's host (`infra/router/src/site.ts`).

The noindex policy is unchanged. Every response from a customer's domain carries
`X-Robots-Tag: noindex`, and `/robots.txt` disallows everything. Serving a
domain is a hosting decision, and indexing needs a decision of its own.

### Ownership is a TXT record minted per claim, because a CNAME is not proof

Cloudflare for SaaS activates a hostname as soon as traffic for it reaches our
zone. A CNAME to our target is enough for that. The CNAME proves that somebody
once pointed the name at Context. It does not prove that the workspace claiming
the name now is theirs. The textbook takeover works like this: Acme removes
`docs.acme.com` and forgets its CNAME, and the next person to type the name
would verify instantly.

Each claim therefore mints a value (`verifyToken`), and a domain goes live only
after `_context.<host>` publishes `context-verification=<value>`. The check runs
through DNS over HTTPS, in `lib/customDomains/dns.ts`. A record left over from
an earlier claim can't carry a value that did not exist when it was written.
Ownership stays verified for that claim, so tidying up DNS afterwards doesn't
take a site down. The test that fails if this is reversed is `takeover › a CNAME
left behind by the last owner does not verify the next claim` in
`apps/convex/__tests__/customDomains/lifecycle.test.ts`.

Two more rules close the same gap from the other side:

- **Removal deletes at the provider before the row.** Deleting the row first
  would free the hostname while Cloudflare still routes it to us. A failed
  delete leaves the row `removing`, which keeps the name held, and the sweep
  retries.
- **An unverified claim holds its name for seven days.** Otherwise anybody could
  type someone else's domain and block it indefinitely.

### Which workspace a host serves comes from the host alone

The router asks the control plane's `/domain/resolve` with the hostname the
request arrived at. It never uses a header, a path or a query. The answer is
`{ handle, homeSlug }` or one null shape. Unknown, unverified, suspended,
removing and unpaid domains all get that same null shape, so the route works as
a directory of live sites and nothing else. It is the sixth entry in
`UNAUTHENTICATED_HTTP_ROUTES`, which gives the reasoning.

An unknown host gets the same 404 as a missing page, and the SPA is never
fetched for it. If the control plane can't be asked, the response is a 503 that
is never cached. That way a deploy can't make a live site look disconnected for
longer than the outage itself.

### Premium serves the domain, and a lapse deletes nothing

A domain comes with any paying plan. It is not a third entitlement toggle,
because `workspacePlans` sells two entitlements at one price
([billing](../billing.md)) and a domain is not something to meter. Serving
checks payment at request time, so a lapse stops the site immediately. The sweep
then marks the domain `suspended` and keeps its provider registration, so that
paying again resumes the site rather than restarting setup. Notes, links and the
original `context.lc` addresses are untouched in every state.

### Credentials

`CUSTOM_DOMAINS_API_TOKEN` is a token of ours, zone-scoped to SSL and
Certificates on the customer-hostname zone. It lives in `appSecrets` and is
opened only by the three internal actions in `customDomainsProvision.ts`, which
are enumerated in `reachability.test.ts`. The zone id and the CNAME target are
identifiers, not credentials. They are synced as deployment environment
variables (`CUSTOM_DOMAINS_ZONE_ID`, `CUSTOM_DOMAINS_TARGET`). If they are
absent, the deployment doesn't offer domains, and the settings section says so
in one sentence.

### One-click setup is Domain Connect, signed, and never for a root domain

When the customer's DNS provider implements Domain Connect and has our
template (`infra/domain-connect/context.lc.website.json`), the pending card
leads with "Set up with <provider>". The provider applies the same two records
the screen would have them copy, and the checker verifies them the same way.
The link grants nothing: the TXT value is still the per-claim token, so a link
cannot prove ownership of a zone the clicker does not control at the provider.

- **Signed.** The template names `syncPubKeyDomain`, so providers check an
  RS256 signature over the query against our public key in DNS. The private
  key is `DOMAIN_CONNECT_SIGNING_KEY` in `appSecrets`, opened only by
  `customDomainsProvision.detectProvider`.
- **Fixed target.** The CNAME target is written into the template rather than
  passed as a variable, so a link cannot point a domain anywhere else. A
  deployment whose target differs (self-hosted) is offered no button.
- **Subdomains only.** Applied to a root domain the template's CNAME lands on
  the zone apex, which most providers refuse. A button likely to fail is worse
  than the records, so root domains keep the manual path. Covering them needs
  fixed IPs for an A record (Cloudflare's Enterprise-only apex proxying).
- **Discovery never widens what we fetch.** The `_domainconnect` answer comes
  from customer DNS, so only a bare host (with an optional path) is accepted,
  and every URL the provider returns must be plain `https` on a named host.

The test that fails if signing is dropped or loosened is `the signature covers
exactly the query the provider applies` in
`apps/convex/__tests__/customDomains/domainConnect.test.ts`.

### A root domain carries Cloudflare's TXT as a third record

An ALIAS, ANAME or flattened CNAME answers with addresses, not a CNAME, and
without Enterprise apex proxying Cloudflare never activates such a hostname by
its DNS alone: it waits for its own `_cf-custom-hostname` TXT. So a root
domain's card shows three records: the ALIAS, Cloudflare's TXT (taken from the
registration's `ownership_verification`, accepted only for exactly that name
and a plain token), and our `_context` TXT. A subdomain validates by its CNAME
and never sees the third. "Check again" on a pending root domain re-sends the
certificate settings, which asks Cloudflare to look now instead of at the next
step of a backoff that reaches four hours, and Cloudflare deletes an
unvalidated hostname after seven days. Dropping the record strands every root
domain at "Connecting"; `apps/convex/__tests__/customDomains/apex.test.ts`
fails.

### Not built yet

- `www` alongside an apex, or more than one domain per workspace.
- Apex proxying for DNS providers without ALIAS, ANAME or CNAME flattening. The
  screen suggests `www.` instead.
- Forms on a customer domain. The human check's widget is hostname-bound, and
  the automated hostname lifecycle for it is still owed. Until then a collecting
  link submits only on `context.lc`.
- Tool output (`create_link`, `list_links`) and the console's share dialog still
  print `context.lc` URLs. Returning the primary domain there is the next step.

## Staging owns a separate SaaS registry

Production and staging have independent domain-claim databases. They must also
use different Cloudflare SaaS zones and zone-scoped provisioning tokens. A
second CNAME under the production zone does not isolate traffic: the zone's
wildcard Worker still resolves customer hostnames against production.

The staging workflow syncs `CUSTOM_DOMAINS_ZONE_ID` and `CUSTOM_DOMAINS_TARGET`
from its own GitHub environment secrets. Both are optional together until
operator setup is complete; malformed pairs and targets under `context.lc`
fail preflight. The operator must verify that the target belongs to the chosen
staging zone, enable SaaS there, set its fallback, and route that zone's customer
traffic to `context-router-staging`, preserving any existing platform hosts.
Store a token scoped only to that zone in staging `appSecrets`; never reuse the
production provisioning token. Remove a previously configured deployment's
environment values explicitly when disabling it: absent GitHub secrets do not
delete live Convex settings.

The production Domain Connect template has a fixed production CNAME target,
so isolated staging uses manual DNS records. Verify claims and certificates
with disposable hostnames and a test workspace through the normal application
lifecycle before treating the staging setup as complete.
