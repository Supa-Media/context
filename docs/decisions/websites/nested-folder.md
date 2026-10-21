# The website folder can be nested

Decided by the owner, 2026-10-21: "why can't we move the websites folder
inside other folders and still keep the publishing capabilities?" Every other
built-in folder could be renamed, moved and nested since 2026-10-18
([folder-jobs](../app-and-console/folder-jobs.md)); Website was held in place
because the site found its pages by the literal name `website/`, and judged
who may see each page at that name.

**The site keeps its own names.** The route index, the copies Publish keeps,
every check, `folder:` references and every visitor read go on naming pages
`website/...`, so moving or renaming the folder changes no address and takes
nothing off the site. The folder doing the website's job is found by its row
(`role: "website"`, written before its first move by `claimJobBeforeMove`),
unless a root folder really called `website` exists, which keeps that name as
`jobPath` has it (`apps/convex/functions/lib/websites/siteRoot.ts`).

**Reads are judged where the folder is.** Every read the site makes by that
name, and only those, is carried to the real folder before anyone's privacy is
asked, and answered under the name asked:

- the credential barrier's `read`, `readMany`, a folder `manifest` and
  `writeWebsiteRelease` (`lib/websites/siteLens.ts`, wrapped around
  `runFileOperation`);
- the tree's `publishedRows` and `visibleNotes` (`nodeFacts.ts`), which the
  design notes, lists, probes, history and the homepage ask.

Judging at the real folder gives exactly what reading it by its real name
gives, so this never widens what anyone sees. Judging at the default name,
which no row holds once the folder has moved, would read every page as private
and empty the site. A path naming no `website/` costs nothing; one that does
costs one indexed read. Turning a website on sets `team` on the real folder's
row.

**Changes reach the site by the real name too.** An operation through the
barrier that changes anything outside `website/` asks where the folder is and
counts paths under it (`routeChangeAt.ts`, `nestedSiteRoot`), and every keyed
note version landing under it marks the site stale (`markNestedSiteWrite`,
called by `noteIdsKeyed.recordKeyed` and `adoptKeyed`), so an AI client's or a
live session's edit that narrows a page leaves the site at the rebuild two
seconds on. A scan names the listed folder where it is, so a queued move
inside a nested site still stops a Publish rather than hide a page.

**What still holds.**

- The move is allowed where notes are kept by id, as for the five main
  folders; elsewhere pages are found by key and the folder stays put
  (`assertNotProtectedFolder`).
- The website's job is never handed to another folder (`decideJobChange`):
  which folder publishes is not a setting. Move or rename the folder instead.
- A list or folder page never writes `folder:` on any note
  (`apps/mobile/features/console/files/listBlock/writable.ts`): a path no
  longer says which notes are site pages, and on a site page that key
  publishes a folder.
- Agents keep writing `website/...`; a new note there lands in the real folder
  through `canonicalJobPath`, and orient's System folders line says where it is.

The gateway names a move's or a privacy change's paths to `/gateway/website`
as before (`apps/mcp/src/activity/record.js`), and the control plane's
`routeChangeReaches` now counts paths under the real folder as the site's.

What a "simplification" would cost: switching the site to the folder's real
paths would change every page's key on a move, so the index would hold nothing
until the next Publish and a rename would take the site down; dropping the
lens judges pages at a name no rule names and empties a nested site.
`apps/convex/__tests__/websiteNested.test.ts` fails if either goes, and names
its sabotage checks.
