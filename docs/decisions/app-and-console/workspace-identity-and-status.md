# App and console — workspace identity and status

## A status wears a chip; a band is for what you have not been told

A `member` of a shared context read two full-width bands above every note,
every folder and every listing of it, on every load, with no way to put either
away:

> Team access — notes marked private are not shown here.
> This is Context's own workspace, not yours — read anything here, and use a
> form to file a bug or a request. Your own notes are never in it.

and two inches above both, the `team level only` chip the frame already draws
on every route. Three statements of one relationship, on the pinned
`@context-lc` — a workspace every account has in its rail and opens repeatedly.
The owner reported them as useless.

Each band arrived by a defensible step. The tier line moved from "the context
root only" to "every screen" because a team link opens straight into a note, so
the reader with the least context was the one nobody told — that argument is
right and is kept. The pinned line exists because "ask an owner for editor
access" is wrong for a workspace nobody invited you to. What neither argument
licensed is the screen they added up to: **a status drawn as news, twice.**

So the two are split by what they are.

**The fact is a status and stays permanent, in the one place a status costs
nothing.** `tierChipLabel` renders `team level only` in the pane head on every
route of the context, for exactly these readers, and `tierExplanation` holds
the paragraph on the members card for anybody who wonders what it means.
Neither moved, and between them "this view is filtered" is still stated on
every screen of the console.

**The sentence is a band, so it is shown until it is answered** — once per
context, with a *Got it* rather than a *Dismiss*, because it is read rather
than deferred. A first-time reader still lands in a filtered listing with the
line above it, which is the case the previous iteration existed for; that case
is a first screen, not every screen for ever.

**There is never more than one of it.** On the pinned context the pinned
sentence replaces the tier line rather than stacking over it: it already states
the whole relationship *and* the one thing a visitor can do, and "notes marked
private are not shown here" under it is a smaller claim about the same fact.
Elsewhere a `member` gets both halves in one paragraph, because what you cannot
see and what you cannot write are genuinely two facts.

**The demo keeps its line permanently**, and it is the one surface where that
is right: on the landing page the band reads "This is a demo. Sign in to edit
your own workspace", which is the page's call to action rather than an
orientation somebody finishes with. It is drawn with no control on it.

**The answer is a device flag, and here that is the right home** — the
opposite of the storage-layout migration's, whose whole lesson was that a
device flag was the wrong one. That answer was a fact about a *bucket*, which
the bucket itself knew, so a flag on one browser nagged every other. This one
is "has this person read a sentence about their own access": nothing else can
observe it, no table holds it, and a new browser telling somebody once more is
what a first-time reader gets anyway. The key carries the workspace *and* the
kind, so a `member` promoted to `editor` is told once that write access arrived
without the private notes coming with it.

**What it costs, plainly.** The read tier survives on the chip; the write half
has no equivalent, so a member who has answered and later tries to type gets an
editor that refuses the keystroke and no sentence saying why — the status row's
`Read-only` is about a file this console generates, not a context somebody
cannot write to. Accepted rather than overlooked: they dismissed a line that
had just said so, and the alternative was a band above every note for ever. If
it bites, the fix is a word in that status row, not this band returning.

**What a simplification costs.** Dropping the pinned rule stacks two bands
again on the workspace where they were reported. Dropping the kind from the key
answers a promotion in advance and silences the one conflation
`functions/files.ts` exists to prevent. Dropping the workspace from it lets one
context answer for every context somebody is ever shared into. Making the band
permanent again is this section in reverse; deleting it instead would leave a
stranger, landed by a team link in a listing with things absent from it, told
nothing at all. `apps/mobile/__tests__/contextIntroNotice.test.ts` and the
Browse cases in `consoleVisibilityRender.test.ts` fail.

## A workspace can wear a face, and the letter is what it falls back to

**Built.** The mark was one letter derived from the slug, and `WorkspaceMark`'s
own header argued for it well: a `Dot` could not say *which* workspace this is,
and a letter can. What the letter cannot do is survive a second workspace whose
name starts the same. `@seyi` and `@supa` draw the same **S**, in the same
square, in the same colour, side by side in the switcher, the foot row and the
settings panel — a control whose entire purpose is identity, telling you
nothing. That is the whole reason this exists, and it is why the answer is not
"a nicer letter".

**An icon is a photo, an emoji, or absent — and absent is the letter.** A union
on the row rather than two optional fields, because a mark shows one thing and
"photo set, emoji also set" would leave four drawing surfaces to invent their
own tie-break. Nothing is backfilled and no workspace is migrated: a context
that has chosen nothing draws exactly what it drew before, which is what makes
this additive rather than a change to every rail in existence.

**This reverses a comment, deliberately, and the comment is worth quoting
because its reasoning was sound.** `OverviewPanel` said of its monogram: *"the
initial of the name, not an avatar. There are no pictures anywhere in this
product and inventing one here would be the only place a context had a face."*
Every clause of that is true and the conclusion still does not follow, for one
reason: the face is no longer *invented*. A picture nobody chose is decoration,
and a product with one decoration is inconsistent. A picture its owner chose is
data — the same kind of data as `displayName`, and load-bearing in the same way.

**The photo is content, so it lives in the customer's bucket.** In the opaque
image store under `IMAGE_PREFIX`, where a pasted image already goes, named from
a content hash with an `icon-` prefix so somebody reading their own objects can
see where each came from. **The control plane records the leaf and never the
bytes** — non-negotiable #1, and the concrete consequence is that revoking our
credential leaves a person with their workspace icons, in a folder, as files.
An emoji is not content: it is a handful of code points that mean nothing
outside the row, so it sits beside `displayName` where every reader of the row
already is.

