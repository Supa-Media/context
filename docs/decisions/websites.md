# Bucket-backed websites

_Decided 2026-09-25. See `docs/decisions/README.md` for the index._

## `privacy.md` decides what a website publishes

_Decided by the owner, 2026-09-26._

A website is the owner's folder link over `website/`, and it resolves the way
every folder link does: each page, menu entry and list row is read at `team`
scope with no granted names (`lib/websites/publication.ts`). A note the
manifest holds back — private by exception, private by folder, or pointed at a
group — is absent from the site, whatever its frontmatter says. Page
frontmatter can only narrow: `audience: members` asks for a signed-in member,
`draft: true` withdraws the page. It can never publish something the manifest
does not.

The alternative was to let frontmatter decide, with `audience: public` as the
default. That was what shipped first, and it put private notes on the
internet: filing a note under `website/` is an ordinary move, not a publish
gesture (the folder is deliberately ordinary, per
[folder lists](./folder-lists.md)); the console, search and every AI client
went on calling the note private, because for them it was; and it
contradicted the sentence every client is handed — visibility is enforced by
the manifest, *never by frontmatter*. One source of truth for who can read a
note is the product.

This is non-negotiable #5's single exception, not a new one. Turning the site
on is the owner minting a revocable locator for one folder, and it narrows:
it publishes what `website/` already publishes to the workspace and never
more. Turning it on writes `website: team` to `privacy.md` only when the
manifest has no rule for the folder — an owner who already wrote
`website: private` keeps a site that serves nothing, and a later change to the
rule is theirs. Sites enabled before this rule existed get the same
absent-only write once, from the next rebuild. The rule also makes `website/`
readable by the workspace's own members in the app, which is no wider than
the site: every page it publishes, they could already open on the web.

Consequences that follow and are intended:

- **The index is built at the publication clearance**, never at the owner's,
  and never depends on who triggered the rebuild. An owner's "Check again"
  still shows the owner their own view, and commits a separate publication
  scan.
- **The members gate is a membership check, and that is sufficient.** Every
  member reads at `team` or wider, so a page visible at `team` with no names is
  visible to every member. A group-pointed note is therefore not served even
  to the group: a website is not a way to reach a subset of members.
- **A manifest change is a website change that may narrow.** Visibility,
  group and privacy-reset operations under `website/`, and any write to
  `privacy.md`, mark the index stale and unsafe, so the menu is withheld until
  the rebuild lands.
- **The release fallback is not used while a restriction is pending.** An
  unreadable source cannot say the page is still meant to be published.

`websitePrivacy.test.ts` pins it on both serving paths — the fresh index and
the bucket probe — and reverting either path's read clearance fails it.

## An edit is a candidate; the last complete release is the fallback

The editor autosaves a Markdown note while it is being typed. A save can catch
frontmatter after its opening `---` and before its closing one, or one half of
a route rename. Those bytes are a valid working state and an invalid website
release. Treating every save as both made the public site say “Nothing here”
while its owner was editing it.

A complete route reconciliation now writes every live page into an immutable
release under `.context/website/releases/` before it atomically replaces the
route index. A reconciliation containing any problem publishes nothing. The
old rows and their release remain the last complete answer, while the owner-facing
status still reports the problem from the live scan.

The first scan has no last-good answer to preserve. It may record problem rows
without a release so route clashes still fail closed across the whole folder;
it never records page bytes. Later problem scans cannot replace those rows.

Serving retains the useful half of the bucket-first rule: a live source that
parses, owns the same route, and declares the same audience is served at once,
so an ordinary edit does not wait for a rebuild. If that source is temporarily
malformed or unreadable, the resolver reads the indexed release instead. The
last complete navigation is retained while the index is stale for the same
reason; dropping it made a page save look like the rest of the site vanished.

Every in-product website write advances the route generation, even when an
earlier edit already made it stale. Each queued rebuild carries the generation
it was scheduled for, so all but the last job in an autosave burst stop before
opening storage. A write that lands during a scan advances the fence and the
older scan cannot commit.

