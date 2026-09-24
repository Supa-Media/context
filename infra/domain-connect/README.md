# Domain Connect template

`context.lc.website.json` is the template DNS providers apply when a customer
presses "Set up with <provider>" in Settings › Website. It is the same two
records the screen shows for copying by hand:

- `TXT _context.<host>` = `context-verification=<token>` — the per-claim
  ownership value. `%token%` is the only variable, and it can only land inside
  that prefix.
- `CNAME <host>` → `customers.context.lc` — fixed in the template, never a
  variable, so a link cannot point a domain anywhere else.

`hostRequired` is true: a root domain's host is the zone apex, where most
providers refuse a CNAME, so root domains keep the manual records.

## Signing

The template names `syncPubKeyDomain`, so providers verify every apply link.
The gateway signs the query string (`domain`, `host`, `token`, in that order)
with RSASSA-PKCS1-v1_5 / SHA-256 and appends `sig` and `key=_dcpubkeyv1`
(`apps/convex/functions/lib/customDomains/domainConnect.ts`).

Operator setup, once:

1. Generate a 2048-bit RSA key pair.
2. Store the private key (PKCS#8 PEM) in Convex `appSecrets` as
   `DOMAIN_CONNECT_SIGNING_KEY`.
3. Publish the public key (SubjectPublicKeyInfo, base64) as TXT records at
   `_dcpubkeyv1.domainconnect.context.lc`, split into chunks of the form
   `p=1,a=RS256,d=<chunk>`, `p=2,a=RS256,d=<chunk>`, …
4. Submit this file to https://github.com/Domain-Connect/Templates following
   its README (online-editor test link required), and ask providers to onboard
   it. A rotation publishes `_dcpubkeyv2` beside the old key before switching.

Until all of that is done, detection finds no provider with the template and
the settings screen shows the manual records only.

A self-hosted deployment has its own target, so this template does not apply
to it and the button is never offered there.
