# Websites: an agent can publish, the draft it checked and nothing newer

_Decided by the owner, 2026-10-03, after an agent built a site through MCP and
had to sign in to a browser to press Publish: "owners and editors" may publish
through MCP._ This widens the section above only in where Publish is pressed;
who may press it, and what it releases, are unchanged.

`write_note` `site: { action: "status" }` reads the folder at the publication
clearance, as Publish does, and answers with a **draft**: a fingerprint of
every file that scan read, by path and etag. `site: { action: "publish", draft
}` runs the same `publishWebsiteAs` the button runs and releases only if the
folder is still that draft; a save that landed in between is a conflict that
names the new draft, never a release of words nobody checked. A conflict still
applies the scan's restrictions, as every scan does. The answer names the new
`siteRevision` and the site's addresses, so "published" means published.

The clearance is the button's: an owner or editor membership, plus the grant's
own `context:write`. `context:private` is not required, because the site is
read at the publication clearance whatever the caller can see. Every refusal
is one `null` (`/gateway/site`), and the audit records the person and the
connection. It is an argument on `write_note`, not a tool, because clients
cache the tool list (`gateway-protocol.md`).

The simplification to resist is publishing "whatever is there now" without
the draft: an agent that checked a page, then lost a race with a person still
typing, would publish half a sentence under its own verification.
`apps/convex/__tests__/controlPlane/siteGateway.test.ts` fails if a member,
a stranger or a stale draft can publish; `apps/mcp/test/siteActions.test.mjs`
fails if the gateway sends a draft the agent did not pass.

## A check says what Publish would release, and what the cleaner takes out

_Asked for by the owner, 2026-10-03._ `site: { action: "check" }` answers
before a Publish what an agent could otherwise learn only in a browser: every
address and its file, links in pages and site code that go nowhere (note and
line, with the nearest real address), every picture the site draws with its
size and the files that use it, what the HTML and CSS cleaners remove and why,
and pages or layouts that would draw nothing — the `{ content }` an agent
wrapped in a `<template>` is the classic one. `inspect` returns one code note
as the site draws it, after Context's base sheet.

The cleaners report through an optional `removed` callback
(`packages/shared/src/siteDesign`). It is a side channel that never changes
their output, which `siteDesignReport.test.ts` asserts for every case, so a
check can never describe a site differently from how it is drawn. Links are
judged by the same `websiteLinkDestination` the rewrite uses, against the
routes Publish would release. A check reads at the publication clearance
through the one barrier, writes nothing and publishes nothing
(`controlPlane/siteCheck.test.ts`).

## A screenshot is of a published public page, taken as a stranger

_Asked for by the owner, 2026-10-03, who chose Cloudflare's Browser Rendering
over another vendor._ `site: { action: "screenshot", page }` photographs one
page at phone, tablet and desktop widths and measures what a picture cannot
say: sideways overflow, whether the bottom can be scrolled to, boxes that hide
content, pictures that did not load, errors the page threw.

The browser is its own Worker (`infra/site-shots`), because the gateway stays
free of dependencies other than the collaboration engine and puppeteer is one.
The gateway reaches it through a service binding, so it has no address and no
secret. The control plane decides everything first (`lib/websites/siteShots.ts`):
an owner's or editor's connection, a **live, public** page from the route index
Publish wrote, the deployment's own https address for it, and a budget of
`SITE_SHOTS_PER_HOUR` per workspace that a refusal does not spend. The browser
carries no session, so it sees what any visitor sees: a members-only page or a
draft is refused rather than photographed as a sign-in screen. The Worker
re-checks the address is public https as a second lock, and keeps nothing.

The simplification to resist is letting the agent pass a URL: the browser runs
inside our account, and an arbitrary address is a request forgery against
whatever it can reach. `siteShots.test.ts` and `infra/site-shots/src/shoot.test.ts`
fail if anything but the site's own published public page reaches it.
