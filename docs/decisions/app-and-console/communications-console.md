# App and console — communications console

### The communications console reads through `FileBrowser`, not a new tool

`docs/decisions/communications.md` decided the on-bucket shape and the
gateway's `list_channel_days`/`read_channel_day`. The console's Inbox,
Channel, Channel-day and Contact pages read the **same bucket** through the
**same interface** every other console screen already uses —
`apps/mobile/features/console/files/browser.ts`'s `FileBrowser`, backed by
`listFiles`/`readNote` — rather than a fifth Convex action shaped around
these four views. Two members were added to that interface, both read-only
and both already the shape a demo and a real browser can each answer:

- **`ensureListing(path)`** — fetch a folder's listing into the cache without
  selecting it. The Inbox needs several folders at once (`0-inbox`,
  `0-inbox/email`, and every channel folder it finds) and none of them is "the
  folder somebody navigated into", which is the only case `select` already
  covered.
- **`readRaw(path)`** — a note's text and etag, without opening it in the
  editor. A channel-day's split parts and a contact's linked days are reads
  that are not "the open note", and routing them through `select`/`editor`
  would mean a `NoteEditor` momentarily holding a day's raw markdown on the
  way to `ChannelDayView` parsing it back out.

**Both promise nothing beyond what a listing or a read already promises.**
`ensureListing` is a cache-fill, not a subscription — a caller that wants a
fresh copy after a write already has `select`/`refresh` for that. `readRaw`
answers `null` for a path this scope cannot see, byte-identically to a path
that does not exist — the same non-negotiable `read_note` and
`read_channel_day` already hold the gateway to, now held by the console's own
read path rather than assumed to follow from it. `useDemoFileBrowser`
implements both against `tree.listings`/`tree.notes`, which are already
built whole and synchronously, so `ensureListing` is a no-op there and
`readRaw` never touches a network — the same "one interface, two
implementations" rule the rest of `browser.ts` documents.

**Why not a fifth Convex action instead.** `list_channel_days` and
`read_channel_day` exist because an MCP tool call is the unit an AI client
reasons in — a listing and a read of one note, message bodies withheld by
default because a model was not asked for them. The console is not an AI
client: it already has a general file browser that lists folders and reads
notes with `canSee` applied identically, and building a second, console-only
"list channel days" action would be two implementations of one visibility
rule with two chances to disagree about which paths a team caller may
enumerate. `discoverInboxChannels`, `collateChannelDays` and
`shapeChannelDay` (`features/console/communications/{inbox,channel,day}.ts`)
do the shaping this console needs entirely client-side, over listings and
reads the gateway already filtered — no index, nothing that can drift from
the bucket, the same property the Inbox landing page's own virtuality argues
for one layer up.

The check is `commsPaths.test.ts` and `commsInbox.test.ts`: every shaping
function is pure, fed `FileEntry[]`/`{text, etag}` shapes a fixture builds by
hand, with no `FileBrowser`, no Convex client and no bucket anywhere in the
test.

#### Meetings stays a generic folder; only the three messaging channels get a day view

`classifyCommsPath` routes `0-inbox/email/<slug>`, `0-inbox/google-chat` and
`0-inbox/imessage` to `ChannelView`/`ChannelDayView`, and deliberately answers
`null` for `0-inbox/meetings` — the ordinary `FolderView` keeps listing it.
**A channel-day note is one file standing for a whole day; a meeting note is
one file standing for one meeting**, and several can land on the same date
with nothing in common beyond it. Building a "day" view for meetings would
mean inventing a grouping nobody asked for — the scoping note's own tree
lists `meetings` beside the messaging channels as an Inbox *child*, for
recency, not as a second channel-day shape. `inbox.ts`'s `activeDatesFor`
reads a meeting's date off its filename (every meeting note begins
`YYYY-MM-DD-`, per `packages/meetings`'s own `MEETING_FILE`) for the same
reason the Inbox is virtual at all: reading every meeting's frontmatter just
to sort the landing page by date would spend a body-read this page exists to
avoid paying.

