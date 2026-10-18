# Routines

_See `docs/decisions/README.md` for the index. The product ask is the Supa
Media workspace's `1-projects/context-agent/07-long-running-and-schedules.md`
and the design proposals beside it (2026-10-07)._

### A routine is a note, and the folder it sits in says how often

Decided by the owner, 2026-10-07. A routine is one Markdown note at
`tex/routines/<how-often>/<name>.md` (its home since 2026-10-14, see "Routines
live in Tex's own folder" below), or at `routines/<how-often>/<name>.md`, where
it lived first and still runs. Adding the file starts it, deleting it stops
it, and moving it to another folder changes how often it runs. The body is the
instruction in plain words; optional front matter fine-tunes it (`at`, `on`,
`send`, `to`, `until`, `paused`, `timezone`).

Folder names: `once` (see below), `hourly`, `daily`, `weekly`, `bi-weekly` (or `every-2-weeks`),
`monthly`, `quarterly`, `yearly`, and `every-N-minutes|hours|days|weeks|months`
for anything else. The routine folder sits at the top of the workspace, beside
`website/`, because it has to work in a workspace that isn't sorted into
inbox, projects and areas: `tex/routines/` inside Tex's own `tex/` folder, and
`routines/` for the routines made before that. The owner chose files over a Settings list: there is
no Settings › Routines, and a routine note shows its own schedule and recent
runs where it is read.

One module reads the format (`packages/shared/src/routines.cjs`), and the
gateway, the control plane and the app all import it, so "when does this run"
has one answer.

**What a simplification would cost:** a schedule kept in a database row, or a
Settings list that can disagree with the folder, means the files stop being the
whole truth, and an export or an AI client editing the note no longer carries
what the routine does. Tests: `apps/mcp/test/routines.test.mjs`.

### Routines live in Tex's own folder, and the old folder keeps running

Decided by the owner (Dev2), 2026-10-14, on a decision card. Routines move
into a `tex/` folder at the top of each workspace: new routines and reminders
go in `tex/routines/<how-often>/<name>.md` (one-offs in `tex/routines/once/`),
beside `tex/about-me.md`, the note Tex reads about the person
(`apps/mcp/src/agent/aboutMe.js`). Every existing `routines/<how-often>/` note
keeps running exactly as before, and **nothing is moved for anyone**: no
migration, no rewritten key, no copy. Both roots are first-class everywhere a
routine path is recognised, from the one reading of the format
(`ROUTINE_ROOTS`, `routineRootOf`, `isRoutinePath` in
`packages/shared/src/routines.cjs`):

- **The scan lists both roots every time**, `routines/` first, and counts both
  toward one `MAX_ROUTINES_PER_WORKSPACE`, so a workspace at the cap keeps the
  routines it already had and a new one past it is what is left out. A root
  that is not there lists as empty, so a workspace with only one scans as it
  always did.
- **A change under either root, or to the `tex` folder itself** (moving or
  trashing it takes `tex/routines/` with it), is a routine signal, from the
  gateway's write and the console's barrier alike. A move from one root to the
  other is a move like any other: the old row goes, the new one runs as the
  person who moved it. `tex/about-me.md` beside the root is not a routine.
- **Run history never collides.** `routines/daily/x.md` keeps
  `.context/agent/routines/daily/x.json`, byte for byte, because that is a
  stable on-bucket key; `tex/routines/daily/x.md` keeps
  `.context/agent/tex/routines/daily/x.json`. A moved routine's history stays
  under the path it ran at, as it always has for a move between schedule
  folders.
- **The texting assistant is told to write new routines and reminders in
  `tex/routines/`**, and that old ones still run where they are; a malformed
  path under either root is refused. The app's run bar draws on both.

**What a simplification would cost:** moving everyone's `routines/` into
`tex/routines/` rewrites user-authored keys and breaks the dual-read promise
for a stable format; recognising only the new root stops every existing
routine; one history prefix for both roots makes two different routines read
each other's answers. Tests: `apps/mcp/test/routinesTexRoot.test.mjs`,
`agentRoutineTex.test.mjs` and the `tex/routines/` tests in
`routineSignal.test.mjs` (gateway); `apps/convex/__tests__/routinesTexRoot.test.ts`
(control plane); "the bar in Tex's own folder" in
`apps/mobile/__tests__/routineBar.test.ts`.

### A one-off reminder is a routine in `routines/once/`, marked `done:` when it has run

Decided by the owner, 2026-10-14, after the texting assistant answered "remind
me to…" with "I can't". A one-off is the same note as any routine, in
`tex/routines/once/` (or `routines/once/`; see above), with its date and time in `at:` (`at: 2026-10-15 9:00 am`, or
the day in `on:` and the time in `at:`). A one-off with no date is a problem in
words, never "today". It runs once at that wall-clock moment in the routine's
time zone; after a run that did not fail the gateway writes `done: <when>` into
the file (with the etag it read, so a concurrent edit is kept), and `done:` is
read as paused, so it never runs again and stays as the record of what was
sent. A run that failed is tried again every five minutes until thirty minutes
after the moment it was set for, then left: a reminder that arrives hours late
is worse than one that says it didn't run.

**What a simplification would cost:** deleting the file after it runs loses the
record and makes "did it remind me?" unanswerable from the notes; keeping a
one-off in a database row breaks "the files are the whole truth". Tests: "a
one-off runs once, at the date and time its file names" and "a one-off marked
done: never runs again" (`apps/mcp/test/routines.test.mjs`), "a one-off texts
its reminder, then stays where it is, marked done:"
(`apps/mcp/test/agentRoutine.test.mjs`), and `apps/convex/__tests__/routinesOnce.test.ts`.

### A line the format can't read is said out loud, never defaulted

`at: half seven` does not become 8 am. Each unreadable line comes back as a
sentence saying how to write it, and the routine note shows it. A routine that
quietly runs at the wrong time is worse than one that says it cannot read its
own time. A bare number (`at: 7`) is refused for the same reason: it could be a
minute. Test: "a line it can't read is a problem in words, never a silent
default".

### Intervals count from a fixed epoch, never from when the file was saved

Every N minutes falls on minute marks divisible by N since 1970; every N hours
on local hours divisible by N; every N days, weeks and months on day, week
(from Monday 1970-01-05) and month counts divisible by N. Re-saving a note, or
the control plane rebuilding its list, cannot move a run. Times are wall-clock
times in the note's `timezone`, else the account's, so 7:30 am stays 7:30 am
across a daylight-saving change. Tests: "every N minutes falls on fixed marks",
"weekly defaults to Monday; every 2 weeks keeps a fixed parity", "daily runs at
the local time in the routine's time zone".

### Nothing runs faster than every five minutes

`every-1-minute` and `every-2-minutes` are not schedules; the note says the
fastest is every five minutes. Test: "a folder name says how often".

### A run's history is Context's plumbing in the customer's bucket

What a run did, and what it texted, is note-derived text, so it is kept in the
person's own bucket under `.context/agent/routines/<folder>/<name>.json` (and
`.context/agent/tex/routines/<folder>/<name>.json` for a `tex/routines/` note), like
the texting conversation history, and never in the control plane. Test:
"run history lives in Context's own space, named after the routine".

