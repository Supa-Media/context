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
