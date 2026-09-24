# App and console — quick create and the activity feed

## Nothing is named before it is written, and the phone's `+` is the only key

Two things the owner asked for on 2026-09-19, in one sentence, and they are one
decision: *"when clicking the plus, there is new note, new chat (should be off
btw if no LLM api key configured), there should also be new folder, and new
drawing, and then also for new note, new drawing etc should not ask you to title
it, it should be called untitled-date, but the user should be able to title the
note while writing in it, this should be the same for mobile, we no longer need
a dedicated mic button on the bottom row, just a plus button that opens
different options"*.

The first half of that list is *The corner makes five things* above, and the
chat gate with it. What follows is the rest.

### A new note is never a dialog

Every route into a new note used to raise `NamePrompt`: the explorer's `+`, a
row's "New note here", ⌘N, the `?quickAction=note` widget link, and the phone's
bottom row. **The field asked for the one thing nobody has yet.** A note is named
after it says something, so the file is created immediately as
`untitled-<date>.md` and the name catches up: `files/untitled.ts` reads the
document's first heading, and `useFileBrowser` renames the file to match the
first time that heading settles into something other than the placeholder.

What a "simplification" of this would cost, in the order the mistakes are likely:

- **Put the prompt back for "safety".** It is not safety. It is a modal in front
  of the product's primary verb, and it is what made the widget link — one press
  from anywhere — end in a text field.
- **Rename on every heading edit rather than once.** The path is what every note
  link, share row and offline copy is keyed by. A file that moves whenever its
  title is edited is a file whose links rot while somebody writes. The adoption
  happens **once**, and after that the heading and the filename are two things
  the person owns separately, like every other note in the bucket.
- **Rename on the keystroke, or on `dirty`.** `performSave` captures the path
  when it is called, so a `moveEntry` that lands mid-write leaves a conditional
  write aimed at a name the bucket no longer has. It waits for `clean` or
  `saved` — the two states where nothing is in flight. (`saved` is `clean`
  wearing a chip that decays, so gating on `clean` alone makes the rename wait
  on a *UI* timer; written that way first, it never fired at all.) A note created
  offline is `queued` and is not titled until its drain lands, which is the
  honest order: the bucket does not have it yet.
- **Match the *word* `untitled` rather than the date.** A note somebody genuinely
  called "untitled thoughts" is their name for it. The date tells the two apart —
  and on top of that only a path this session created without a name is eligible,
  so opening an old file can never move it.
- **Sanitize a heading into a filename.** A slash quietly turned into a folder is
  worse than an untitled note: they can see `untitled-2026-09-19` and fix it, and
  they cannot see that their note moved. `nameFromTitle` refuses and leaves the
  name alone.
- **Use UTC for the date.** A note made at 9pm in New York would be dated
  tomorrow, on their own screen, in their own bucket.
- **Name it without loading the destination.** Listings are fetched per folder,
  so an unopened destination reads as *empty* and every note made into it gets
  the same unsuffixed name. The quick-note widget files into `0-inbox` on a
  console that has loaded the root and nothing else, so the second capture of a
  day was a refusal from the server. `createUntitled` loads the folder first, and
  `refresh` answers the pages it fetched as well as storing them — `setListings`
  has not committed when its promise resolves.

**A folder is the deliberate exception and still asks.** The reason a note needs
no prompt is that it has a title field inside it — its first line — and a folder
has no inside to type in. `untitled-2026-09-19/` in somebody's bucket, renameable
only from a row menu they have to find, costs more than one text field.

The checks are `untitledNames.test.ts` (18) and `untitledTitleAdoption.test.ts`
(11, driven through the real hook against a fake bucket and asserting on what was
*called*), plus the "made, not asked about" pairs in `menuActions.test.ts`,
`rowCommands.test.ts`, `createPrompt.test.ts`, `consoleChrome.test.ts` and
`consoleIdentityChrome.test.ts`.

### The phone's bottom row is six keys, and the `+` is all of them