`0-inbox/contacts` is `null` from `classifyCommsPath` in the same way and for
a related reason: it is a row on the Inbox (`inbox.ts` treats `contacts` as a
fifth `InboxKind`, reading its recency off the listing's own `updatedAt`
rather than any content — a contact page is edited, not dated by a channel),
but the *folder* is a generic listing of contact pages. A nicer list —
showing each contact's own name rather than its filename slug — is a real
improvement and is deliberately not built here: it would need reading every
contact's frontmatter for a folder listing, which is the same cost this
whole page structure exists to avoid, and is a candidate for a small,
separate index the day it is worth one.

The check is `commsPaths.test.ts`'s `"meetings is never a comms route"` and
`channel.ts`'s own header, which states the asymmetry rather than leaving it
to be rediscovered as a gap.

#### A note's anchor is a query parameter, not a URL fragment

`noteHref(slug, path, anchor)` writes `/console/@slug?note=<path>&anchor=<id>`
— never a literal `#<id>` on the end of the URL, even though every wikilink
this product writes (`[[path#anchor]]`) and the decision that named this
routing contract both use `#` as the separator. The mismatch is deliberate:
`useLocalSearchParams` reads query parameters identically on web and native,
and Expo Router's linking config has no cross-platform contract for a bare
URL fragment the way a browser does — native has no address bar for one to
survive in at all. A query parameter is the shape `?note=` already uses for
exactly this reason, so the anchor rides the same mechanism rather than
inventing a second one that only works on web. `anchorFromQuery` is the read
side, deliberately as permissive as `noteFromQuery`: absent, empty or
whitespace all mean "no anchor", never a refusal — an anchor is never used to
address storage (only to find a heading already on the page), so it does not
need `safeNotePath`'s path-traversal refusals.

