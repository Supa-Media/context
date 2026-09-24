# App and console — workspace creation and rail

### Making a workspace is its own flow, not onboarding with a flag

Four of the five screens rhyme with `/welcome`'s, which is exactly why it is
tempting and exactly why it is wrong. Three things differ, and each one turns a
shared implementation into a screen that lies to one of its two audiences:

1. **A workspace is not the thing you may only have one of.** Onboarding has no
   way back and is not re-runnable: step 1 claims a name out of a namespace with
   no release path, and `createWorkspace` writes exactly one personal context.
   `resolveWelcomeRoute` exists to enforce that. A person may own several
   workspaces, so there is no gate, Back means something up to the claim, and
   the copy does not borrow "there is no way back".
2. **A workspace has no capture address.** Only a personal context gets an
   ingestion alias. The onboarding name step's most consequential element is a
   live panel showing the three things the name becomes, one of which is
   `name@context.lc` — and here it would promise a mailbox that will never
   receive anything. `workspaceNameConsequences` returns two entries, and a test
   asserts the third is absent rather than trusting that nobody re-adds it.
3. **A workspace nobody else is in is pointless.** Onboarding ends on "point
   your tools at it". This ends on inviting people, which is the only step whose
   absence makes the whole flow a no-op — and it therefore survives a failed
   storage probe, where onboarding correctly drops its remaining steps. An
   invitation is a control-plane row and writes nothing to a bucket; a workspace
   whose storage is not sorted out is exactly the one whose members need to know
   it exists. What it must not do is imply the context is ready, which is a
   caveat on the screen rather than a silence.

What is genuinely shared is imported, not copied: `validateName` (through
`../onboarding/name`), the folder editor and its validator, `StorageChoice`,
`parseInvitee`, and the role vocabulary. The rule is the one `onboarding/name.ts`
already states — a drifted copy of a validation rule shows a green tick in front
of a refusal.

### Two name fields for a shared workspace, one for a personal one

A person's handle and a person's label are usually the same word, so onboarding
asks once and uses the answer for both. An organisation's are not: "Acme
Engineering" is what it is called and `acme-eng` is what fits in
`@acme-eng/1-projects/note.md`. One field gets you a handle nobody can read or a
label nobody can type.

The handle follows the label until it is touched, and then stops permanently for
that session. A suggestion that keeps overwriting is how a *permanent* name gets
claimed that nobody chose — somebody goes back to fix a typo in the label and
the handle silently changes under them. `slugSuggestion` is pure and its output
is fed through `nameStatus` like any typed string; it is never assumed valid.

### The layout presets are company-shaped, and PARA is not the default

PARA sorts one person's work by how permanent it is. That is the right question
for a workspace and the wrong one for a company, whose context is sorted by who owns
a thing and which outside party it concerns — a team handed `1-projects` /
`2-areas` / `3-resources` files nothing into them. So `/workspace/new` defaults
to a **Company** preset (inbox, projects, teams, handbook, customers, archive),
offers **Client work** for organisations whose work is sorted by client first
(a flat `1-projects` collides across three clients on day one), and keeps PARA
third for teams that already use it.

Two properties matter more than the folder names, which are a guess and are
meant to be edited:

- **A preset is a starting value for the folder editor, not a mode.** Choosing
  "Company" and renaming `4-customers` is the common case. Every preset except
  PARA travels to `applyStructure` as `custom` with its rows, so nothing
  downstream knows which button was pressed.
- **The descriptions are load-bearing.** Each becomes that folder's `README.md`
  and its line in `index.md`, verbatim, which is what a connected AI client reads
  to decide where a note belongs. A vague description produces a folder that
  fills with everything. They are written in the third person, because a
  workspace has no single reader and `index.md` addressed to "you" reads as
  somebody else's file to everyone but its author.

A test runs every preset through the control plane's own `validateCustomFolders`
and `toFolderSpecs`: a preset shipping a folder the mutation would refuse is a
button whose only outcome is an error.

### Invitations are queued, and a partial send keeps its successes

`inviteMember` is rate limited per account, so a box that fires on each press is
the shape most likely to meet the limit and least likely to say which of five
people it got to. Queueing also matches what the step is for — it is four
colleagues and a typo, and a typo is cheaper to fix before it is a live
invitation than after.

The send is sequential and per-invitation. A failure does not discard the ones
that went: those invitations exist, and re-sending one supersedes a live row. So
the queue is replaced by exactly what failed, both halves are reported, and the
flow does not advance until the box is empty or the person skips.

Two things this screen may never do, both inherited rather than invented:

- **Say whether the invitee exists.** Refusals are about the *shape* of the
  string, which is a fact about the string and could not have been about who
  holds it. Anybody with an account has an invite box; one that answered would
  enumerate the user base.
- **Imply anybody has access yet.** An invitation is an offer, and until it is
  answered the workspace has one member. The last screen says "outstanding",
  never "invited" and never a headcount — a "4 people invited" on a screen
  somebody screenshots is read as "4 people can read this".