### The read path takes no object name, and that is the security argument

An image in the opaque store **has no visibility of its own.** It borrows the
visibility of the notes that reference it, which is what keeps the store from
drifting out of step with `privacy.md`, and `read_image` and `readNoteImage` are
both built on exactly that gate: name a note you can see, and the image must be
mentioned in it.

**A workspace icon has no note.** The obvious move is to widen the gate, and it
is the wrong one — a second way into the image store is a second thing to keep
correct forever. So `workspaceIconPhoto` takes **only a `workspaceId`**, and
reads the leaf off the workspace row. There is no argument through which a
caller can name an object, so it cannot be turned into a general object reader
however it is called: the set of objects it can ever return is at most one per
workspace, chosen by that workspace's owner. That makes it strictly *narrower*
than the note path rather than wider, which is the only reason it is allowed to
exist beside it. `workspaceIcon.test.ts` asserts the argument shape off the
registered validator — not off the source text — because "there is no leaf
argument" is the property doing the work, and a later convenience parameter
would end it in silence.

**Owner-only, and the role is stricter than the paste path's on purpose.**
`storeNoteImage` takes an editor, because writing bytes to the bucket is editor
work. Setting an icon writes bytes *and* changes what every member of a shared
workspace sees on their own screen, so it takes the role that owns the
workspace's other facts. A sabotage run found the suite could not see that outer
check at all — `recordWorkspaceIconPhoto` refuses a non-owner too, so the action
still failed and every assertion still held, while an editor's bytes had by then
reached the customer's bucket. The test now asserts that the refusal happens
*before* the write, which is what the outer check is actually for.

### The emoji rule is structural, and the list is ours

`isSingleEmoji` is not a length check. The value is drawn in an 18pt square on
the screen of every member of the workspace, so what has to be refused is not
"too long" but "not one glyph": plain text, a right-to-left override, a
combining stack that draws over the row above. The rule is one emoji *unit* —
pictographic base, regional-indicator pair, tag sequence, or keycap — optionally
joined by ZWJ, and nothing else in the string. It lives in `packages/shared`
because the picker pre-flights the same function, and two copies of it would be
a picker offering what the server refuses.

The picker offers a **curated list** rather than the system keyboard: React
Native has no emoji picker, the OS keyboard is unavailable on web, and a
free-text field is how the override above gets in. The list is the picker's
offer and never the API's rule — anything `isSingleEmoji` accepts is storable.

### Drawing a mark must not need a backend

The first version of the console half put `useAction` inside the hook that
resolves an icon, which is the obvious shape and is a **product** bug rather
than a testing inconvenience: `useAction` throws outside a `ConvexProvider`, and
three of the four surfaces that draw a mark are mounted without one — the
landing page mounts a picture of the console, and the demo console has no
backend at all. A mark that needs a Convex client is a marketing page that
crashes.

So reading is separated from fetching. `useWorkspaceIcons` imports nothing from
Convex and only reads a module-scope cache; `prefetchWorkspacePhotos` is called
from `useLiveConsoleData`, the one place a client is guaranteed because it is the
hook that runs the queries. A surface with no backend draws emoji and letters
correctly and never asks for a photo, which is right — it has no real workspace
to ask about.

**The cache is keyed on workspace *and* leaf, and that is isolation rather than
bookkeeping.** A leaf is a hash of the bytes, so the same leaf in two workspaces
is two objects in two buckets; a cache keyed on the leaf alone would serve one
customer's photo to another with no request ever crossing a boundary the server
could refuse. The client is the only place that can be wrong about this, so it
is the only place that can guard it, and `workspaceIcon.test.ts` in the app does.

Cached forever, because the leaf is a content hash: the same key is the same
bytes in this session and every other, and changing an icon changes its leaf. A
photo that fails to load is remembered as missing so a broken bucket costs one
request rather than one per render — the mark falls back to the letter, so that
failure is invisible and therefore has to be cheap.

**A photo keeps the status ring.** The mark's fill is `tone`, which is how a
workspace whose storage is in trouble stays the thing your eye lands on, and a
photo covers the fill. It is inset by a point so the tone survives as the edge
around it: two facts on one 18pt object, whose it is and whether it is working.

### What is not built, stated rather than implied

There is **no image resizing**: `expo-image-manipulator` is not a dependency and
adding it would mean a native module and a new development build for every
contributor, so the square crop and the compression are the system picker's
(`allowsEditing`, `aspect: [1,1]`, `quality`). A photo that is still over
`WORKSPACE_ICON_MAX_BYTES` after that is refused in words rather than silently
downscaled. The cap is a mebibyte — a fifth of what the image store allows a
paste — because the console draws this square once per workspace per paint.

`gif`, `heic` and `heif` are accepted by the image store and **not** by an icon:
a `gif` is the only one that can move, and an avatar that animates in a settings
rail is a decision nobody asked for; `heic`/`heif` are what an iPhone holds a
photo as and what no browser draws, so a mark chosen on a phone would be a blank
square on the web app.

Clearing an icon **does not delete the object**. The store is content-addressed,
so those bytes may equally be another workspace's icon or a note's embed, and it
is the customer's bucket: an object we put there is theirs to remove.

A **person** still has no picture. `AccountBlock`'s `Avatar` is a 26pt circle
with initials in it and stays that way — this is a fact about a workspace, and
the two are different objects, which is the same reason they were never one
component.

