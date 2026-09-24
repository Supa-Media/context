# Privacy and sharing — short links and collect links

### A short link is a second locator, never a second tier

`context.lc/@seyi/intake`. Decided with the owner, 2026-09-20, alongside the
forms work it exists for: a link that goes in an email signature, on a card, or
into a sentence somebody says out loud.

**It gives up the one property that makes `/s/<64 hex>` safe**, and that is the
feature rather than a flaw in it. A token is unguessable, so possession implies
the owner handed it over; a name is typeable, so possession implies only that
somebody typed it. On an `anyone` share, where possession *is* the
authorization, claiming a name is publishing that note to whoever guesses the
word.

So the whole design is about making that the only thing it changes.

- **The row is the share row.** `slug` is a field on `noteShares`. A short link
  resolves to the same row its token resolves to, is authorised by the same
  `authorizeShareRead`, is re-derived through the live `privacy.md` on every
  read, and dies on the same `revokeShare`. There is no second read path, which
  is why there is no second place for one to drift.
- **The token never reaches the browser.** `shortLinkToken` is an
  `internalQuery` and `readShortLink` consumes it in the same request. A client
  that was handed it could keep it after the name was released — a capability
  outliving the address it was published at — so what comes back is the note or
  a refusal, never the credential. `ShareScreen` takes an address, not a token,
  and builds every onward URL and the sign-in `next` from it.
- **Claiming is its own deliberate step**, not something minting a link does on
  the way past, and the console says the cost in the same breath: *a short link
  is memorable, which means guessable.* On a `members` link that sentence is
  **not** drawn — a guessed name opens nothing there, and a dialog that warns
  on both is one people learn to dismiss.
- **A name the product writes cannot be claimed.** `shortLinkSlugRejection`
  refuses `isProductMandatedPath` as both the folder and the file, plus a short
  reserved list for words the console may want under a handle. Today notes live
  at `/console/@name?note=…` and there is no collision to have; `CLAUDE.md`
  keeps the door open for `@name/1-projects/foo.md` as sugar, and a slug claimed
  now would have to be taken from somebody to open it.
- **One live row per `(workspace, slug)`**, checked through `by_workspace_slug`
  in the same mutation that writes — Convex serialises it, so there is no
  window. A revoked row frees its name, because the alternative is a word an
  owner has permanently spent on their own context.

**The card names the note, and this is the fourth unauthenticated route.** The
list in `structure.test.ts` called itself "a pin, not an amnesty", and the
argument is made again here rather than inherited: the probe space is names the
*owner* typed, there is no list of likely slugs, and the guessable ones cannot
be claimed. It is **one** field where `/share/note` is three, and the missing
one is the point — `cardToken` is safe there because a team link's token is a
locator, and it would be a capability here. A short link therefore unfurls with
a title and the product's own image, never a per-share card. The cost is the
one every card carries and cannot take back: a card already unfurled is cached
by the platform that unfurled it. Revocation is enforced at the destination,
where it is immediate and complete.

**The shape rule now lives in four places** — the control plane, the edge
router, the app's route, and the console's field — because none of them can
import the others and each wants to refuse before a round trip.
`shortLinkSlug.fixtures.json` is what holds them together: all three of the
first are run against it, and the fourth refuses nothing the server does not
refuse again.

**`/@seyi` itself is unchanged and still frozen.** A handle is guessable *and*
unbounded, which is the combination `Link previews reveal nothing about a
context` exists for. What changed is a second segment that only exists because
somebody typed it.

### A short link has its own card, because a card need not be addressed by a token

Short links unfurled with the product's marketing image while every other link
this product mints got a picture of the note's name. The reason was written
down and was sound: a card was addressable **only by the share's token**, a
slug is a word anybody can type, and a preview route that answered a guessed
word with a 64-character secret publishes the secret. `/share/short` therefore
returned no token, and `previewForShortLink` had nothing to point at.