The row's seventh key was a microphone that opened the meeting flow. It is gone,
with the separator that marked it off, and recording is a row in the sheet the
`+` raises — see [meetings](../meetings.md), *The seventh key became a row in the
`+`*, for what that costs the capture route (nothing) and why.

Two consequences that look like details:

- **The key is unconditional where it was gated on `canEdit`.** That was right
  while it meant *note*. A meeting is something a member of somebody else's
  context can still start, so `canEdit` would have taken capture off every shared
  context somebody reads. The read-only rule moved a row lower: the sheet draws
  no Note, Drawing or Folder row without it.
- **And `canCreateAnything` still hides the key when the sheet would have no rows
  at all.** A `+` that opens a dialog containing one Cancel button is worse than
  no `+`, and a read-only context on a surface with no meeting flow is exactly
  where that happens. `files/createSheet.ts` answers both questions — which rows,
  and whether there are any — because two answers computed in two places is how
  the second one goes stale.

`createSheet.ts` decides the **phone's** list and not the corner's. The corner's
menu is mounted only where every row applies (the layout draws it on no
read-only console and on no demo one), so its list is a literal with its grouping
argument in its own comments; the sheet's is what varies. Both draw the same rows
in the same order, and `createSheetRows.test.ts` holds the order as well as the
conditions, because a `+` whose rows move between the phone and the desktop is
two controls wearing one glyph.

The checks are `createSheetRows.test.ts` (8), `is six keys, ending at Save, with
no separator and no microphone` in `bottomRowWidth.test.ts` — which keeps the
seven-key solve as a probe of `BottomBar`, the shape the geometry must survive if
a destination is ever added back — and, in `consoleChrome.test.ts`, `the app's
other place is a row in the + sheet, and choosing it records` and `the + offers
the three files, and Note writes one without asking`.

### A phone can ask its context a question, and could not before (2026-09-19)

Both `+`s offer a Chat row, and on a phone that row raises `AgentPanel` directly
rather than the right panel it has none of.

**It was absent, and the absence was never decided.** `CreateButton`'s handler is
`null` "where a conversation cannot be had", and one of its three reasons read
*no panel to answer in (a phone)* — which was a true statement about the code and
not a product choice. The only thing that raised `AgentPanel` was the floating
microphone `NoteEditor` mounts, and that microphone stands down while the bottom
row is on the glass (*The seventh key became a row in the `+`*,
[meetings](../meetings.md)). So the whole route to the agent on a phone was: open a
note, put the keyboard up until the bottom row hides, press the microphone that
comes back, choose the agent row. The desktop menu offered it in one press.

**The fix is one line of routing, because the panel was already the right shape.**
`AgentPanel` is a `Modal`, and its own header says it is one so it can "appear
identically on a surface that has no console around it at all" — written for the
fixtures, and it pays for this too. `startNewChat` picks the surface by density;
the gate above it is unchanged and still `modelConnected === true`, so a context
with no model key is not offered a conversation on either.

What a "simplification" would cost:

- **Putting `hasAside` back in the gate.** That is the original defect: the row
  vanishes from the phone's sheet and the only route back is the one through the
  keyboard. Held by `the + offers a chat, and choosing it opens the panel`.
- **Mounting the card inside `NoteEditor` instead**, where the microphone raises
  it. Then it exists over a note and nowhere else — no folder page, no map, no
  search — which is the complaint the `+` itself was created to answer.
- **Building a second `agentPage`.** `agentPage`'s comment already asks for one
  builder, and the object is a set of *references*: a second copy is a second
  chance to put a note's body in one, which
  `__tests__/agentPage.test.ts` exists to catch. The layout now builds
  `agentPlace` once and hands the same object to both surfaces.
- **Dropping the `key`.** It is the timestamp, so each press is a fresh
  conversation rather than the last one reopened — which is what "New chat" says.

The checks are `the + offers a chat, and choosing it opens the panel` and `and no
chat row on a phone in a context with no model key`, in `consoleChrome.test.ts`,
both driven through the real layout at 390pt. Four sabotages are recorded in that
file's header.

