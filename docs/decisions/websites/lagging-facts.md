# A lagging row is read before a page is left out

_Reported on a customer's site 2026-10-28; fixed the same day._

A row whose facts lag its note (the note changed and the facts fill has not
read it yet, which for a write through the gateway, an agent or the live
editor, can be the quarter-hour sweep) is not evidence the page stopped
publishing. The public list, the design, the client snapshot and the route
probe ask `currentRows` (`apps/convex/functions/lib/websites/treeFacts.ts`),
which runs one fill pass for such rows and asks the tree again. Notes are still
opened only by the fill, as [the tree rule](../websites.md) asks, and a row
still lagging after it (another pass holds the fill, or the note changed again
while it read) is left out as before, so a narrowing is never answered from
the copy Publish kept.

Until 2026-10-28 they left such a row out at once: an edited page fell off the
homepage list while its own page still rendered, and an edited stylesheet took
the whole design (stylesheets, frame, layouts) off every page until the sweep
read it. Simplifying `currentRows` back to `treeRows` fails
`apps/convex/__tests__/websiteLaggingFacts.test.ts`.
