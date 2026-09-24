# Custom domains

_Decided 2026-09-24. See `docs/decisions/README.md` for the index._

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

### Not built yet

- `www` alongside an apex, or more than one domain per workspace.
- Apex proxying for DNS providers without ALIAS, ANAME or CNAME flattening. The
  screen suggests `www.` instead.
- Forms on a customer domain. The human check's widget is hostname-bound, and
  the automated hostname lifecycle for it is still owed. Until then a collecting
  link submits only on `context.lc`.
- Tool output (`create_link`, `list_links`) and the console's share dialog still
  print `context.lc` URLs. Returning the primary domain there is the next step.