### The feed is a file, and the console is a viewing layer over it

The ask, from the leadership meeting of 2026-09-19, in its own words: *"How
does Shay even know that this meeting note is here? Is there any type of
indication, especially in shared workspaces too?"*, *"there's logging, but it's
not human readable"*, *"maybe even like on the bottom, just like a number of
updates"*, and — the reason it matters — *"the workspace can feel dead
otherwise. You're working in chat, you open context, and it feels like nothing
happened, but really ChatGPT changed this and Claude changed this."*

The first design answered a different question. It added a third context view
at `/console/@name/activity`, with filters and a two-pane layout, and it was
rejected the same day for being invasive. What was asked for is an indicator,
and the version that shipped adds exactly three things to a console that had no
room to spare: a 5pt dot on a tree row, the note-count line at the foot of the
tree rewritten when something is new, and a dot on another workspace's mark.
Everything else is one popover.

**The thing underneath it is `activity.md`, a note at the root of the
customer's bucket.** Not a table in Convex, and not a rendering of
`.context/audit/` computed per request. That is non-negotiable #3 applied to a
feature every other product would have put in a database: open it in Obsidian
and it reads as a dated list; export the bucket and the history comes with it;
cancel and it is still a file somebody owns. The console draws it as rows, and
`NoteEditor` dispatches on the path exactly as it does for a drawing — so
opening it in a new tab, linking to it, and reading it on a phone all work
without a route of their own, and there is one answer to "which is the real
thing": the file is.

What a simplification of any of this costs, and the test that fails:

- **Making it a table.** The feed stops being the customer's, the export
  promise acquires an exception, and a person reading their bucket in Obsidian
  sees a context with no history in it. `activity.md is a note in your own
  storage` in `ActivityPage` says so on the screen itself.
- **Deriving it from the audit trail on read.** `.context/audit/` is one object
  per change — the shape that is right for a record that must never be
  rewritten and wrong for a list somebody opens. That is what `list_changes`
  does and why it is an agent's tool rather than a screen's.
- **Letting it be team-readable.** It names paths from every corner of a
  context, so it is stored `private` and re-asserted private on any write that
  finds it otherwise; a member gets a *rendering* through `readActivity`, never
  the file. `is refused to a member, and taken back if somebody publishes it`
  fails, and the failure is an index of every private filename in the context.
- **Filtering on the stored flag alone.** A note taken back into private must
  drop out of lines written while it was shared, so `canSee` is re-derived per
  reader at read time. `drops a note out of the member's view when it is taken
  back` fails.
- **Counting what is hidden.** A gap a reader can count is the disclosure the
  flag was there to prevent. `and never sees the private one, nor a count of
  what is missing` fails.
- **Recording every write.** A revision under 80 stored bytes is not one, and
  repeat saves by one hand inside half an hour are one line — without which the
  console's own 2-second autosave writes a line per keystroke burst and the
  list becomes the log the meeting already rejected. `does not write a line per
  autosave` fails, and it asserts the file is *byte-identical* rather than
  merely short, because the cheap path is "write nothing at all".
- **Marking every ancestor with the dot.** The path to the root lights up
  permanently and the mark comes to mean "this context has notes".
  `markedRows` marking every ancestor fails four checks across the two app
  suites.
- **Clearing the marker on open.** A list that marks itself read the moment it
  appears is one you cannot look away from and come back to. `opening the list
  does not mark it read` fails.

**A line points at a note, not at a path it once had.** An entry written on
Tuesday names where the note was on Tuesday, so every path is forwarded through
`.context/forwarding.json` — the ledger "A move leaves a forwarding address"
added, the same trail a share link follows — before a row is drawn or filtered.
Following a row then lands on the note rather than on a gone path, and `canSee`
is asked about where the note *is*, so one moved into a private folder drops
out of lines written while it was shared. The historical path is not lost:
`.context/audit/` keeps it and `list_changes` prints it. `a line written before
a move points at where the note is now` fails on both sides without it.

