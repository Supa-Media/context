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
live site and nothing replaces it**. `/site/home` lists and reads the folder
at `PUBLICATION_CLEARANCE` (`lib/websites/snapshot.ts`), so a note
`privacy.md` holds back is absent from the listing itself, and drafts,
members-only and encrypted notes are dropped as they are on the site.

A visitor can edit it the way they would their own workspace: press Edit on a
note, make notes and folders, rename, move, copy and delete. **None of it
leaves the tab** (`apps/mobile/features/home/useLocalFileBrowser.ts`): there is
no bucket behind that tree, a reload is the site again, and sharing,
visibility and downloads stay off because each is a claim about a real
workspace. Until the visitor changes something the tree follows the site; after
that it is theirs. There is no call to action in the top bar: the page is the
product, and a signed-out visitor gets Sign in.

A visit decides once between the site and the built-in copy
(`apps/mobile/features/home/homeSnapshot.ts`): with no block in the HTML the
app asks, draws nothing until it hears, and falls back to `builtInPages.ts`
for the whole visit if the site is off or silent. The copy is never drawn and
then swapped for the site. The site is redrawn only when its revision moves,
which is somebody editing `website/`.

`siteHome.test.ts` fails if a private, draft or members-only note leaves,
if an unlisted note is missing, if another handle gets an answer, or if the
route grows a field; `homeLocalBrowser.test.ts` fails if the site rewrites a
tree the visitor has changed; `homeSite.test.ts` in the router fails
if a page's words can close the block; `homeSite.test.ts` in the app fails if
the copy can replace the site or the site the copy.
