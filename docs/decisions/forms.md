# Markdown forms

A note may carry a fenced ` ```form ` block. It declares fields and one policy;
answers are written to a **separate note** the block names. The point of the
feature is the one thing the rest of the product could not do: collect
structured input from people who cannot write notes — a shared workspace every
customer is a read-only member of, where they can still file a bug or ask for a
feature and upvote each other's.

Decided with the owner, 2026-09-12, in a conversation that changed the design
three times. The rejected shapes are recorded here because each was the obvious
answer and each was wrong for a reason that will come back.

## Responses live in a sister file, not on the form's own page

The first design put the responses on the same page as the form and had the
gateway withhold them from anybody below editor. It is an appealing idea — the
gateway is the only thing that touches the bucket, so it could simply decline
to hand over part of a file — and it breaks the moment you look at the second
reader.

**`canSee` answers for a whole key.** Every read path in the gateway is built on
that: `read_note`, `list_notes`, `orient`, `list_changes`, the D1 projection and
the snippets search serves back. "Some of this file is hidden" would have to be
taught to all of them, and the one that leaks first is search — it indexes note
bodies, so a member searching for a phrase from a hidden response would be
handed it in a snippet without ever opening the file.

A sister file needs none of that. It is an ordinary note with an ordinary
`privacy.md` rule, so **who may read responses is answered by the privacy engine
that is already proven**, and `responses: visible | hidden` stops being a
feature: it is whatever visibility the owner gave that one file.

The cost, stated: two files per form, and a reader following a link. That is
cheaper than a second access-control path, and enormously cheaper than a display
flag that looks like a privacy control and is not one — the failure this repo
already names as "the control lying in the one direction that matters".

## The block declares the path, never the visibility

`responses:` names a file. It does not say who can read it. Two reasons, and the
second is the one that matters:

- `privacy.md` is already the single place that answers that question, and a
  second place to answer it is a second answer that can disagree.
- A form block sits in a note **any editor can rewrite**. Declaring visibility
  there would let somebody publish a response file by editing a code fence —
  no confirmation step, no `set_visibility` audit line, no `confirm_team_publish`.

## Layout is declared, not derived

An earlier draft inferred the layout from the field types: all single-line
fields meant a table, any paragraph field meant one section per response. The
owner rejected it as hacky, and was right — it made a table silently become
something else when somebody added a field.

So `layout: table | sections` is a required key. A paragraph field in a table is
allowed and will look cramped; that is the author's call.

What is *not* allowed is losing the answer. A raw newline in a Markdown table
cell does not merely look wrong — it ends the row, and the rest of the paragraph
falls out of the table as loose text. So cells are escaped: newlines become
`<br>`, pipes and backslashes are backslash-escaped, and `<`, `>`, `&` are
entity-escaped so a submitted literal `<br>` comes back as itself.

## The gateway renders every row, and therefore parses every row

No tool takes Markdown. `submit_form` takes `[{ field, value }]`, and the
gateway checks it against the declared fields and renders the row itself. That
is what makes the feature safe to offer to people who cannot write notes: there
is no argument anywhere in these four tools that reaches the file as text.

The consequence is that editing one answer or withdrawing one vote means reading
the file back, so **the round-trip is load-bearing**:
`renderResponsesFile(parseResponsesFile(x)) === x` for anything the gateway
wrote, under arbitrary submitted text. `forms.test.mjs` submits values that
mimic a table row, a heading, a `**Votes:**` line and a trailing backslash, and
asserts that none of them forges a response or a vote. This is the same failure
shape as the `privacy.md` newline injection already closed here: a renderer
interpolating attacker text into a line-oriented format.

The single left-to-right un-escape scan is part of that and looks like something
to simplify. A sequential chain of `.replace()` calls is correct for most
orderings and wrong for one — `&lt;` before `<br>` turns a person's literal
"<br>" into a line break. The fixture contains that string for exactly this
reason.

## A `member` may submit, and that is the only write they get

`effectiveScopes` drops `context:write` for every role below editor, which is
right for notes and is exactly what made a view-only workspace useless for
collecting anything. The relaxation is deliberately narrow, and it is two gates:

- **`participatesInForms`** requires the *grant* to have asked for write. A
  client its person deliberately connected read-only stays read-only —
  submitting a form changes a file in their bucket, and "read-only" has to mean
  that. `context:capture` is not enough either; capture reaches `0-inbox`.
- **The form's own `submit:` policy** decides which role, read from the note at
  call time and compared against the caller's role in the context the call was
  routed to.

The exemption applies to the *call*, never to the listing. `toolsForSession`
needs no branch for it: a connection that can take part in a form is by
construction one whose person owns their own workspace — that is where the username
a response is recorded under comes from — so `writesAnywhere` is already true of
it. A listing branch would only ever have fired for a connection whose
submissions are then refused for want of a name.

**Identity is stamped, never claimed.** `by` comes from the session, and every
ownership test compares against it. The schema's `additionalProperties: false`
separately refuses a `by` argument before any handler runs, so proving the stamp
takes two people submitting to one form rather than one person trying to lie.

## You can only delete what you can see

The owner's rule, and it collapses a lot of design. There is no receipt id to
lose and no identity search: acting on a response requires being able to read
the file it is in, and then being its author (or an editor, who could rewrite
the whole file with `write_note` anyway — a lock on a door standing open).

The honest cost: **a form whose responses are private is final.** A survey
respondent cannot retract, because they cannot see their own row. Only an editor
can. That is the right trade against the alternative, which is a lookup that
tells somebody something about a file they may not read.

Votes are named for the same reason they are retractable. A bare count cannot be
made idempotent without remembering who voted, and a hidden vote ledger is not
rebuildable from the files — so it would fail non-negotiable #3's "derivatives
are disposable" rather than being a cache. Voters are in the file, visibly.

## Changing layout under existing responses is a breaking change

Rows already written are the wrong shape for the other layout. The gateway
**refuses** rather than migrating: the marker at the top of a response file
names the form and the layout, and a mismatch says to point the form at a fresh
file. Nothing already written is ever rewritten, and the old file stays readable
exactly as it was.

Adding a field is safe — older responses get an empty cell. Renaming or removing
one leaves the old data in the file under its old column, which is the same
rule: the gateway never rewrites a row it did not just write.

## The response file is created by the author, never by the first submission

`write_note` on a note carrying valid form blocks creates each empty response
file. Done on the *author's* write because they hold write access and the
submitter may not: a member whose first bug report had to create a note would be
refused, and a member whose first bug report *could* create one would be a way
for a member to create notes.

It only ever creates. A path that already holds something is left exactly as it
is, including somebody's ordinary note — which is reported back to the author so
they can see their `responses:` is aimed at the wrong place. That is the second
of two independent guards; the first is the marker check, which stops a
submission writing into a file this gateway did not write.

## A form that does not parse is inert, never half-working

Same discipline as the privacy manifest, and for the same reason: a guess about
a format is a guess about authority. `parseFormBlocks` returns the error, the
surrounding note stays ordinary readable Markdown, and submissions are refused.

`write_note` additionally refuses to *save* a note whose form block does not
parse, naming the line. That is a courtesy and is proved to be one: the bucket
is synced to Obsidian, so a form can always be hand-edited into an invalid state
without passing through the gateway. The read-time parse is what actually
protects anything; the write-time one just tells an author while they still have
the text in front of them.

**And the response file is held to the same rule, because a response is written
by rewriting it.** `renderResponsesFile` emits the marker and the rows, so a
heading the author put above their table, or a "## Notes from triage" section
below it, is not in what comes back out. Both parsers used to drop such a line
and answer with no error, which turned the next submission into a rewrite that
deleted it — and the person that write belongs to is a **`member`**, the lowest
role here, who on a private response file cannot see what went and cannot read
it back afterwards. So a body line that is neither a row nor blank (`table`), or
any text before the first response (`sections`), refuses with a message naming
the two ways out: move the notes to the form's own note, or point the form at a
file holding only the responses. Inert rather than half-working, applied to the
file the block names rather than only to the block. The checks are `prose the
author keeps around the table refuses rather than being silently dropped` and
`the same is true of a sections file with a note before the first response`,
each paired with a positive one so the refusal cannot widen onto a file this
package itself wrote.

## Forms need conditional writes, and say so when they cannot have them

Every response is a read-modify-write of one shared file, which makes a form the
most contended write this gateway has — a bug tracker shared with everybody is
many people appending to one note. With `If-Match` a losing write is retried
over the winner and nothing is lost. Without it, two submissions seconds apart
silently become one.

R2 and S3 support it; B2 and Wasabi do not reliably, and the adapter already
probes for it at connect time. On a store where the probe failed, **the
submission is refused with the reason** rather than taken and lost. That is the
existing "degrade honestly" rule applied to the one feature where silence would
destroy a customer's data rather than merely disappoint them.

## The console submits through Convex, not through the gateway

The four tools above are the gateway's. **The console cannot reach them**, and
that is not an oversight to route around: it writes through Convex, and the web
console holds no MCP grant — the auto-approved grant in
[identity-and-access](./identity-and-access.md) is the desktop shell's alone,
gated on a `127.0.0.1` redirect, and that decision explicitly refuses to make
itself general. So somebody filling in a form on a page they are reading had no
path at all, and the feature was unreachable from the surface most people use.

`functions/forms.ts` is that path: four actions with `minimum: "member"`, one
operation through `runFileOperation`, which stays the only function that opens a
bucket. **The format is not reimplemented** — `lib/formOps.ts` imports
`apps/mcp/src/forms.js` and so does the editor, so a form written by an AI client
and one filled in from the console produce byte-identical rows. What is
duplicated is the *authorization*, because the inputs genuinely differ: the
gateway asks a grant's scopes, and Convex asks a signed-in identity's role. That
is the same arrangement `lib/privacy.ts` already has with the privacy engine, and
it is held to the same condition — the answers agree where a person would notice,
and `__tests__/forms.test.ts` asserts it rather than a comment claiming it.

`files.writeNote` seeds the response files too, for the reason above: two write
paths, one rule, or a form authored in the console collects nothing.

## The form is drawn when the note is read, and is source while it is written

Everywhere else in the editor, markup comes back the instant the caret touches
it — "you cannot edit syntax you cannot see". A form cannot follow that rule,
because *filling in a field is putting a caret somewhere*: a form that revealed
on selection would turn back into a code fence the moment anybody tried to use
it.

So `state.readOnly` is the whole of the switch, and the two rules stop competing
rather than one being excepted from the other. That is the eye in the note's
header — added to the pointer layout too, where it was missing and where it was
asked for — and it is also **every note a `member` opens**, since the editor is
already read-only for a role that cannot write. The people the feature exists
for see a working form without touching a control.

The widget is compared on the fence's **text**, never on the parsed config: the
decoration set is rebuilt on every transaction, and a widget that reported itself
new would be torn down with a half-written bug report still in it.

That left one gap, and a form page is the only note it was ever true of: a page
built to be *used* opened as the source of the thing that draws it, and every
visitor had to find the eye first. So a note may ask to be opened for reading —
`view: read` in its frontmatter, read by `files/viewMode.ts`. It is a default
rather than a mode: the pencil still outranks it, which is what keeps a fence
that will not parse fixable. The reasoning, including why it is frontmatter and
not a key in the block, is
[app-and-console](./app-and-console.md#a-note-may-declare-the-mode-it-opens-in-and-the-person-still-outranks-it).

## Autocomplete is the authoring help, and the grammar is the list

The owner ruled out a builder — "it should all be text editable" — and asked for
the editor to offer the accepted keys and values inside the fence. That is
`formComplete.ts`, and it is allowed to hold a table of choices **only** because
that table is checked against the grammar rather than trusted: every key, value,
type and template it offers is parsed back through `parseFormBlocks` in its own
test. An autocompletion that suggests something the gateway refuses is worse than
none, because the person now believes they were told the answer.

It offers without being summoned, which is the opposite of the `[[` completion
beside it and deliberate: nobody knows this vocabulary yet, so the list has to
appear. A fence that has just been opened offers a whole starter block, because
somebody who has never seen one cannot complete their way in one key at a time.

## What is deliberately not built

- **A form builder screen.** Explicitly rejected: the file is what people edit.
- Response export, closing a form to new responses, and per-field conditional
  logic. None are foreclosed. **Notifications on submission** were on this list
  until 2026-09-21 and now have a section of their own below.

## Response display is explicit, and privacy still decides

`show_responses: true` asks the console to draw responses under the submit
button. It defaults to false, so forms such as private bug-report intake do not
show a response table even to somebody who can separately open the triage note.
The flag is presentation, not access control: the console still reads the
sister file through the ordinary note-read path, and draws nothing when
`privacy.md` refuses the viewer. A successful submission, edit, deletion, or
vote reloads that file. An unreadable response file never appears as empty,
because that would turn a refusal into a claim about its contents.

The widget parses the response file with `parseResponsesFile`; it does not parse
the Markdown table a second way. The native editor asks its host over the
versioned WebView protocol, and the host runs the same Convex `readNote` and
form actions as the web console. A WebView may name a response path only for a
read, and the server still applies the caller's note visibility before
returning a byte. Edit and Delete controls use `updateSubmission` and
`retractSubmission`; the server remains the authority on ownership and editor
rights.

## The response table scrolls sideways, and never truncates an answer

Decided with the owner, 2026-09-18, from a screenshot of the feature-request
form and two of Notion's tables. The table was `width: 100%` inside a card the
width of the reading measure, with seven columns, and the browser's only move
was to shrink every one of them until the whole thing fit: a handle broken
across two lines mid-word, an ISO timestamp taking four, one response 190px
tall. Every column was equally unreadable in service of showing all of them at
once.

So the table takes the width its columns need (`max-content`, `min-width: 100%`)
and the box around it scrolls — which is what Notion does, and is what was asked
for. The consequences worth writing down:

- **Nothing is pinned.** The owner's second screenshot has Notion's first
  column scrolled away entirely, which is the whole mechanism: one axis, no
  sticky column, no shadow to maintain.
- **A column *about* a response never wraps; a column *of* one always does.**
  `@seyi`, a timestamp and a row of buttons are single tokens and wrapping one
  buys nothing at the cost of every row's height. An answer wraps inside a
  column capped at `min(24em, 72vw)`.
- **The cap is viewport-aware so the scroll is discoverable.** At `24em` flat
  the answer column fills a phone exactly, the next column begins at the card's
  edge, and a table with four more columns looks identical to one with none —
  the scrollbar that would say otherwise is a transient overlay on a touch
  device. Under the viewport, the next column always peeks.
- **An answer is never truncated**, which is where this departs from Notion
  deliberately. Notion clips a cell and gives you the row to open; this table
  has no row to open, and a feature request cut at 40 characters in the list of
  feature requests is the list not working. Reversing this to an ellipsis would
  need somewhere for the rest of the answer to go first.
- **Server text is capped too.** A declined vote replaces the voters with the
  gateway's message and a declined delete replaces a button's label, both inside
  columns that do not wrap. Measured in Chromium at 390pt against a 340px card:
  capped, a refusal takes the table to 1214px whether the message is 38
  characters or 150; uncapped, 1340px and 2751px — that is, however long the
  sentence happens to be.

The tests are in `apps/mobile/__tests__/formBlock.test.ts` under "the response
table is read across, not crushed". jsdom does not lay out, so they hold the
DOM classes and the declarations that produce the layout; the layout itself was
read off renders in Chromium at 390pt and 760pt.

## The gateway writes the block too, not only the row

Decided 2026-09-20, building out "ask your agent to make you a form".

Four tools answered a form and none of them made one. An agent asked for a
client intake form had to know the block's keys by heart, that `max` is
mandatory on a `line`, that `layout` is declared rather than inferred, and that
the answers live in a sister note — and then hand-write all of it through
`write_note`. That is a feature nobody discovers, which is the same as a
feature nobody has. `create_form` takes fields and a policy and writes the
block itself.

**It takes no Markdown, for the reason the four submission tools take none.**
"The gateway renders every row, and therefore parses every row" is what makes
this feature safe to offer to people who cannot write notes; a tool that took
the block as text would be `write_note` wearing a policy argument. So
`renderFormBlock` is the inverse of `parseFormBody`, and what it renders is
parsed back before anything is written — one parser, one answer about what a
form means.

**The renderer refuses rather than escapes.** A form block is line-oriented and
its field entries are comma-delimited, so some strings cannot be written into
one at all: a newline anywhere, or a comma or square bracket inside a select
option, which `parseInlineMap` splits on before it considers quoting. A
renderer that dropped or re-encoded those would be writing a form the author
did not ask for, and the author is about to hand it to strangers.

**An option that opens with a quote is the fixture that decides the quoting.**
The scanner unquotes a list entry only when it starts with `"`, so every other
awkward character survives bare — which means a "simplification" emitting
everything bare passes every other test and turns that one option into "the
list has an unclosed quote". It is in `forms.test.mjs` for that reason, the way
a literal `<br>` is there for the unescape scan.

**There is no runtime re-render check, and that is a finding rather than an
omission.** One was written — render, parse, re-render, compare — and
sabotaging it failed nothing: the renderer refuses everything a block cannot
carry and the parser refuses everything else, so no input reaches it. A guard
nobody has checked is not a guard, so the property moved to where it can be
proved, as a round-trip assertion over hostile fixtures.

**`create_form` never overwrites.** It is `write_note` with a block it rendered
itself, so visibility, the team-publish confirmation, the encryption rule, the
etag and the creation of the empty response file are all that function's and
are not restated. The single thing it does differently is refuse a path that
already holds a note: a tool called "create" that replaced somebody's note
would take the answers already filed against it with them. The refusal sits
after the team-scope permission checks, all of which answer identically whether
or not anything is there, so it is not a second existence oracle.

**What it reports back is where the answers land and who can read them**, read
from the manifest rather than assumed. An agent that inferred "private,
because the form is private" would be telling somebody their client intake is
confidential while the folder default says otherwise.

Still not built, and deliberately: nothing here lets a person without an
account answer a form. A collect link, an owner-chosen short link, and the
tools that mint one are the subject of the UX pass this section was written
beside, and each of them changes a rule in `privacy-and-sharing.md` rather than
adding to this one.

## A form on a share page draws itself, and is the page's one write

`privacy-and-sharing.md` argues collect mode — what a collect link is, what it
narrows, and why it is the only write in this product with no account behind
it. This is the other end: the page somebody with no account actually opens.

**The fence becomes a form only when the server says the link collects.**
`readSharedNote` reports `collecting` off the share row, and the page reads
nothing else. Inferring it from the note's own text — "there is a form block
here, so draw a form" — would publish a write endpoint on every shared note
that happens to carry one, which is not a decision its owner made. A read link
over the same note draws the block as source, which is what it is.

**`shareReadOnly.test.ts` was restated rather than relaxed.** It said "nothing
on a share page may write", which was true and is now too narrow. What it
checks instead is: one write action, `submitThroughLink`, in one file, and the
general-purpose writes (`useMutation`, `writeNote`, `runFileOperation`,
`createShare`) still forbidden outright. The distinction is real rather than
verbal — `submitThroughLink` takes no path, no text and no destination: the
link names the note, the note's own block names the answers file, and the
server renders the row from values checked against that block's declared
fields. There is a self-test for a *second* write being added, because
"submitting is allowed here" must not read as "form actions are fine here".

**The check is read before the fields are drawn.** With no
`EXPO_PUBLIC_TURNSTILE_SITE_KEY` there is no way to produce a token and the
control plane refuses every submission — so the page says it is not taking
answers *instead of* rendering fields. Drawing them anyway would take two
minutes of somebody's typing and refuse it at the end, which is the failure
`lib/turnstile.ts` describes from the server's side. The native build reports
the check permanently unavailable and says to open the link in a browser: there
is no Turnstile widget outside one, and a server that waved a submission
through because it came from an app would have no defence at all.

**Validation is the server's function, run early.** `validateSubmission` is
imported from `apps/mcp/src/forms.js` — the same file the gateway, the control
plane and the console editor reach for — and what goes on the wire is *its*
normalization, never the raw boxes. A page that sent what was typed and used
the validator only for a yes/no would make "valid here" and "valid there" two
questions, and the second one is answered in front of somebody with no account
and no way to ask why.

**One decision, one function.** `fenceAsForm` is what both `ShareScreen` and
its test call. It was a closure in the screen with a copy in the test for about
an hour, and sabotaging the copy failed the test while the screen would have
gone on drawing forms on read links — #755's shape exactly, in the feature that
shipped it.

**An answer is final, and the page says so above the button.** No edit, no
withdraw, no vote, no receipt, and the response id is deliberately not returned:
a stranger cannot read the responses file, so there is nothing they could do
with one, and handing somebody a handle to a thing they can never act on is an
invitation to try.

### Two bugs this page found in code it only passed through

**A checkbox answer was unanswerable.** `validateSubmission` sent it through
`parseBool`, which reads the *block grammar*'s vocabulary (`required: true`),
while the responses file stores `yes`/`no` and the console's own widget submits
`yes`/`no`. Every form carrying a checkbox was refused with a sentence naming
two words nothing in the product shows. Nothing anywhere tested a checkbox
field, which is how it survived. The answer's vocabulary is now its own
function accepting both pairs and storing one; the declaration's is untouched,
because widening it would change a stable storage format rather than fix a bug.

**Reading one back cleared it.** The editor's form widget filled a checkbox
from `value === "true"` — the same confusion at the other end — so editing an
answer arrived with every ticked box unticked.

## A form tells a person, and the block names one rather than a destination

Decided with the owner, 2026-09-21, from "anytime there is a submission, I
would love to be able to email someone". The obvious design is
`notify: dev@example.com` in the block, and it is the one thing here that must
not be built.

**An address in the block is an egress destination, and a form block sits on a
note any editor can rewrite.** That is already the stated reason `responses:`
names a path and never a visibility — an edit to a code fence must not be able
to do what `set_visibility` does with a confirmation step and an audit line. An
address is worse than a visibility flag rather than comparable to one: it is
not a permission at all. One line changed in Obsidian redirects every future
client brief to somebody else's inbox, and the form's owner sees nothing, ever.

**And once a form is published it stops being about one workspace.** A collect
link takes answers from strangers with no account, so an address here would
make every published form a mail relay whose destination one editor chooses and
whose *content* any stranger supplies, sent from our own domain. That is the
threat `functions/invitationEmail.ts` is fenced against on four sides, and the
fence that matters most there is the one this would remove: the sender never
gets to name a stranger's mailbox.

So the grammar takes `owner` or a handle, and `apps/mcp/src/forms.js` refuses
everything else **in the renderer as well as the parser** — `create_form` and
the console editor both write blocks through `renderFormBlock`, so a value it
would emit is a value the next read has to accept. The control plane then
resolves the name to an identity, requires a **live membership** in the
workspace the answer landed in, and reads the address off the account. The
shape of that is `ingestionSettings`' shape, for the same reason: an allowlist
that starts closed, seeded from accounts, with no wildcard and no suffix rule.

**What this buys, stated as the property to keep:** Context can mail a member of
that workspace and nobody else. Naming is not granting — a handle that resolves
to a real person who is not a member here gets nothing. Removing somebody's
membership stops their mail without anybody editing a note. And there is no
value an editor can write into a code fence that makes a message go somewhere
new.

## The answers are in the mail, so the mail is fetched as its recipient

Also the owner's call, and the more expensive half: a bug report you have to
click through to is a bug report you read tomorrow. The cost is that content
leaves the bucket, and the bound on it is that it only ever leaves **to somebody
it had already been shown to**.

The shape that looks obvious and is wrong is: check `canSee`, then render the
answers the submission carried along. Those are two facts about one file that
can disagree, and this is the one place where being wrong means the content has
already been sent. So `readResponseForNotification` does both at once — the
read that produces the answers *is* the read `canSee` authorised, against the
live manifest, for that person, at delivery rather than at authoring time. A
recipient the manifest holds back is not mailed at all, not mailed a contentless
notice: "an answer arrived on a form whose answers you cannot see" is itself a
statement about a file being held back.

**Nothing about an answer travels in a scheduled job's arguments.** Convex
persists those until the job runs, so answers there would be note content stored
in the control plane — non-negotiable #1, which is absolute rather than
proportionate. A short window is still the wrong side of it. The job carries
identifiers, and so does the gateway's `/gateway/forms/notify`, which is why
that route cannot be turned into a send-to-an-address-of-your-choosing primitive
even with the gateway secret in hand.

## Only a submission, and a burst is counted rather than dropped

**`kind === "submit"`, not truthiness.** An edit, a retraction and a vote are
all changes to an answer that has already been announced, and a vote is a button
every member of a context has — mailing one hands any member a way to fill
another's inbox by clicking.

**Twenty per recipient per hour, then a digest.** A published form's collect cap
is in the hundreds and nobody wants hundreds of messages, so a limit is not
optional. What a bare limit costs is the difference between "nothing arrived"
and "a burst arrived while you were over your limit", which is invisible to the
person the form belongs to — so the overflow increments `formNotifyDigests` and
one message per window names the count. The digest holds a counter and three
identifiers and never an answer: it is sent precisely when a lot of them landed,
and a message carrying twenty strangers' briefs is a different object from one
carrying one.

The slot is claimed **before** the bucket is opened, which is `spendCollectSlot`'s
reasoning applied here: otherwise a stranger with a published link spends a
bucket read per submission on work that is thrown away. The cost of that order
is that a slot spent on a notification the manifest then refuses is one fewer
message in the window, which errs towards sending less.

There is deliberately **no second limiter keyed on the address**, which is the
fence `invitationEmail.ts` needs and this does not: there, any account could
name any stranger's mailbox; here the recipient is always a member of the
sending workspace, so flooding somebody first requires them to have granted you
membership, and the lever they already hold is removing it.

## It is scheduled, and that is a security boundary rather than a tidiness one

`runFileOperation` schedules `deliver` and discards it. A synchronous send would
make the time a submission takes depend on whether the form notifies anybody and
on whether the address accepted the mail — an oracle readable with a stopwatch,
by a stranger, on a URL its owner published. It is the same reasoning
`sendInvitationEmail` gives, with a worse attacker.

The same property is what makes failure safe: the answer is in the customer's
bucket before any of this runs, mail is a derivative of it, and a derivative
never rolls back the canonical write. A deployment with no `RESEND_API_KEY`
sends nothing and refuses nothing.

## What a "simplification" would cost

Each has a test in `apps/convex/__tests__/formNotify.test.ts`, and each was
sabotaged to confirm the test fails — including the one that came back **1**
and was therefore the finding rather than the result. The anti-relay rule had a
single assertion behind it, on the resolver, and the resolver is the *inner* of
two guards; nothing covered the outer one, which is that a block holding an
address does not parse at all. There is now a fixture that writes one straight
into the bucket, past every tool, the way an owner with Obsidian open can.

- Letting `notify:` hold an address makes every published form a mail relay
  whose destination an editor picks and whose content a stranger writes.
- Trusting the `to` argument instead of reading `notify` back out of the block
  lets whoever can reach `/gateway/forms/notify` — a leaked gateway secret —
  redirect a real answer to a different member. A smaller hole than the relay
  and the same shape: a destination supplied by a caller rather than derived
  from the thing being sent. The block is the authority on who it tells, as the
  session is the authority on `by`.
- Dropping the membership check lets a form mail anybody with an account.
- Checking `canSee` separately from the read discloses answers to somebody the
  manifest refuses, on whichever of the two goes stale first.
- Testing truthiness instead of `kind === "submit"` mails every vote.
- Carrying the answers in the scheduled job puts note content in our database.
- Awaiting the send inside the submission hands a stranger a timing oracle and
  lets a mail provider's bad afternoon turn a stored answer into an error.

One guard was **removed** during that pass rather than kept, which is the same
outcome `create_form`'s runtime re-render check had. It refused a `responses:`
pointing at `privacy.md` — `canSee` says an owner may read their own access
map, and this is the one read whose result is emailed, so it looked like a way
to mail somebody their manifest. Sabotaging it failed nothing from either end:
nothing can write a response into that file and nothing can read one back out
of it, both because of the marker check that stops a submission writing into a
file this package did not write. A guard that cannot be reached is not a guard,
so the reasoning is a comment in `readResponseForNotification` and the line is
gone.

## `create_form` is unlisted, and `write_note` is the way to make a form

Decided by the owner, 2026-09-21: "most clients don't have it and really
there's no reason to have a separate way to do this when `write_note` is all
you need."

`create_form` shipped to close a real gap. An agent asked for "an intake form"
had to know the block's keys, its field types, that `max` is mandatory on a
`line`, that `layout` is declared rather than inferred, and that the answers
live in a second note — a feature nobody discovers, which is the same as a
feature nobody has.

**That gap was closed a better way, and the tool outlived it.** PR #782 found
why: a client caches `tools/list` and re-fetches on its own schedule, so a tool
added after it connected is not callable by name however correct the server is.
A connected assistant reported it in as many words — "Missing: `create_link`
and `create_form`" — about two tools that had shipped and were working. The fix
was to put the block's grammar into `write_note`'s description, which every
client already holds and has held from the beginning. It now says, in as many
words, that it makes forms and that no separate tool is needed.

What was left was a second name for one operation: `create_form` renders a
block through `renderFormBlock`, parses it back through `parseFormBlocks`, and
hands it to the same write path `write_note` uses, with `mustCreate` as the one
difference. Every rule about the block — a new field type, a new key, a refusal
— had to be taught in two places, and the copy most clients cannot call is the
copy that quietly rots.

**Unlisted, not deleted.** `UNLISTED_TOOLS` in `apps/mcp/src/index.js` takes it
out of `tools/list` while its definition and its dispatch case stay, so a client
that *did* fetch it goes on working and its arguments go on being validated
against the schema this server advertises now. The same arrangement
`archive_chat` has had since it became `save_context`, and for the same reason:
a tool that vanishes mid-session is an error in somebody's chat, not a tidier
server. Deleting the code is a later, separate change, once nothing calls it.

`orient`'s guidance and the "that note already exists" refusal both point at
`write_note` now. They used to name `create_form` to clients that did not have
it, which is worse than saying nothing.

### What a "simplification" would cost

- **Deleting it instead of unlisting it** breaks every client still holding the
  cached name, today, with no warning and no fallback in the error.
- **Listing it again** reintroduces two places to teach one grammar, and the
  one most clients cannot reach is the one that goes stale.
- **Dropping the census exemption** (`toolArguments.test.mjs`) lets a dispatch
  case exist with no advertised schema, so its arguments stop being validated —
  which is the hole that test was written for.
- **Dropping the check that an unlisted tool is really absent from
  `tools/list`** makes the exemption hide the thing it exempts: a name in
  `UNLISTED_TOOLS` that `toolsForSession` forgot to filter would pass either
  way. Sabotage: removing the filter reddens exactly that check.

## Asking for a link publishes the form, and a refused mint says why

Found in production on 2026-09-24. An owner asked their assistant for a client
intake form and a link to send. `write_note(share: "collect")` wrote the form
and its answers note, then failed with "control plane unavailable: status 500"
on every retry, whatever short name was asked for. Every owner who asked for a
form this way hit it; nobody had yet.

Two faults, both fixed together:

- **A personal connection's new note is private, and a link only opens what
  the workspace can read** (non-negotiable #5). So the mint refused every note
  `write_note` had just written for an owner. Asking for a link anyone can open
  is approval for something wider than publishing the note to the owner's own
  workspace, so `share` now does that too and stands in for
  `confirm_team_publish`. It never overrides `visibility: "private"` passed in
  the same call: that contradiction is refused before anything is written. The
  answers note is untouched, because who reads the answers is a separate
  question the owner did not ask.
- **A mint refusal escaped the HTTP route as a 500.** The mint throws
  `ConvexError`s the console turns into sentences. `gatewayCreateLinkHandler`
  now catches those after the owner clearance and answers `{ refused }`, which
  the gateway prints. A caller who is not cleared still gets the bare `null`, so
  nobody else can tell "not yours" from "not a note". Anything that is not a
  `ConvexError` still throws, because an outage reported as "publish your note
  first" would send an owner to fix a manifest that was fine.

The gateway's control-plane stub minted over any path, which is why the suite
stayed green; it now takes a `linkRefusal` hook answered from the live manifest.
Dropping the implied publish reddens 10 `linkTools` checks; the real route is
covered by `__tests__/controlPlane/linksCreate.test.ts`, and letting `refused`
reach an uncleared caller would make link creation an existence oracle.