**What an agent contributes to it is one optional sentence.** `write_note`
takes a `summary` and the orientation text asks for one, so a row can read
"recorded the 2-products rename" instead of a folder path. It is the second
line and never the first: who, what and where come from the change record, so
a client that says nothing costs a path, and a client that says something wrong
costs a sentence rather than a false fact. This reverses the first design's
"no agent summaries", which was wrong on the evidence — the meeting asked for
exactly this and the owner's answer to whether a team might not want it was
*"I think we should enforce it"*.

**The list is a default, and the Markdown is a press away.** The first version
had no way to the file at all: the console drew the list and the editor was
unreachable on that path. For a feature whose own footer says *"a note in your
own storage"*, that was the product saying "your file, our screen" — so the
file now declares `view: read` in its frontmatter (which Obsidian honours too)
and `declaredView` holds the same default by path for every file written before
the line existed, and the pencil opens the source like any other note's. An
owner who types `view: edit` into their own `activity.md` lands in the source
from then on, because a default a person has overruled in writing is not a
default any more. This is **not** the drawing's trade next to it and must not be
confused with it: one keystroke in a drawing's base64 destroys the diagram, so
`DrawingEditor` genuinely refuses the text editor. Nothing here is destroyed by
typing, so refusing would be taste dressed as safety.

**Editing it is the owner's, and viewing it is everyone's.** Hand-editing this
file is editing the record of who changed what — the authority `canShare` and
`canSetVisibility` are, not the "may write notes" an editor has — so
`canEditActivity` gates the pencil. That is the *affordance*; the guard is
older and stronger, and unchanged: the file is stored `private`, so a member or
an editor cannot read it at all and is served the filtered rendering through
`readActivity`. "Members view" has always meant the rendering, and it has to:
the raw file names paths from every corner of a context.

**The writer splices rather than regenerates, and that is what makes the
sentence true.** `renderFile` rebuilt the whole file from a template on every
write, so anything a person typed into it survived until the next agent wrote a
line — an honest description of which is "you may edit this until something
happens". Now the contract is one sentence, and it is stated in the file
itself: **between the markers is the machine's, everything else is yours.** The
region between them is rebuilt from `.context/audit/` because a derived copy
that drifts is worse than no copy; everything either side is carried through
untouched, forever. `a later write keeps prose above the markers` and `and
keeps what is below them` fail without it. The one shape it will not guess at
is a file whose markers were deleted: there is no boundary to find, so it lays
down a fresh header rather than deciding for itself where somebody's text
ended.

**A row somebody broke is named, not swept up.** Editing a row's words is free
— the `<!--ctx …-->` comment is what is read. Deleting that comment, or
breaking its JSON, makes the row stop existing for every reader, and the next
change drops it. The console counts those (`strayRows`) and says so, because
silence is how a person edits a file, watches rows vanish and concludes the
product ate them. What it does **not** offer is the obvious button: a one-press
"fix" that deletes what somebody typed is the product taking the file back the
moment it looks untidy, in the one feature whose whole subject is that the file
is theirs. So it hands over a prompt to give an AI client, and that prompt
forbids the one thing a client must never do here — invent a `<!--ctx -->`
comment, which is the record, and a fabricated one is a fabricated fact about
somebody's context. `and forbids inventing a record` fails if that line goes.

**The column is the note's column.** `noteColumnWidth` and `layout.notePadX`,
centred — the same measure `LiveEditor` spends in CSS and `noteGutterFor`
describes, not a resemblance: the pencil swaps the list for that editor over
the same file, and text that moved sideways at the press would make the two
read as different documents. It shipped as a hard 760 pinned to the left edge,
and was found in a screenshot rather than by any of 7,600 tests, because
react-native-web compiles styles to classes and jsdom lays nothing out. That
claim now lives in `e2e/webkit/activityPage.spec.ts`, and the demo tree carries
an `activity.md` — a real `renderFile` output, not a hand-drawn one — so there
is a page for a browser to open at all. It is the third time on this feature
that the fixture not being able to show the thing under review was the whole
defect.