### The rail's "New workspace" entry is a verb, and the claim entry is a gap

They sit in the same group and are two flags rather than one, because they are
true at different times and are drawn differently on purpose. "Claim your @name"
is a *gap in the list* — it is for somebody who arrived through an invitation and
has no reason to suspect the product does anything else, it is drawn accented so
it cannot be missed, and it stops existing the moment it is used. "New workspace"
is an ordinary verb that is true from the first session and stays true, so an
accent on it would be an advertisement on every screen forever. It goes last,
under the claim entry, in the group where its result will appear.

Nothing client-side gates it. How many workspaces one account may own is
`MAX_WORKSPACES_PER_USER`, enforced inside `createWorkspace`'s transaction, and a
second copy in the rail would be the copy that is wrong after a deploy — hiding
the entry from somebody under the limit, or showing a screen that refuses. The
refusal is rendered on the step where the person can act on it.

### The rail is one list, with the personal workspace pinned to the top

Two groupings preceded this one, and both were answering *whose notes am I about
to open?* with structure. The first grouped on **ownership** — "Yours" over
everything where your role was `owner`, "Shared with you" over the rest. The
second grouped on **kind**, heading the groups with the product's two nouns of
the time, **Workspaces** and **Workspaces**.

The second grouping died with the noun. The owner retired "brain" (2026-09-13,
[vocabulary-and-workspaces](../vocabulary-and-workspaces.md)): a brain is a
workspace one person owns, so both groups are workspaces and a heading over each
is a division with nothing left to divide — two words for one noun, drawn as
structure, at exactly the moment somebody is learning what the product calls
things.

So: **one group, headed Workspaces**, and everything the split was carrying
carried by cheaper devices that were already there.

- **The pin.** `isOwnWorkspace` requires a personal context you own, and that
  row leads the list — always, ahead of any order the control plane sent.
  Exactly one row can ever satisfy it, because `createWorkspace` writes one
  personal context per person and there is no transfer path, which is what makes
  a pin the right shape and a section the wrong one.
- **The mark.** That row keeps its quiet `yours` label and its selected
  treatment. It is a label rather than a badge because the row it marks is the
  one the person recognises fastest anyway: it only has to settle the question,
  not raise it.
- **The handle.** `@sayo` already says whose the other personal contexts are.
  That was true under both groupings and is the reason neither ever needed a
  heading to say it.

Ownership of a *shared* workspace stays unmarked. It is shared by construction;
what differs is your role in it, which is three states on the members card
rather than one bit in a switcher.

**The pin is a pin, not a sort.** Everything after the pinned row keeps the
order the control plane sent. Re-ordering somebody's list on their behalf is a
decision the rail is not making, and a stable list is what makes muscle memory
work.

**The claim entry takes the pinned slot, and the create entry the foot.** They
stay two flags rather than one because they are true at different times and are
drawn differently. "Claim your @name" is the *gap where the pinned row would
be* — it is exactly the placeholder for it — drawn accented because the person
it is for arrived through somebody else's invitation and has no reason to
suspect the product does anything else, and gone forever the moment it is used.
`railGroup` refuses to offer it beside the row it stands in for, so the two can
never be drawn together even if the gate that offers it changes. "New workspace"
goes last, drawn quietly because it is a permanent verb and an accent on it
would be an advertisement on every screen of every session; it is also the only
offer for somebody in no shared workspace yet, which is how a person who has
only ever had their own finds out shared ones exist.

**The group is unconditional**, where each of the two used to survive an empty
list only while it still had something to offer. With one group there is nothing
its absence could say, and it is where "Nothing here yet" lands for an account
with nothing at all.

*What a "simplification" costs:* sorting the list without the pin, or folding
the claim entry into the ordinary run, puts somebody's own workspace wherever
its slug falls in the alphabet and puts the one accented offer in the middle of
a scroll. *The tests that fail if it is reversed:* `railGroup.test.ts` —
`pins your own personal workspace to the top, whatever order it arrived in`,
`never coexists with the workspace it stands in for`, and `says nothing about
workspaces` — and, on the rendered glass, `consoleIdentityChrome.test.ts` —
`the viewer's own workspace is drawn first, whatever order it arrived in` and
`an invited-only account sees the claim entry in the pinned top slot`.

**The one thing this regrouping made easy to get wrong, and the rename that
stops it.** `ContextRowMenu` took a `shared` prop, filled in from whether the
row sat under "Shared with you", and used it to decide whether to offer
**Leave**. Under the old grouping that was the right answer by coincidence:
that section was exactly `role !== "owner"`. Under kind-based grouping every
workspace is "shared" and some of them are yours, so a section-derived answer
offers Leave on a workspace you own and the press comes back
`OWNER_CANNOT_LEAVE`. The prop is now `canLeave` and takes the role — the fact
the server actually enforces — and `__tests__/contextMenu.test.ts` mounts a
workspace the viewer owns and asserts the item is absent. Re-deriving it from
the section fails that test.

