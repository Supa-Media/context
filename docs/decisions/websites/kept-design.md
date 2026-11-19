# Publish keeps a site's look; a visit never rebuilds it into "no design"

_Decided by the owner, 2026-11-18 ("Save the look at Publish + tests"). Part of
[Bucket-backed websites](../websites.md)._

## What happened

Published sites went unstyled, or an all-HTML page went blank, more than once:
the design left out of the edge copy (#1201), a lagging stylesheet taking the
whole design off every page (#2335), a nested Website folder judged private
(#2053, #2098, #2102). Each fix closed one path. The shape underneath was the
same every time: a visit rebuilt the page's look from about five live lookups
(the tree's rows and facts, the code notes, their release copies, the
pictures), and every one of them was `.catch(() => null)`. A lookup that failed
was answered exactly as "this site has no design", and `/site/page` called
that answer cacheable, so the edge kept the unstyled copy for the revision.

## The rule

- **Publish composes the look once.** After the release's page copies are
  written, Publish composes and sanitizes every variant of the design (per
  audience, and per layout a page may name) from those copies and keeps it
  in the release as `<release>/design.json`, in the customer's bucket beside
  the copies (`lib/websites/bakedDesign.ts`). A design that cannot be kept
  stops the release, as a page copy that cannot be kept does.
- **A visit reads that one object.** It is drawn while it still matches the
  route index: every code note the page is drawn with is live under that
  release and the variant was made from exactly those notes. An HTML page's
  own block is sanitized at the visit and drawn inside the variant.
- **Restrictions still do not wait.** While a restriction is pending the
  resolver rebuilds the look from the live notes, as before. A narrowing
  drops a code note's row, so the kept variant no longer matches and is not
  drawn. A withheld page copy takes its release's design with it
  (`deleteWebsiteReleasePages`), so nothing composed from a note outlives it.
- **A failed read is a failure, never a look.** The design that could not be
  read (kept or rebuilt), or a page whose note and copy could not be read, is
  answered `incomplete`: the page goes out as far as it can be drawn, and
  `/site/page` marks it not cacheable and `stale`. The router then serves the
  copy it kept for the **same revision** (kept a day for this, beside the
  five-minute copy), which by construction shows nothing a restriction has
  since removed. With no such copy it passes the answer on.
- A release kept before this has no design and is drawn from its notes as
  before; its next Publish keeps one.

## What a simplification costs

Catching a design read into `null` again is the original bug: an outage is
drawn as the site having no look, and kept. Drawing the kept design while a
restriction is pending publishes a stylesheet the owner just held back.
Serving a stale copy from another revision serves past a restriction.

`apps/convex/__tests__/websiteKeptDesign.test.ts` fails each read in turn (the
live stylesheet and its copy, the kept design, the page's note) and checks the
answer is the styled page or an `incomplete` one the edge will not keep;
`websiteDesign.test.ts` checks a held-back stylesheet is not drawn and no kept
copy of it survives; the router's `sitePages.test.ts` checks the same-revision
fallback and that nothing else triggers it. `site-health.yml` asks real sites
hourly ([code-notes](./code-notes.md)).