**Three numbers decide what is substantial, and they are thresholds rather
than tuning.** They live in one place — `packages/shared/src/activity.cjs`, the
module both writers import — because a gateway that disagreed with the console
about what counts would produce a feed whose density depended on which client
you happened to use.

- **80 stored bytes** (`MIN_REVISION_BYTES`), measured in either direction so a
  deletion counts. About a sentence: it drops a fixed typo, a frontmatter
  `updated:` bump and the whitespace an editor churns on open, and keeps
  anything a person would call an edit. Set it to zero and every autosave is a
  line — `does not write a line per autosave` fails. Raise it much and a
  one-line correction to a decision note, which is exactly the change somebody
  needs to hear about, vanishes.
- **30 minutes** (`GROUP_WINDOW_MS`), or **6 hours** for a saved session. Two
  changes by one hand inside the window are one line, so the row reads "added 3
  notes in `1-projects/`" rather than three rows a minute apart. The session
  window is longer because an active context collects dozens of saves a day and
  every one of them is the same sentence. Widen the general window past an
  afternoon and this morning's edit merges into this afternoon's — a line that
  says the wrong time about the wrong edit, which is why `MERGE_LOOKBACK` caps
  the scan at 8 entries as well as the clock.
- **5 minutes** (`REFRESH_MS`). This one is not about readability; it is what
  makes the console's 2-second autosave affordable. When the line a change
  would write is already on file, unchanged and less than five minutes old,
  **nothing is written at all** — no read, no conditional put, no request. The
  price is that "revised" can read five minutes behind the last keystroke,
  which is imperceptible in a list whose finest grain is a minute. Remove it
  and every save rewrites a 60 KB file. `the REFRESH_MS early return removed`
  is a live sabotage entry in the gateway suite.

The file is capped at **400 entries**, about 60 KB and roughly three months of
a busy shared context, because every write rewrites the whole file. What falls
off the end is not lost: `.context/audit/` keeps every change record and this
file is rebuildable from it, which is the third non-negotiable holding — the
feed is a derivative that happens to be canonical Markdown.

**A row cites a path, because a note has no identity to cite.** This is worth
stating because the forwarding it leans on could easily be mistaken for one.
`.context/forwarding.json` is a *trail between paths* — where a thing that was
here went — and deliberately not a note id and not an index of what refers to a
note. Nothing in this product gives a note a stable identifier, and adding one
to make the feed simpler would put an identifier in the customer's Markdown
that only we can read, against the first non-negotiable. So an entry stores the
path as it was at the time, and every path is re-derived through the live
forwarding ledger at read time, on both sides: a row is *drawn* at where the
note is now, and `canSee` is *asked about* where it is now. The historical path
stays in `.context/audit/`, where `list_changes` prints it. Skip the
re-derivation and `a line written before a move points at where the note is
now` fails in two suites; replace it with an id and the exit promise acquires
an asterisk.

**The dot on another context's mark is a timestamp, not a read.** A console
that showed "something changed in @acme" by opening every bucket its person can
reach would cost one storage round trip per workspace on every load, for a
6pt dot. Instead each workspace row carries an `activityAt`, stamped forward
only when a line is actually written — by the console through
`markWorkspaceActivity`, and by the gateway through `POST /gateway/activity`,
whose entire body is one workspace id. The reader's own `activitySeenAt` is
already on their membership for the same feature's foot line, so the dot is one
comparison over data the console already loads.

