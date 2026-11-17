# Browser Use is the fallback for a site block (2026-11-17)

Decided by the owner, 2026-11-17: Tex's browser jobs stay on Browserbase.
Only a job a site blocks is retried on Browser Use Cloud, and only while
`browsers.browserUseFallback` is `"on"`. The committed config is `"off"`.
Staging sets `BROWSER_USE_FALLBACK=on` on the gateway Worker and nowhere
else, so a Lab measurement does not turn the fallback on in production.

A site block is a document-host 403, a captcha or interstitial still
unsolved after the captcha ladder, or a silent submit that stayed stuck.
A 403 from Browserbase refusing the Verified tier, a billing 402, a
capacity 503, and a generic error are not site blocks. The last seven days
of 403s were all the Verified-tier refusal.

The gateway sends `provider: "browser-use"`. The screenshot Worker does not
switch by itself. It uses the browser-session API and CDP only
(`POST /api/v4/browsers`, `PATCH` stop, `GET /api/v2/billing/account`,
`GET /api/v4/sessions/{id}/cost`). It does not start a Browser Use agent
task, and it does not call anything that buys credits or turns on
auto-recharge. Closing the CDP socket is not a stop. The vendor live-view
URL is never returned; the person's own `/tex/<handle>` view attaches to
the CDP socket.

The sealed cookie and IndexedDB jar is restored onto the new browser.
A Browserbase profile id is not a Browser Use profile. A Google sign-in
bound to the device that created it will not transfer.

Caps, enforced in the screenshot Worker and failing closed: 15 minutes a
job, $1 a New York day, $5 a New York month, and a vendor balance under
$0.50 or a balance call that fails. A cap refusal returns the original
Browserbase result plus the reason. Spend and the block log live in the
`BrowserUseLedger` Durable Object (`POST /browse/blocks` summarizes it).
The log is one job row per browse tool call, plus a call row per Browser
Use session and per vendor refusal, so it outlives Cloudflare's sampled
logs.

**What a simplification would cost:** routing every job to Browser Use, or
treating a Verified-tier 403 as a site block, spends the $5 month cap on
work Browserbase already does, or on a plan limit that is not a bot wall.
Dropping the stop call keeps billing after the socket closes. Tests:
`infra/site-shots/src/browserUse.test.ts` and
`apps/mcp/test/browserUseFallback.test.mjs`.

Revisit a full switch after 20 or more real Browser Use jobs. Read the
counts with `POST /browse/blocks` on the screenshot Worker (the gateway's
service binding is the only way in).