What was wrong was not the reasoning but a premise underneath it that nobody
had written as an assumption: *a card is addressed by the token*. It does not
have to be. `/og/n/@seyi/intake.png` addresses the same pre-rendered picture by
**the handle and slug the crawler already used to ask for the title**, so the
image arrives and the token stays exactly where it was.

**Nothing new is disclosed, and that is the test this has to pass.** The card
says the note's name. The name is what `/share/short` already answers with, to
the same unauthenticated caller, at the same guessable address. A second way to
learn a fact you could already learn is not a disclosure.

**Every refusal the token route makes, this one makes, plus one.** Active,
unexpired, `titleInPreview`, and a leaf recomputed rather than trusted — that
last because a failed render leaves the old leaf in place, and a card is the
one thing here that cannot be taken back once Discord or iMessage has copied
it. The extra refusal is `recipientKind === "anyone"`, which
`previewForShortLink` already applies to the title and which applies at least
as hard to a picture: a memorable address over a link shared with *named
people* must not put their note's name in front of somebody who guessed the
word. It is enforced again rather than inherited, because these are two routes
and a crawler can ask either.

**The cache-buster is a digest, not the ingredients.** The edge cannot
invalidate an image — the Workers Cache API is per-datacenter and
`cache.delete` purges one colo — so a different URL is the only invalidation
there is. `shareCardPath` gets that by hashing the title it already holds; this
route's caller cannot, because a folder card also draws two or three names from
inside the folder and *those* are not what a short link's preview discloses. So
`cardVersion` comes back pre-computed and the edge never sees them.

**`structure.test.ts` said this would happen and named the wrong fix.** Its
comment read: "the shape of this addition, a year from now, is somebody
noticing that short links have no card image and fixing it by copying the field
from the route above." That is still the wrong fix and the forbidden-field list
is unchanged; the test now says so beside the right one.

### A collect link is a write path, and the only one with no account behind it

Non-negotiable #5 says a link an owner mints and can revoke is the single
exception to "`team` never means public", and everything built on it so far has
been a *read*. A collect link is the same row with `mode: "collect"` and it is
not a read: a stranger with no session, no handle and no invitation appends to a
file in somebody's bucket. That is what an intake form *is* — the feature is
worthless if the people filling it in need accounts — and it is worth writing
down exactly how far it goes, because "the owner published a URL" is the whole
authorization.

**It is a mode on the share row, not a third audience and not a word in
`privacy.md`.** `Scope` stays two-valued. The row is still minted by an owner,
still revoked by the same `revokeShare`, still resolved by the same
`authorizeShareRead`, and still re-derived through the live `privacy.md`. What
`collect` adds is one verb at one place, and nothing about who can *see*
anything changes.

**Only an `anyone` row, only over a note.** A `members` link already has readers
with sessions, and a form on one is answered under their own handle through
`submitForm` — collect mode would be a worse version of a thing that exists.
A folder link reaches a subtree, and collecting through one would publish every
form beneath it on the strength of one decision. Both are refused twice: at the
mint, so an owner is told when they ask, and at `collectTarget`, because an
already-written row is what the read path has to judge.

**It serves one note and not even that note's links.** Every read link gets the
entry note's own links at depth 1. A collect link gets none — and the reason is
specific rather than cautious: the note a form sits on is exactly the note whose
links most often include *the answers file it collects into*, so the ordinary
traversal would hand every respondent everybody else's answers, on the strength
of where an owner happened to put a cross-reference. Bounded as "the entry note,
full stop" rather than by refusing the responses path, because a rule that lists
what is forbidden is a rule with a gap in it.

**What it writes can never authorise anything.** The answer is stamped
`via @seyi/intake` — the *link*, read out of the row, never out of an argument.
That stamp holds a space, which `names.ts` forbids in a handle, so no person can
ever be called it and no link can be mistaken for a person. It is also *shared*
by every stranger who used the link, which is #748's `by: null` collision with a
different constant in the middle — so `assertMayChange` refuses any change to a
row whose `by` is a stamp. An answer sent through a link is final, the page says
so before it is sent, and only an editor (who could rewrite the whole file with
`writeNote` anyway) can remove one.

