# Routines

_See `docs/decisions/README.md` for the index. The product ask is the Supa
Media workspace's `1-projects/context-agent/07-long-running-and-schedules.md`
and the design proposals beside it (2026-10-07)._

### A routine is a note, and the folder it sits in says how often

Decided by the owner, 2026-10-07. A routine is one Markdown note at
`routines/<how-often>/<name>.md`. Adding the file starts it, deleting it stops
it, and moving it to another folder changes how often it runs. The body is the
instruction in plain words; optional front matter fine-tunes it (`at`, `on`,
`send`, `to`, `until`, `paused`, `timezone`).

Folder names: `hourly`, `daily`, `weekly`, `bi-weekly` (or `every-2-weeks`),
`monthly`, `quarterly`, `yearly`, and `every-N-minutes|hours|days|weeks|months`
for anything else. `routines/` sits at the top of the workspace, beside
`website/`, because it has to work in a workspace that isn't sorted into
inbox, projects and areas. The owner chose files over a Settings list: there is
no Settings › Routines, and a routine note shows its own schedule and recent
runs where it is read.

One module reads the format (`packages/shared/src/routines.cjs`), and the
gateway, the control plane and the app all import it, so "when does this run"
has one answer.

**What a simplification would cost:** a schedule kept in a database row, or a
Settings list that can disagree with the folder, means the files stop being the
whole truth, and an export or an AI client editing the note no longer carries
what the routine does. Tests: `apps/mcp/test/routines.test.mjs`.

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
person's own bucket under `.context/agent/routines/<folder>/<name>.json`, like
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
`no_provider`, `no_chat`, plus its own `writer_gone`): the result route refuses
anything else and ignores every other field. The rows are a derivative: a scan
of `routines/` (on a gateway signal, `POST /gateway/routines`, on a console
write through the barrier, debounced per workspace, and every six hours as a
safety net) rebuilds them, and a row whose file is gone is deleted only when
the listing was complete. Tests: `routinesSync.test.ts` "keeps the schedule,
the writer and nothing the note says", `routinesRuns.test.ts` "only a known
code is kept, and never any text".

**The writer** is whoever last wrote the file, kept only while they are an
owner or editor of that workspace (a signal naming a member or a stranger names
nobody). A file found with no known writer runs as the workspace's owner
(`writerSource: "fallback"`), and then its `to:` is ignored and only the owner
is texted, because anyone who put the file there without a signal could have
named themselves and had the owner's private reach texted to them; the first
signal from someone who can write makes it theirs again (test: "a routine
nobody was seen writing texts only the owner, whatever its `to:` says"). A
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