### A routine runs on a connection of its own, as its writer, and is re-read when it runs

The control plane mints a grant for the client `context_routines` on the
routine's workspace, for the person who wrote it. That connection runs
routines through `/agent` and nothing else, and no other connection may run
one; both are decided by the grant's client, never by the request. It is not
the texting grant, which is one per person and would be revoked by the next
mint. The gateway re-reads the note through `read_note` on that connection at
the moment it runs, so a routine its writer can no longer see, one that was
deleted or moved, and one with `paused: yes` never reach a model, and the
paused check comes before a model is opened so it costs no turn. The answer
`SKIP` means nothing to say and `DONE:` means the `until:` came true; both are
outcomes in the run history, not texts. Tests (`agentRoutine.test.mjs`): "a
routine is refused from any other connection", "a routine its writer can no
longer see does not run", "a paused routine costs no turn".

### The texting Worker pulls due runs, and only texts phones that texted first

The texting Worker (`apps/agent`) runs routines from a Cron Trigger every
minute: it asks the control plane which runs are due, runs each on the
gateway's `/agent` with that run's own grant, texts the answer, and reports
back an outcome code and how many phones it texted. It pulls with the secret
it already holds for `/agent-texts/*`, so nothing calls it and it needs no new
secret. The answer goes from the gateway to the phone through the Worker and
nowhere else; the control plane hears a code and a count, never text. Linq's
line only reaches people who texted it first, so each sender's inbox remembers
the chat it last texted from (an id, never text), a phone with none is not
texted, and a run that needed a text and reached nobody is `no_chat`. The
gateway's `send:` wins over the control plane's, because the gateway read the
note just now. **What a simplification would cost:** a control plane that
pushed runs to the Worker would need a second secret pointed the other way,
and one that carried the answer would hold note content. Tests:
`apps/agent/src/routines.test.ts`.

### The control plane keeps when and as whom, never what

The control plane's half (`apps/convex/functions/routines.ts`,
`functions/lib/routines/`) keeps one row per routine file: the path, the
schedule read off the folder and front matter (`cadence`, `at`, `on`, `send`,
`to` handles, `paused`, `timezone`), the writer, `nextRunAt`, and the last run's
time and outcome code. It never keeps the body, the `until:` sentence, or the
problem sentences, because each of those is the note's own words, and the
outcome is a code from a closed list (`answered`, `skipped`, `finished`,
`failed`, `paused`, `routine_gone`, `not_a_routine`, `daily_limit`,
`no_provider`, `no_chat`, plus its own `writer_gone` and `writer_unknown`): the result route refuses
anything else and ignores every other field. The rows are a derivative: a scan
of `tex/routines/` and `routines/` (on a gateway signal, `POST /gateway/routines`, on a console
write through the barrier, debounced per workspace, and every six hours as a
safety net) rebuilds them, and a row whose file is gone is deleted only when
the listing was complete. Tests: `routinesSync.test.ts` "keeps the schedule,
the writer and nothing the note says", `routinesRuns.test.ts` "only a known
code is kept, and never any text".