**The human check fails closed, and that is the production branch.** With no
`TURNSTILE_SECRET_KEY`, a challenge that did not pass, or a verifier that could
not be reached, the submission is refused. A route whose defence disappears when
its key goes missing is a route with no defence — and it is exactly the moment
somebody is most likely to be probing it. The corollary is that collect mode
ships dark: the code is complete and refuses, and the feature turns on when the
key is set. Only the token and the secret are sent to Cloudflare — never the
workspace, the note, the answers, the link, or the visitor's IP, which is the
one field that would make this a disclosure about a person.

**A cap on the row, spent before the write.** A published URL with no ceiling is
somebody's storage quota with extra steps. The count lives on the share row
rather than being read out of the responses file, which is two copies of one
truth and normally wrong — it is right here because the alternative is opening
the customer's bucket to decide whether to refuse, which lets an unauthenticated
caller spend a GET on their quota by posting garbage. The slot is taken
*before* the write, so two submissions racing cannot each decide there was room;
a failed write costs one slot out of hundreds, which is the direction to err in.

**And a cancelled context stops taking them.** Cancelling makes a context
read-only, and a live collect link is a write path into one that stopped taking
writes. Only *managed* storage is affected — a customer's own bucket keeps
working with their own credentials whatever we think of their card, because
revoking our access is their lever and not ours.

**What a "simplification" would cost.** Dropping the stamp rule and comparing
`by` to the actor's name lets any stranger edit any other stranger's answer
through the same link. Letting a collect link traverse like a read link
discloses the answers file. Accepting a submission when the challenge cannot run
turns a published form into an open write endpoint the first time a key is
rotated. Counting from the file instead of the row hands an unauthenticated
caller a lever on the customer's bill. Each has a test in
`apps/convex/__tests__/collectMode.test.ts`, and each was sabotaged to confirm
the test fails — including one guard that was **removed** because sabotage
proved it unreachable, which is why the *shape* of `linkStamp` is now pinned on
its own.

### The switch that hands out a write sits under the link, and says so

Collect mode arrived as a mode on a share row that only an agent could set. An
owner could therefore hold a link that takes answers from strangers and see, in
their own console, a row indistinguishable from every read link they have ever
minted. That is the console being quiet about the only case where
non-negotiable #5's exception has teeth, so `collecting` is now on every share
row the owner is shown, and there is a switch.

**Under the link, not beside the audience control.** The audience control
decides who can *reach* the note; this decides what they can *do* once they are
there, and it only exists once a link does. A fourth position on a control
about reach would make "published" and "writable" one idea, and they are not.

**A toggle, never a re-mint.** `setShareCollecting` is its own mutation because
`createLinkShare` supersedes — it can mint, and on a live row it patches — and
routing a switch through a creation path is how a press of "off" ends up
handing somebody a new token for a link they had already sent. The token is
untouched either way, so a link already pasted goes on working.

**The third door on the same two rules.** Only an `anyone` row, only over a
note. `collect.ts` enforces that on an already-written row and `mintUnlistedLink`
enforces it at the mint; a rule enforced at two of the three places a row can
be written is a rule with one way around it. The switch is simply not drawn
where the server would refuse, which is the console's standing rule about
controls that are going to fail.

**Turning it on is its own line in the audit trail.** `share.collect.opened`
rather than a detail on `share.link.created`, because "when did this start
taking answers" is a question the trail has to be able to answer on its own.

**And the copy is a guard.** Everything else in that dialog gives somebody a
read; this lets a stranger with no account append to a file in the owner's
bucket. The row says who can send, that nobody can read the answers through the
link, and that an answer cannot be taken back — in the same breath as the
switch, not in a help page.
