# A page the scan could not read is not a page that left the site

_Found in a production outage 2026-11-18; fixed the same day._

The scan every save queues reads each page at the publication clearance and
applies the narrowing half of what it read ([websites](../websites.md)). Only
`FILE_NOT_FOUND`, the one answer the barrier gives for missing and held back
alike, counts as a page gone. Any other refusal of a page's read
(`STORAGE_UNSAFE` from a collaboration history that would not open, a note too
large) fails the scan, which changes nothing, as a listing that cannot finish
already did (`readScanPages` in `apps/convex/functions/lib/websites/routes.ts`).

**What the simplification cost.** Read as absent, such a failure narrowed the
page off the site and, because the note was still there, `wipeWithheldCopies`
erased its copies from every kept version as if `privacy.md` held it back.
Only Publish widens, so nothing put it back: seyi, public-worship and
context-lc's homepage lost every page, and supa its layout, which left its
stylesheet drawn without a frame.

**What this rule costs.** A page whose read keeps failing holds the scan, and
with it a restriction elsewhere on that site, until it reads. The resolver
still re-reads a served page's live bytes for a restriction on every visit, and
a note held back by `privacy.md` still reads `FILE_NOT_FOUND`, so it still
narrows.

`apps/convex/__tests__/websiteScanReadErrors.test.ts` fails if it is reversed.