`websiteResolution.test.ts` pins the user-visible failure: an unclosed
frontmatter save continues to serve the prior title, body, and menu, including
after a reconciliation attempt, and the next complete edit replaces it.

## Edits wait for Publish

_Decided by the owner, 2026-09-26, for every workspace's website: "the website
folder should have a publish button on the folder itself, and also in the
share dialog — that way we publish from the bucket and we don't have to read
from the bucket each time."_

Saving a note under `website/` changes the note and nothing a visitor sees.
**Pressing Publish** (on the `website` folder's page, or in its share dialog;
`websites.publish`, owners and editors) reads the folder at the publication
clearance and, when no page in it is broken, makes it the site's new release.
Turning a site on is its first Publish. A broken page stops the publish and is
named to whoever pressed it; a page with no title is not broken (it is titled
by its first heading, else its file name), and neither is an empty one.

This supersedes the serving half of the section above: a live source is no
longer served because it parses. The resolver still reads a page's live bytes
on every request, but only to ask whether they now restrict it; the words it
serves are the published copy (the live file while its etag is still the one
published, the release copy once it has changed). A page nobody has published
is not on the site, however complete its file is, so the bucket probe survives
only for a site that has never had a scan.

**Restrictions do not wait.** The scan every save still queues applies the
narrowing half at once (deleted, drafted, made members-only, encrypted, held
back by `privacy.md`) and then counts as reconciled, so widening is the next
Publish's job rather than the next clean scan's. A members page made public is
a widening and waits. Without this, a Publish button would also be the only
way to take a page down.

`siteRevision` moves on a Publish and on a restriction (applied or pending),
never on a save, because a save changes nothing a visitor sees. The router
keeps the homepage's answer per revision (`/site/home/revision`, one database
read per visit), so the folder is read once per Publish per colo.

`websitePublishing.test.ts` fails if an unpublished page or an unpublished edit
is served, or if a member can publish; `websiteNarrowing.test.ts` fails if a
restriction waits for Publish or a new page does not; `siteHome.test.ts` fails
if a save moves the homepage's revision or its words.

## An agent can publish, the draft it checked and nothing newer

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

## Every site's pages are kept at the edge per Publish

_Decided by the owner, 2026-09-26: "same functionality for all the websites
… even individual user sites face the same issue."_