**This is the routing contract the task named "expose the anchor scroll as
the routing contract they can use."** A contact's activity link
(`ContactPageView`'s `onOpenActivity`) and a future per-anchor search result
call the identical function with the identical two arguments; there is
exactly one way in this console to say "open this note and scroll to this
place in it," and it is `noteHref`'s third argument.

**`useNoteUrl` clears `?anchor=` on every write, and this was a real bug
caught before it shipped rather than a defensive habit.** `setParams` merges
rather than replaces: following an activity link to `?note=A&anchor=X` and
then tapping an ordinary row to open note `B` — through `select`, never
through `noteHref` — left the address at `?note=B&anchor=X`, a stale anchor
for a message that is not even in `B`, read back the next time anybody
opened that URL. `useNoteUrl` is the *reconciliation* path (the browser's own
selection moved and the URL is catching up), which is never the path that
means to name an anchor, so it always writes `anchor: undefined` alongside
whatever `note` it writes. The check is `noteUrlAnchor.test.ts`.

#### A message body is rendered, never linkified

`ChannelDayView`'s messages render `**bold**`, `*italic*` and `` `code` ``
(`markdownInline.ts`'s `tokenizeInline`) and stop there — `[[wikilink]]` and
`[markdown](links)` inside a message body are shown as the literal characters
a sender typed, never turned into a pressable link. This is not an
unfinished feature; it is the read side of a defence `packages/communications`
already built and named: `note.js` fences every message body and explicitly
does **not** run it through `defangLinks`, because the body is meant to be
quoted verbatim inside the fence — "Bodies are deliberately NOT put through
this — they are quoted verbatim inside a fence," in that file's own words.
A sender's `[[.audit/anything]]` or a phishing `[click here](https://…)`
therefore survives in the rendered note exactly as written, and the fence
(plus the note's own preamble, addressed to any AI assistant reading it) is
what keeps every *other* reader from treating it as structure. A console
that turned that same bracket syntax back into a live, followable link would
be the one reader that undoes the fence — choosing where the owner's own
console navigates on a stranger's say-so, from the one field this product
puts the least trust in.

`tokenizeInline` enforces this structurally rather than by discipline: it has
no rule for `[`, `]`, `(` or `)` at all, so there is no code path in it that
could resolve a link even by accident. The check is
`commsMarkdownInline.test.ts`'s hostile-string cases — a wikilink and a
markdown link, tokenized and reassembled, come back byte-identical to the
input, with none of the resulting tokens carrying `bold`/`italic`/`code`.

#### `jest-environment-jsdom` has no `TextEncoder`, and this console's own import chain is what found it

`@context/communications`'s `note.js` and `anchors.js` each construct a
`TextEncoder` — one for the split planner's byte budget, one for the message
anchor hash. Real engines all have `TextEncoder` as a global; this
repository's `jest-environment-jsdom` does not, measured directly rather than
assumed (`typeof TextEncoder` under a bare `@jest-environment jsdom` file
answers `"undefined"`). That gap was invisible for the whole life of the
package, because nothing that imported it ever ran under jsdom — until
`BrowsePane` learned to import `@context/communications` transitively, at
which point **26 suites failed on a bare `ReferenceError`**, none of them
about anything this feature touches.

Two independent fixes, deliberately both kept rather than picking one:

- **`note.js`'s encoder is built lazily**, on first call to `utf8Length`
  rather than at module load. Parsing a day back — this console's own
  `parseChannelDayMessages` — never reaches it at all, so a reader that only
  imports the parser should never pay for, or crash on, a rendering concern
  it does not use. `test.mjs` asserts this at the source level, against every
  file in the package, so the same mistake in a file added later fails the
  package's own suite rather than whichever app happens to import it under
  jsdom first.
- **`apps/mobile/jest.setup.js` polyfills `TextEncoder`/`TextDecoder`** from
  `node:util` when the global is missing. This is closing a gap in the test
  double, not changing what the product runs against: every engine this app
  ships to — Safari, Chrome, the WebKit `apps/mobile/e2e/webkit` drives —
  already has both, so the fixture's own `messageAnchor` call in
  `placeholderData.ts` (needed so a contact's activity link and the message
  it names carry the *same* hash, not two numbers kept in sync by hand) is
  reaching for something every real reader of this code already has.

The lazy fix alone was not enough — `placeholderData.ts` computes a message
anchor eagerly, at fixture-build time, for reasons the fixture itself needs
— and the polyfill alone would have been enough on its own but leaves a
future rendering call inside `note.js` paying for a `TextEncoder` nothing
asked it to build. `commsImportUnderJsdom.test.ts` pins both: that the
package imports and parses under jsdom, and that the polyfill is what makes
`TextEncoder` present there at all.

#### An activity link's path has no `.md`, and the console puts it back at the one seam that needs it

`activityLink` (in `@context/communications`) writes `[[path#anchor|label]]`
with the `.md` stripped, because it is writing an Obsidian wikilink target
and a wikilink never carries the extension — the same convention every
wikilink in this product follows. `parseContactView` reads that convention
back faithfully: `ContactActivity.path` has no `.md`, and it should not,
because it is reporting what the page says. This console's own navigation is
not wikilink resolution, though — `files.select` and `noteHref` both work on
real bucket paths, and `isMarkdown`/`select`'s folder-or-file guess reads "no
`.md`" as "this must be a folder." Calling `onOpenActivity` with the raw
parsed path opened the *console's own root folder* instead of the linked
day — caught by the WebKit case rather than shipped, because
`commsInbox.test.ts`'s fixtures never exercise real navigation and nothing
about the shaping layer is wrong here. `ContactPageView` restores the suffix
with `ensureMarkdown` at the point it calls `onOpenActivity` — the one seam
between "how a link is written" and "how this console opens one" — rather
than changing what `parseContactView` reports, which stays a faithful read
of the page.

#### Connecting a mailbox is a flag; reading one that is already connected is not

`MAIL_CONNECT_ENABLED` (`features/console/communications/flags.ts`) gates the
Inbox's empty-state "Connect a mailbox" offer, off by default, on only via
`EXPO_PUBLIC_MAIL_CONNECT_ENABLED=1` at export time — the same
build-time-only shape `EXPO_PUBLIC_E2E_FIXTURE` already uses. This is
`docs/decisions/communications.md`'s *the Gmail restricted scope is Google's
decision*, read onto the one screen that would otherwise have to guess at it:
reading a mailbox needs `gmail.readonly`, and until Google's verification of
this product's use of that scope lands, the honest answer to "can I connect
one" is no — never a button that looks pressable and fails, and never a
button quietly hidden with no explanation, which is its own kind of dishonest
for a person who came looking for exactly this. The flag's docstring says so
in the same words a person reads on screen when it is off.

**The gate is on the connection, never on the rendering.** Every view this
change ships — the Inbox row, the Channel and Channel-day views, a contact's
activity links — reads whatever mailbox is already connected, by hand or on
a fixture, whether or not this flag is on. Flipping it later changes nothing
about any of those; it only changes whether the empty state's button does
something.

### The compact corner was two controls, and one of them was a silent sign-out

"the setting button should be merged with the person icon, right now all it
does is sign you out." `ConsoleRail.tsx`'s `AccountBlock` drew `compact` as a
gear and the avatar, 4pt apart, each its own 44×44 `PressRow` — and the
avatar's `onPress` was `onSignOut` directly. `useSignOutFlow.requestSignOut`
only raises `Confirm` when the device holds unsent edits; on a clean queue it
calls `signOutNow()` immediately. So the one control in that corner reachable
with **no confirmation at all** was also the one a thumb was most likely to
land on by a few points of error, next to a gear it looked just like.

The fix is not a confirmation dialog bolted onto the avatar — that is a third
answer to "what happens when I press this" competing with the two the corner
already gave conflicting cues about. It is one control: the avatar opens a
menu naming both actions, and choosing one is a second, separate press. Two
deliberate presses *is* the missing confirmation for the clean-queue case,
built out of the same mechanism the non-empty-queue case already uses
(a second gesture before anything happens), rather than a second, different
mechanism beside it. `useSignOutFlow`'s own `Confirm` dialog is untouched and
still fires for the non-empty case — this closes the gap on the other side of
that `if`, not the dialog itself.

**Drawn with `features/design/components/Menu.tsx` / `Menu.web.tsx`, not a
third menu idiom.** Those two files already are a disclosure menu component
— a title, danger rows, a Cancel row, a sheet on touch and a popover on a
pointer picked by `layout.narrowBreakpoint` — built for `Explorer.tsx`'s
right-click and long-press. They were typed to `menu.ts`'s `MenuActionId`,
the file tree's own closed action union, which made them look like "the file
menu's renderer" rather than what they actually are. Widening
`MenuActionId` itself to fit an account action was the tempting fix and the
wrong one: `Explorer.tsx`'s `runAction` switches on every member of that
union, so a case with nothing to do with files would have needed a branch
there forever, for a menu that file never draws. `MenuItem`/`MenuProps` are
generic in their own id (`Id extends string = MenuActionId`) instead —
default-typed so every existing file-menu call site is unchanged, and open to
a caller with its own two-item union. `MenuItem.testID` is the one other
addition, because `account-settings` / `account-sign-out` predate this menu
and are cited by name rather than by the `menu-item-<id>` convention every
other row uses; `MenuProps.titleDetail` is the other, because the sheet's
title had nowhere to put an email under a name until this needed one.

**The harm the two-control layout caused, restated for the record, because
it is also why `accountSettingsControl.test.ts`'s central claim did not
reverse.** That file used to assert "signing out and opening settings are
different intentions and must not share a control" — true, and it is still
true of the *compact* form now that both live behind one press. What made the
old layout dangerous was never that two things were reachable near each
other; it was that a coloured disc's only disambiguation from its neighbour
was an `aria-label` nobody speaking to a screen reads before landing a thumb
on it — one control, two possible unannounced outcomes depending on four
points of horizontal error. A menu with two rows that say "Settings…" and
"Sign out" in words is strictly *more* explicit than that pair of circles
ever was, which is why sharing a trigger is the fix rather than the
regression the old sentence would suggest on a literal reading.

**The full (non-`compact`) rail foot is untouched.** `rail-settings` and
`rail-sign-out` stay exactly as they were — two 28pt targets beside a name,
which is a rail foot with room, not a 44×44 corner with none. Merging them
too would be solving a problem that surface does not have.

#### The popover this menu draws had to learn to portal, on its first real caller

`Menu.web.tsx` existed before the account menu — `Explorer.tsx`'s right-click
and long-press were already drawing its `Sheet`/`Popover` pair, mounted the
same way: as a child of the tree's own root `View`, which is itself an earlier
sibling of the editor region in `AppFrame.tsx`'s `styles.body`. Nothing here
rules out the same defect already being live there — a menu anchored near the
right edge of a narrow explorer column has the same `MIN_WIDTH: 200` to spill
past the boundary with — it is simply not the call site that happened to get
measured against overlapping content first. `AccountMenuTrigger` is the one
that did: it sits at the foot of the rail, itself an earlier sibling of the
same editor region, and its popover has to spill out past the rail's own
(narrower still) width to show ~200pt of menu — straight into the editor
region's screen space, where this branch's own "Make private" / "Share…" pair
happened to be sitting.

That is exactly **Every react-native-web `View` is a stacking context** (above)
with a new subject. `Popover`'s box carried `position: fixed` and `zIndex:
1000` from the start, and both are true and irrelevant: they order this popover
among the *descendants* of whichever `View` it renders inside, because that
`View` carries RNW's base `position: relative; z-index: 0` like every other
one, and the editor region is a later sibling competing at the *parent's*
level, not this one's. `Sheet`, the touch presentation right above this in the
same file, never had the problem — it is a `Modal`, and `react-native-web`'s
`Modal` already portals to `document.body` for this exact reason, which is why
`SettingsOverlay` and every touch case in `settings.spec.ts` were never at
risk. `Popover` was the one presentation in this file that skipped `Modal`
and grew its own `position: fixed` box instead, so it was the one presentation
that still owed itself a portal.

Found by `settings.spec.ts`'s pointer-width case, not by anything in
`__tests__/`: jsdom lays nothing out, so no unit suite can see one region paint
over another, and `menuRender.test.ts`'s own popover queries already read from
`document.body` rather than the mount `container` — which happened to make
that file agnostic to whether the popover was portaled, so it stayed green on
both sides of this fix and proved nothing about it either way. Only a real
engine, hit-testing a real click at a real coordinate, produced a Chromium
timeout naming the actual culprit: "`<div>Make private</div>` … subtree
intercepts pointer events." `Popover` now renders through `createPortal(...,
document.body)`, the same escape `ModalPortal` already uses, so it stacks at
the true top level rather than within whichever `View` happens to be its
parent. `Sheet` is untouched — it already had this for free.

What a "simplification" of this costs: reverting to an inline `Popover` puts
this exact defect back — for the account menu, demonstrably, and possibly for
`Explorer.tsx`'s own context menu too, which nothing here has gone back to
verify one way or the other. The portal is a property of the component rather
than a fact about any one caller, which is the point of fixing it here instead
of working around it at the account menu's own call site.

### The breadcrumb head stopped being a switcher pill when it moved rows

"the button for @seyi is too big." Measured at 390×844: the head mark was
68.1×34 — 43% of that width chrome (8+8 padding, 6 gap, 7 dot) — carrying a
13px label beside an 11px leaf it sits on the same line as. It was also,
literally, the identical object **A context pill's target is not its mark**
(above) argues for: same `layout.stripPill` 34, same `radii.md`, same
`shadows.floating`, same `wsSwitch` 13px label. That section is not reversed
by this one — read again, it is an argument about the **switcher** pill,
made when the switcher and the breadcrumb's head were the same object worn
in two places, and it is still correct about that pill today. `stripPill`
keeps its height and its shadow untouched; `contextStrip.test.ts`'s two
positive controls for both stay green.

What changed is that the two stopped being the same object the moment
**The contexts moved into the scroller** (above) put them on two different
rows meaning two different things: row one is a list of places to switch
*to*, so each pill needs the full switcher target and a shadow to read as a
floating control while somebody scrolls past whatever is under it. Row two's
head is not a list — it is naming the one context you are already standing
in, beside the path to the note you are reading — and a control drawn
identically to the list above it reads as "this is also a place to switch
to", in the wrong colour. Two facts ("go there" and "you are here") drawn as
the same shape in two colours is weaker than the same shape used once and a
colour carrying the second fact alone.

So `Pill` gained a `head` variant rather than the breadcrumb growing a second
pill implementation — that file's own rule is that a second implementation
is how the strip and the breadcrumb come to disagree about what a context
looks like, and it was right the first time this was built. `head` differs
from the switcher mark in exactly the four ways that made it read as a
second switcher: `layout.crumbPill` (26) rather than `stripPill` (34), no
`boxShadow`, `radii.xs` rather than `radii.md`, and an 11px mono label
matching the leaf's own size and weight rather than `wsSwitch`'s 13px body
face — so colour (`accentDim`/`accentText`, unchanged) is what says "this is
the context", and the row reads as one line rather than two chrome weights
stacked on each other. The dot goes too: `toneForKind` exists to tell
contexts apart *in a list*, and a list of the one context you are standing
in has nothing left to tell apart.

**Dropping the shadow is itself a small instance of the same lesson**, worth
naming on its own: `pill`'s own docblock justified `shadows.floating` with
"the top row has no surface of its own… so anything on it that is not drawn
as an object has nothing behind it," which was true while this row floated in
`AppFrame`'s `topBarCompact`. **The contexts moved into the scroller** made
that premise stop being true for both rows — they now sit above the pane's
own surface — and the switcher pill keeps the shadow anyway, because it is
still read at a glance while scrolling past whatever is under it, which is
exactly the case a floating mark is for. The head has no such case: it does
not move independently of the text beside it, so the premise that used to
justify the shadow everywhere on this row now justifies it for only one of
the two pills on it.

**The target does not move, and this is not a second exception to
`minTouchTarget`.** `styles.target` stays `layout.minTouchTarget` on both
axes for `head` exactly as for the switcher — the mark shrank, the pressable
around it did not, which is `accountAvatar`'s rule applied to a case that
already had it half right (a smaller mark, a target that was already at the
floor because `styles.target` never depended on the mark's own size). A
two-character slug's head is still held at 44 by `minWidth`.

**The visible payoff is a few more characters of the note's own title.**
`Breadcrumb.tsx`'s `phoneRowBudget` estimates the pill's footprint to decide
how many characters the leaf may keep before it elides, and it was still
budgeting for the switcher pill's chrome and label size after this fix —
`pillChromePx` at `space.x2*2 + 6 + 8` (the padding, the gap, the dot) and
`pillLabelPx` at a 13px body glyph. Left uncorrected the leaf would still
truncate at the old, wider pill's width even though the real one had
shrunk — safe (the bias is to overestimate the room the pill takes, so the
error only ever costs a folder segment, never the leaf), but it would leave
on the table exactly the room this fix bought. `pillChromePx` is `6 * 2` now
(`layout.crumbPill`'s own padding, no dot, no gap for one) and `pillLabelPx`
is `contextLabel.length * 7.0` (11px mono, the leaf's own face).
`breadcrumbPath.test.ts`'s "a narrower head yields more leaf characters for
the same path" pins the direction of that difference against the real
`phoneRowBudget`, not a re-derived copy of it.

What a simplification of any of this costs: restoring the switcher's
`stripPill`/`shadows.floating`/`wsSwitch` sizing to the head puts the 68.1pt
mark back over an 11px leaf; dropping the dot's removal or the label's size
match puts the two-signals-for-one-fact problem back in a smaller box;
reverting `phoneRowBudget`'s constants leaves the leaf truncating at the old
pill's width forever, silently. `navBand.test.ts`'s "the head of the path is
quieter than the switcher above it" and `breadcrumbPath.test.ts`'s new case
each fail on their own piece of this and nothing else, and `contextStrip.
test.ts:518` — the strip pill's own 34pt — is the positive control that
proves the switcher itself was never touched.