**Being in a quiet context catches you up, and that is not a softening of
"closing the list marks it read".** One timestamp per workspace cannot say
whose line it was, so a person's own console edit stamps `activityAt` and
lights a dot on their own context. Inside that context the edit is correctly
not news — `isUnseen` drops it for `me` — so the foot line never appears, so
there is no list to close, so nothing calls `markSeen` and **the dot never goes
out**. A mark that is always lit means nothing, which is worse than no mark.
So `shouldCatchUp` moves the marker when a loaded context has nothing this
reader has not seen and the marker is behind the newest line: at most one
mutation per visit to a context somebody else quietly moved. It returns false
the instant one line is unread, which is the rule the popover's behaviour
rests on, untouched. Your own edit *through a client* is still news to you —
that is the whole feature, in the meeting's words: *"ChatGPT changed this and
Claude changed this but you don't really see it"*. `being in a context whose
newest line is your own catches you up` and `but one line you have not seen is
enough to stay behind` are the pair.

**And one timestamp per context would have leaked.** `activityAt` says when a
context last moved; served to every member, it tells somebody who is not the
owner the exact minute of a change the file refuses them, the tree hides and
`list_changes` filters out — a private write's clock, in the one corner of the
product nobody would think to audit. So the row carries two stamps:
`activityAt`, which counts every line, and `activityTeamAt`, which counts only
the `team` ones. `listMyWorkspaces` hands the owner the first and everybody
else the second, narrowed in the query rather than on the client, because a
number that reached a device has been disclosed whatever the device then does
with it. That is the coarser of the two privacy gates and deliberately so:
nothing per-reader can be computed from a row every member reads, and a
`team`-tier line pointed at a named group is a thing the folder already
published to the workspace. It is also why the gateway's report carries a
boolean beside the id — not a fact about the note, but which of the two stamps
may move; absent reads as private, so a caller that omits it can only
under-report. `a private change never reaches a member's row` and `and the
private write does not move the team stamp it sits after` are the pair, and
`and a private one reports false, so no member's dot moves for it` is the
gateway's half.

Two things are load-bearing about that. **The stamp follows the line, not the
operation** — a change the feed declines to mention stamps nothing, or the dot
sends somebody looking for something that was never written down; `a change
nobody would mention stamps nothing` and `a change too small to mention reports
nothing` fail. And **an id and a tier are the whole of what may cross
the boundary**: what changed, who changed it and where are in the customer's
bucket, and a second copy on our side built so a dot can be drawn is the first
non-negotiable spent on a pixel. `with the context it was written into, its
tier, and nothing else` asserts that over the serialized request body rather
than over a field list, so a field added later is caught by the shape rather
than by somebody remembering to look. The route answers `{ok: true}`
identically on every path, including an id that is no workspace, because the
difference between "no such context" and "not yours" is the oracle a
gateway-authenticated route must not be. Counting unread *for* the reader was
rejected on the same boundary: an unread count is a question about what that
one member may see, over a row every member reads. `usageActiveDaily` was
rejected for a different reason — it is day-granular and counts reads, so it
would light the dot for somebody opening a note.

**And then it was looked at in a browser, which found three things no test
had.** `activityRender.test.ts` mounts `<Explorer>` with a prop it supplies
itself, so the console's own slot — `activity={data.activity}` in the layout —
was covered by nothing: delete that line and the suite stays green. The visual
fixture now carries an activity view and `e2e/webkit/activityIndicator.spec.ts`
drives it in a real engine, which is where these turned up:

- **Rows spent their width on paths.** The shared module's sentence names the
  full path, which is right for the file and wrong in a 240pt column: `A
  meeting landed: 0-inbox/meetings/2026-0…` had said nothing by the time it ran
  out. The console names the note and puts the folder underneath — and names it
  the way the tree does, without the sort number or the `.md`, because two
  names for one row is worse than either.
- **The unread marker read `Before 18h`.** A relative age is not a heading. It
  says `Earlier`; when you last looked is the foot line's sentence.
- **`4 min` wrapped to two lines** and grew the row, because nothing in jsdom
  lays anything out.

The first draft of the fixture data also named three notes in a folder the demo
tree has never had, so the console drew no dot and the board was reporting on
itself — the failure that page's own header warns about, reproduced while
guarding against it.