A visitor who is not signed in reads a page of any site (`/@handle/...` and a
customer's domain alike) from `/_site/page` on the router
(`infra/router/src/sitePages.ts`), not from Convex. Each visit asks
`/site/revision` (one database read) and serves the copy the colo keeps under
that revision; only a miss asks `/site/page`, which resolves the address
**exactly as for an anonymous visitor, whatever arrives with the request**
(`lib/publicRoutes/sitePage.ts`) and is the one request that reads the bucket.
A signed-in visitor asks Convex directly, because a members-only page is not
the same page for everybody, and so does anyone the router cannot answer.

What may be kept is decided by Convex, not the router: never "unavailable"
(it is also what a bucket outage looks like), and nothing while a restriction
is pending or before a site's first scan, when a page is judged from its live
bytes on every visit. A copy is also dropped after five minutes whatever the
revision says. That is the bound on the one restriction a revision cannot see:
one written straight to the bucket, outside Context, before a sweep notices
it. Every restriction made through Context moves the revision and takes effect
on the next visit. The copy is a CDN's copy of a public page, like the
homepage's: it is never the only copy of anything, and it holds nothing an
anonymous visitor could not already read.

On a customer's domain the handle is the domain's binding and the only legacy
slug is the one its owner chose for `/`; neither is read from the request.

`sitePage.test.ts` fails if a member's answer is kept, if "unavailable" or a
pending restriction is kept, or if the route grows a field; the router's
`sitePages.test.ts` fails if a second visit reads the page again, if a new
revision does not, or if a customer's domain can ask for another handle.

## A fallback never reverses an explicit restriction

Last-known-good is an availability rule, not permission to keep publishing
something the owner withdrew. A missing source, encryption, `draft: true`, a
route move, or an audience change does not use the fallback. Those states keep
the existing fail-closed behavior and invalidate the derivative immediately.
A malformed metadata block is different: it expresses no complete new
publication decision, so the prior release stands.

An in-product change that may narrow a route marks the stale generation unsafe.
Until its complete reconciliation lands, navigation and the route link catalog
are withheld as well; otherwise an old menu could keep publishing the title of
a page that was just made members-only. Ordinary content edits and incomplete
frontmatter do not set that marker, so their last complete menu remains visible.

Membership and share standing remain live checks. A released members page is
still gated by current membership before storage opens, and a revoked share is
removed from rendered links and lists immediately.

The sabotage case is the audience change in `websiteResolution.test.ts`: if
the stale public source becomes `members`, the public body is not returned even
though a readable public release exists.

## The index may lag on widening, never on narrowing

_Decided by the owner, 2026-09-26._

A rebuild that meets a broken page publishes nothing new. It still applies
the narrowing half of what it read (`lib/websites/narrowing.ts`): a live row
whose page was deleted, moved, drafted, made members-only, encrypted or held
back by `privacy.md` is dropped. Its copy in the current release is deleted,
and the grace release, which duplicates it, is retired. New pages and other
widening changes wait for a clean scan, and the reconciled generation does
not advance. Without this, one half-finished page anywhere in the site froze
every restriction behind it. A menu kept the title of a page just made
members-only, and a release kept the plaintext of a page just encrypted,
for as long as the other page stayed broken.

A clean rebuild applies the same rule to the release it demotes to grace: the
copies of narrowed pages are deleted at once rather than a generation later.
**A release copy must not outlive the plaintext it copies.** The copies are a
derivative in the customer's bucket under the same credential as the note, so
the argument in [encryption](./encryption/format-and-search.md) against a
plaintext index of an encrypted note applies to them unchanged.

Ciphertext is not a broken page. A publication scan skips it the way it skips
a private note, so an encrypted note under `website/` is unpublished rather
than stopping every later rebuild.

The autosave grace is unchanged. A malformed save of a public page keeps its
release unless its bytes restrict (`websiteTextRestricts`). A members page
keeps it unless it is ciphertext, because it reached the release through the
membership gate. This rule also means a restriction the gateway reports
without saying what changed now lands on the next rebuild, since that
rebuild reads the bytes.

`websiteNarrowing.test.ts` makes one page narrower while another stays broken,
and checks the narrowing landed and the widening did not.

## Release bytes stay in the customer's bucket, with one generation of grace

Convex stores only the release id and page id beside routing metadata. Markdown
never enters a control-plane table. The page copies live in the reserved
customer-owned `.context/` tree and are read through the single existing
credential barrier.

A new release is staged under random, bounded object names and verified before
the route-index transaction points at it. Failed staging deletes its unreachable
objects best-effort and leaves the previous rows untouched. The current release
and one previous release are retained; the release older than that is cleaned
up only after a successful commit. The grace generation prevents a request
that planned against the old index from losing its bytes during the same
cutover.

Conditional create is used when the connected store has verified it. Older
bindings without that recorded capability use random object names plus a
read-before-write and byte verification; requiring a newly added capability
would make the reliability fix unavailable to exactly the long-lived sites it
is meant to protect.

`websiteRouteIndex.test.ts` proves that Markdown is absent from the database,
that release bytes land under `.context/`, and that a failed release write
cannot replace the prior route or its fallback reference.

## The workspace icon is the site's favicon

_Decided by the owner, 2026-09-26._

A published site wears its workspace's icon in the browser tab — the emoji
drawn as an SVG, or the photo's own bytes — instead of Context's favicon, which
stays for a workspace with no icon, for a legacy short link, and everywhere
else in the app. Turning the site on is what publishes the icon: before that,
`websites.siteIcon` answers `null` exactly as it does for a handle nobody has
claimed, so it is not a way to learn that a workspace exists or what it looks
like. An owner who wants a site without their icon clears the icon.

This is not a wider locator. The icon is not a note and is not under
`website/`; it is a picture the owner chose to show every member, and it
already stands beside the site's name, which the site publishes too. The photo
is read out of the customer's bucket at the publication clearance, and the
action takes a handle and nothing else: the leaf comes off the workspace row,
so the set of objects it can return is one per enabled site, chosen by its
owner — the argument `files.workspaceIconPhoto` makes, with "member" replaced
by "the site is on". An unreadable photo is the same `null` as none.

`websiteSiteIcon.test.ts` fails if the enabled gate is dropped (a disabled and
a never-enabled site both answer like a nonexistent handle) or if an argument
that could name an object is added.


## A page unfurls as itself

_Decided 2026-09-26, after a link to a site on its own domain unfurled in
iMessage as Context's marketing card._

A crawler asking for a website address is told what an anonymous visitor to
that address is shown, and no more: the page's title, the site's name as
`og:site_name`, one line of description (the page's `description:`, else its
first paragraph of prose), and a card drawn from those two names. The home
page speaks as the site, under the site's name. It is resolved by the same
code that serves the page (`lib/websites/preview.ts` calls the resolver as an
anonymous viewer, whatever credentials the request carried), so every rule a
visitor is held to holds here without a second copy: the site is on,
`privacy.md` publishes the page, it is live, public and not encrypted. Every
other case is one null answer, byte for byte, and the picture is one 404.

This is the favicon's argument again: turning the site on is the owner
publishing these pages, so describing one to a crawler discloses nothing the
address does not already show. It does not widen "Link previews reveal nothing
about a context" (`privacy-and-sharing/link-previews-and-audience.md`) for
anything else. **`/@seyi` alone stays the frozen card on context.lc and asks
nobody**, because a bare handle is guessable and unbounded; a site's home page
unfurls as itself at the site's own domain, and its other pages at
`/@seyi/<page>` too. The two routes are pinned in `httpRoutes.test.ts` with
their four fields.

The card is the site's, not ours (`lib/siteCardArt.ts`): Paper, the title in
the site's heading serif, the name in its header sans, no Context mark. It is
drawn on request and cached at the edge under a version that digests what it
draws, so a retitled page is a new image URL; nothing is written to the
bucket. A page whose name or title the card faces cannot draw carries no image
tags at all, rather than wearing Context's card. Pages cannot pick their own
image yet, because the public site does not load images.

`siteCard.test.ts` fails if a members-only, draft or switched-off page answers,
if a signed-in request is answered as its member, or if the card draws
anything but the two names; `infra/router/src/site.test.ts` fails if a site
page's tags fall back to Context's card or copy.

## The homepage is `@context-lc`'s website, in its HTML

_Decided 2026-09-26, by the owner: the homepage's sidebar should be the
`website/` folder, so the front page is edited like any note. This reverses
#968, which made the homepage static because the live site used to arrive
after the built-in copy and replace it._

`/` draws `@context-lc`'s `website/` folder as a workspace: the tree is that
folder exactly, its own folders with each note where its file is, `nav:` order
first and then by path. **Every published note in the folder is listed**,
titled or not and in the menu or not (decided by the owner the same day: "why
can't it just be exactly what's in the website folder?"); `nav:` only orders.
A note without a title is listed by its first heading, else its file name.
Listing unlisted pages is the homepage owner's choice for their own homepage,
so `/site/home` answers **only for the home handle** (`HOME_SITE_HANDLE`,
default `context-lc`) and is null for every other, which would otherwise make
any site's pages outside its menu enumerable. The router asks Convex's
`/site/home` while it fetches the HTML and puts the answer in the page as an
inert JSON block (`infra/router/src/homeSite.ts`), so **the first paint is the
live site and nothing replaces it**. `/site/home` takes the folder's files
from the site's own route index, serves what was published, and re-reads the
live files at `PUBLICATION_CLEARANCE` (`lib/websites/snapshot.ts`), so a note
`privacy.md` holds back is absent, and drafts, members-only and encrypted
notes are dropped as they are on the site. It must not list the bucket per
visit: the first version did, answered slower than the page waits, and every
visitor got the built-in copy. The router keeps the answer per site revision
(see "Edits wait for Publish"), including one that arrives after it stopped
waiting, so the folder is read once per Publish, not once per visit.

### The homepage is the console's frame, never a copy of it

_Decided 2026-09-26, by the owner: "there are going to be a bunch of changes
to the shell and the makeup of the app and I'd like to make sure the
frontpage stays true and real to the actual state of the app."_

`HomeShell` renders `features/console/ConsoleFrame.tsx` — the body of the
console's own route layout — with `BrowsePane` inside it, over `ConsoleData`
built from the website's notes (`useVisitorConsoleData`). It does not compose
`AppFrame` itself. The first homepage did, and every piece it did not copy was
missing: the account button at the foot of the tree, the note's eye and
Share, `‹ ›`. A change to the console's shell reaches the homepage in the
same commit because there is one frame.

What differs is `data.visitor`, and only where an account is the point:
Settings, the agent setup, Sign out and the right panel are not drawn, the
account button offers Sign in and Create account (or the way back to the app
for somebody signed in), and Share copies the page's public link — its clean
address, `/pricing` (see "A homepage page is addressed by its own name") —
rather than opening a dialog that needs a workspace. `demo` stays true, which
keeps every server-backed control out, so the page asks Convex nothing.

**What a "simplification" would cost:** a homepage frame of its own drifts
from the app on the first shell change nobody ports.
`homeConsoleFrame.test.ts` finds the console's own controls by their test ids
and fails if the homepage stops rendering them, gains an account's controls,
or reaches the server.

A visitor can edit it the way they would their own workspace: every note
opens in the editor, and notes and folders can be made, renamed, moved, copied
and deleted. No button turns editing on and no line explains it (the owner:
"editing the page should just work"). **None of it
leaves the tab** (`apps/mobile/features/home/useLocalFileBrowser.ts`): there is
no bucket behind that tree, a reload is the site again, and sharing,
visibility and downloads stay off because each is a claim about a real
workspace. Until the visitor changes something the tree follows the site; after
that it is theirs. There is no call to action in the top bar: the page is the
product, and a signed-out visitor gets Sign in.

### A homepage page is addressed by its own name

_Approved by the owner with the phone redesign, 2026-09-27._

`/pricing` is the homepage's Pricing page. It used to be the not-found screen,
and Share handed out `/?page=pricing`. A clean address reaches the app through
the `app/[handle]` routes (the only dynamic top-level route), which redirect a
name that is not an `@handle` to `/?page=<name>` on the web, so a visit stays
one homepage and moving between pages is a change of `?page=` on one screen —
the visitor's in-tab edits are not dropped by a second copy of it mounting. A
name the site has no page for gets the homepage's own "Nothing here". The
router (`infra/router/src/homeSite.ts`) puts the site in a page address's
HTML as it does in `/`'s, when the site has that page, so the first paint is
the page rather than a wait for the app to ask.

The app's own screens and people's websites keep winning: Expo Router matches
static routes first, and `APP_SEGMENTS` in
`apps/mobile/features/home/homeSite.ts` names every top-level route so that
Share never hands out `/login` for a site page called `login` (that one keeps
`/?page=login`).

**What a "simplification" would cost:** drawing the homepage at `/pricing`
instead of redirecting remounts it on the first click; dropping a segment
from the list makes Share's link open an app screen. `homeSite.test.ts` reads
`app/` and fails on a route the list does not name.

**One screen means the layout, not the index route** (2026-09-28). A change of
`?page=` is a push, and a push is a new screen for the route, so while the
homepage was `app/index.tsx` every page a visitor opened mounted a new copy of
it: `‹` and Recent stayed dimmed on a phone, and in-tab edits were dropped
anyway. The homepage is drawn by `app/(home)/_layout.tsx`, which Expo Router
keeps across its screens' pushes (the way `(app)/console/_layout` keeps the
console); `app/(home)/index.tsx` draws nothing and is only the history entry,
and `HomeShell` reads the page with `useGlobalSearchParams`. Moving it back
into the index screen fails `e2e/webkit/homeNavigation.spec.ts`.

A visit decides once between the site and the built-in copy
(`apps/mobile/features/home/homeSnapshot.ts`): with no block in the HTML the
app asks, draws nothing until it hears, and falls back to `builtInPages.ts`
for the whole visit if the site is off or silent. The copy is never drawn and
then swapped for the site. The site is redrawn only when its revision moves,
which is somebody pressing Publish (or a restriction landing).

`siteHome.test.ts` fails if a private, draft or members-only note leaves,
if an unlisted note is missing, if another handle gets an answer, or if the
route grows a field; `homeLocalBrowser.test.ts` fails if the site rewrites a
tree the visitor has changed; `homeSite.test.ts` in the router fails
if a page's words can close the block; `homeSite.test.ts` in the app fails if
the copy can replace the site or the site the copy.

## A page's emoji travel with the page

Decided 2026-09-26, when a workspace's own emoji showed as `:name:` on its
published site. A site loads no images, so the pictures a page shows arrive
inside its answer as `data:` URLs (`lib/websites/emoji.ts`): the resolver adds
them to a page, and the homepage snapshot adds those its pages use. Only names
the published text uses outside code are read, so publishing a page publishes
the pictures in it and no other emoji in the workspace. A picture over 128 KB,
past 768 KB in one answer, or past 48 names is left out and shows as its name.
The router and the app each re-check every entry and keep only an inline PNG,
JPEG, GIF or WebP under an emoji name, so no answer can make a visitor's
browser fetch an address. A standard `:shortcode:` is drawn as its character.

**What a simplification costs.** Serving emoji from a URL makes each view a
request to us the visitor did not ask for, and a route that answers for any
name publishes every emoji the workspace has. Reading names inside code
publishes pictures the page does not show. `apps/convex/__tests__/websiteEmoji.test.ts`,
`apps/mobile/__tests__/websiteEmoji.test.ts` and `infra/router/src/homeSite.test.ts`
fail if either comes back, or if a non-inline picture gets through.

## A page's pasted pictures travel with the page

Decided 2026-09-28, when a screenshot pasted into `@context-lc`'s
`website/use-cases.md` drew in the editor and showed "Not in this bucket" on
the homepage. It is the emoji rule again, for the same reason: a site loads no
images, so the pictures a page embeds arrive inside its answer as `data:` URLs
(`lib/websites/images.ts`). Only a bare stored leaf the published text embeds
outside code (`![[paste-….png]]`, `![alt](paste-….png)`) is read, through the
store's own `readImage` leaf rule at the publication clearance, so publishing a
page publishes the pictures in it and no other object in the store. A picture
over 2 MB, past 4 MB in one answer (the homepage's whole site is one answer),
past 24 leaves, or of a type browsers do not draw (HEIC, SVG) is left out and
shows as missing. The router and the app each re-check every entry and keep
only an inline PNG, JPEG, GIF or WebP under a stored leaf, so no answer can make
a visitor's browser fetch an address. The homepage's editor answers
`loadImage` from the snapshot; a `/@handle` page draws an image line as the
editor lays it out, with its width and alignment. A remote image stays text.

Whoever can Publish chooses what a page embeds, so a leaf named on a page is
published even when the same picture is also pasted into a private note: the
leaf is a content hash, which nobody can name without having seen the picture.

**What a simplification costs.** Serving pictures from a URL makes each view a
request the visitor did not ask for and needs a route that answers for leaves;
one that answered for any leaf would publish every picture in the store.
`apps/convex/__tests__/websiteImages.test.ts`,
`apps/mobile/__tests__/websiteImages.test.ts` and
`infra/router/src/homeSite.test.ts` fail if a leaf the page does not embed, one
inside code, a path or a non-inline picture gets through.

## A website page can name a folder, and the folder narrows

Decided by the owner, 2026-09-26, so notes kept for their own sake (a
`features/` folder of guides) can also be the site without being copied into
`website/`. A page of the site's own whose frontmatter says `folder: features`
publishes the notes in `features/` under its address: `website/features.md`
puts `features/forms.md` at `/features/forms`, and `features/guides/tables.md`
at `/features/guides/tables`. The page lists them under its own words, by
title and description, and on the homepage it opens as that folder in the
sidebar, with its notes inside. Every site gets this, not only the homepage.

A referenced note is an ordinary route row keyed by its real path
(`lib/websites/folders.ts`), so everything already true of a page is true of
it: it is listed and read at `team` scope with no granted names, re-read at
that clearance on every visit, served from the release when edited, dropped
the moment it restricts, and edits wait for Publish. Where the route compiler
needs a key inside `website/`, it gets the one the address implies
(`routeStatusKey`). So a folder **narrows** exactly as a folder link does: a
note `privacy.md` holds back by name, a private subfolder and a note pointed at
a group are absent, and a folder `privacy.md` keeps private publishes nothing.
Frontmatter still only narrows; `folder:` chooses *which* notes are
candidates, never whether one publishes.

What no page may name: the whole context (empty, `/`), `website/` or anything
under it (already the site), anything with a segment starting with `.`
(`.context/`, `..`), and anything ambiguous (a backslash, `%`, `?`, `#`, a
control character). Only the site's own live pages name folders: a draft
folder page publishes nothing of its folder, and a note a folder published
cannot name another. A page of the site's own outranks a referenced note at
the same address, and a note the compiler refuses is left off rather than
reported, so one stray note never stops Publish. At most 300 notes join a site
this way. The probe that serves an address the index has not caught up with
still looks only in `website/`, so a referenced note is absent until the
next rebuild, never early.

**What a simplification costs.** Reading the folder at the owner's clearance
publishes their private notes. Copying the notes into `website/` makes two
sources that drift. Accepting `folder: /` makes the whole context one
setting away from public, which non-negotiable #5 forbids.
`apps/convex/__tests__/websiteFolders.test.ts` fails if any of these comes back.

## The homepage's cast is written in its pages, and plays through real presence

Decided by the owner, 2026-09-27: the homepage should feel like a workspace
people are working in, with people and agents typing, reading and adding
notes while a visitor watches, and the owner writes what they do. A page
scripts its cast in a fenced `cast` block placed where the words should
appear (`packages/shared/src/websiteCast.ts`):

````
```cast
@maya adds to the line above: (the baby can read.)
Claude writes: new here? [[getting-started]] is the tour.
Claude reads: pricing
Claude adds note: getting-started
  # Getting started
wait 3s
```
````

**A block's position is its anchor.** A new line lands where the block was;
"adds to the line above" lands at the end of whatever paragraph is above it
now, and "adds a line below" on the line just under it, which is how a list
gets its next item. Nothing matches quoted words, so editing a page can move where a step
lands and never makes one fail. The owner chose this over a separate script
note that quotes the text it attaches to (which silently drops a step once
those words change) and over generated lines (which take the words out of
their hands).

**Comments are the one step that quotes words**, because a comment is about
words: `Codex comments on "free, you cheapo": …` writes a real thread
(`comments.cjs`: the anchor markers and a line in the note's `comments`
block) around their first appearance, and `replies:` / `resolves` act on the
last thread that page's cast started. The margin then draws it as it draws
anybody's comment, a person's reply is typed into its line, and resolving
hides the card. If the quoted words are gone, that comment and its replies
do nothing rather than anchor elsewhere. A comment author written
`@jon's Claude` is an agent in the margin too, not a person.

**Only the homepage plays it; every served page is drawn without it.**
`renderWebsitePage` strips the blocks for every site, and the homepage's
snapshot keeps them so the homepage can split them out before building its
tree (`features/home/cast/castSite.ts`).

**The owner previews a script in the homepage itself, never in their
editor** (Dev2, 2026-09-28: "is there a way to preview how the cast
plays"). A note whose draft holds a cast block gets a play button beside the
eye, "Preview demo", which opens the homepage in a new tab with that draft,
unpublished and unsaved, as its only page (`features/home/castPreview.ts`).
It cannot play in the console's editor: that editor is bound to the real
note, and a show typed into it would be saved to the bucket as if the cast
had written it. The draft travels in the address's fragment
(`/#cast-preview=…`), which a browser never sends to a server, so the draft
lives only in that tab's address (and the browser's history of it). It
first went through a one-time key in browser storage, which broke twice over
(Dev2, 2026-09-29): the desktop app opens new windows in the person's own
browser, whose storage is not the app's, and a storage quota the offline note
cache has filled refuses the write. Anybody can build such an address, so the
homepage puts its own "Preview of an unpublished draft" callout above whatever
one carries, and a link cannot pass a stranger's words off as the front page.
Reloading the tab plays the show again, and what the preview shows is what visitors get after Publish.

**It is the console's presence, not a homepage animation.** Each page's show
is a local `SharedDoc` the web editor binds exactly as it binds a room
(`castPresence`), so typing arrives as a colleague's keystrokes do and the
carets, name flags, highlights, facepile, tree squares and agents line are
the console's own code drawing ordinary `PresenceMember`s and an
`AgentActivityView`. A change to how the console shows presence reaches the
homepage in the same commit, which is the standing rule for the homepage.
The two things added for it serve the console too: the chip draws an agent
as a square, and a `demo` presence says `· demo` in the chip, so nobody takes
a scripted @maya for a person watching them.

**An agent is named by whose it is**, in the cast and in the console alike
(the owner, 2026-09-27): several people's agents work in one shared
workspace, so the gateway's `presenceActor` names one `@jon's Claude`, and
the console draws that compactly (`agentName.ts`): the caret's flag reads
`jo Claude`, and a facepile avatar for an agent is a square with its owner's
initials. The full name stays in the chip's words, the agents list and the
flag's tooltip.

**The visitor comes first.** A change the visitor makes to a note ends that
note's show at once and the cast leaves it. Each page plays once a visit,
nothing is written anywhere but the visitor's in-tab copy, and with reduced
motion text lands whole instead of being typed.

**In the owner's editor a block is one row.** A cast block folds to
"▸ Demo script · N steps" while the caret is elsewhere, N being the steps the
shared parser will play from it (counted over the page, so a `replies` that
needs an earlier block's thread counts where it plays), and gives its source
back when the caret reaches it, the frontmatter's rule; tapping the row puts
the caret on its first line (`livePreview/castBlock.ts`). An unclosed block is
a line of text rather than a code block running to the end of the note, as
the shared parser already shows it (`livePreview/castGrammar.ts`). Web and the
iOS editor draw it from the same code.

**What a simplification costs.** Drawing the cast with homepage-only
components forks the shell the homepage exists to show. Anchoring steps by
quoted text makes routine edits break the show silently. Serving the blocks
on other sites prints the script as a code block on someone's public page.
`apps/mobile/__tests__/homeCast.test.ts`, `websiteCast.test.ts` and the cast
case in `apps/convex/__tests__/websiteResolution.test.ts` fail if any of
these comes back. Printing the script in the editor puts the page's loudest
lines where the owner writes it; `livePreview/castFences.test.ts` fails if
the row or its count goes, or an unclosed block swallows the note again.

## A website's design is code notes

_Decided by the owner, 2026-10-02._ `layout.html.md`, named layouts,
`*.css.md` and HTML pages, sanitized twice and never run on context.lc:
[websites/code-notes.md](./websites/code-notes.md).

## Every website is also at `<handle>.ctxlc.site`

_Decided by the owner, 2026-10-02._ The same release, by the same resolver,
on a domain of its own:
[websites/sites-domain.md](./websites/sites-domain.md).
