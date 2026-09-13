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
construction one whose person owns their own brain — that is where the username
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
- **Notifications on submission**, response export, closing a form to new
  responses, and per-field conditional logic. None are foreclosed.

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