**The writer** is whoever last wrote the file, kept only while they are an
owner or editor of that workspace (a signal naming a member or a stranger names
nobody). In a personal workspace, a file found with no known writer runs as
its owner (`writerSource: "fallback"`), and then its `to:` is ignored and only
the owner is texted, because anyone who put the file there without a signal
could have named themselves and had the owner's private reach texted to them
(test: "a personal routine nobody was seen writing still texts its owner,
whatever its `to:` says"). In a **shared** workspace it does not run at all:
the row waits (`writer_unknown`, "Save it once so it runs as you" in the app)
until someone who can write saves it. Falling back to the owner there texted
one person what another had asked for (reported 2026-10-18: someone's Tex
texted them updates on another person's work, from a routine they never
wrote). Asked again when a run is handed out, so a row written
under the old rule stops too (tests: "a shared routine nobody was seen
writing texts nobody, and runs once someone who can write saves it", "a
shared routine left running as its owner by an earlier rule is stopped when it
comes due"). The first signal from someone who can write makes it theirs. A
writer who loses write access is **not** replaced by the owner: the row stops
(`writer_gone`) until someone who can write saves the file, because handing an
editor's words to the owner would run them with the owner's private reach.
Write access is asked again when a run is handed out, not only when the row
was written. Tests: "a writer who lost access is not replaced by the owner",
"a writer who lost write access is not run".

**Time zone:** the file's `timezone:`, else the writer's own (`setMyTimeZone`,
an `accountTimeZones` row), else `America/New_York`.

**The lease.** `POST /agent-texts/routines/due` claims due rows, moves each
`nextRunAt` to the next run after now (a missed window runs once, not once per
missed slot), and holds the row for fifteen minutes, the same as its grant's
life, so a lapsed lease never holds a live token. Each writer has one
`context_routines` grant per workspace, patched per run and never the texting
grant; runs for one writer in one call share its token, and a writer with a
run still out waits for it rather than have its token replaced mid-turn. The
result releases the lease and ends the token. Tests: "a claim moves the next
run on, and a live lease is not claimed twice", "a routine's grant leaves the
texting grant alone".

### Texting writes routine files, and nothing else

The owner decided on 2026-10-07 that texting "every morning tell me..." makes
the routine file and says where it is. Since 2026-10-08 a text edits any note
directly ([texting-assistant](./texting-assistant.md), "A text has every
MCP tool"), so routines are no longer the only write; what stays from this
decision is that a path under `tex/routines/` or `routines/` must be exactly
`<root><schedule>/<name>.md`, in the person's own context (no `context`
argument), checked in `src/agent/textingWrites.js`. The routine's own run is
never offered a write, so a routine cannot rewrite itself or another one. A
routine whose `until:` came true is archived, recoverably, and paused in place
where the layout has no archive. Tests (`agentRoutine.test.mjs`): "a text
never exports keys, touches plumbing or writes a malformed routine, whatever
the model named", "a routine's own run is never offered a write", "and stops itself,
recoverably".

### A routine note shows its schedule and its recent runs, and Pause is a line in the file

The app draws a bar on any note under `tex/routines/<schedule>/` or `routines/<schedule>/`: the schedule in
words (read from the note as it is typed), when it last ran, Run now, and
Pause, which writes `paused: yes` into the file through the editor's normal
save, so the file stays the whole truth. There is no Settings list (the
owner, 2026-10-07). Recent runs are read from the run history in the
customer's bucket by one file operation, `routineRuns`, which takes only a
scheduled routine's path, checks the caller can see that note against the
live `privacy.md` and that it still exists, and only then reads its history;
every other `.context/` read stays refused. Tests (`routinesHistory.test.ts`):
"a member cannot read the runs of a routine they cannot see", "only a
routine's history, never another plumbing key or a note's". The app also
saves the device's time zone (`setMyTimeZone`) so routines run at local time.

### A routine's schedule is read from the tree's front matter, never the note

Decided by the owner, 2026-10-14: names and front matter come from the
Convex tree, and storage is read only for a note's content. The scan lists the
routine folders from the tree and takes each schedule (`at:`, `on:`,
`to:`, `paused:`) from the front matter the tree's facts already hold
(`nodeFacts.propsNow`), rather than opening every routine note.

A routine whose facts were read before its latest write is **waiting**. The
scan leaves its row alone, so nothing is deleted or rescheduled from stale
words, and it keeps the writer its signal named. When the facts land
(`nodeFacts.record`), another scan is scheduled. That scan is how a routine
written a second ago gets scheduled, and the writer is kept so that the
owner's private reach never stands in for an editor.

**What fails if reversed:** `routinesSync.test.ts`, "a scan reads the tree,
never the bucket" (no GET during a scan) and "a routine whose front matter
the tree has not read yet waits, and keeps its writer". Removing either the
facts hook or the writer hold turns the second one red.
