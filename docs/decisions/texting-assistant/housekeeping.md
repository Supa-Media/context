# Tex keeps house: it organizes the workspace itself, and every change can be put back (2026-10-17)

The owner asked for "a proactive and consistent … in the same proactive loop
as a workspace heartbeat … going in and fiercely organizing things, updating
project statuses, archiving, getting the chaos score lower", naming finished
projects that belong in the archive, contacts to merge and folders holding one
file, "measured on how well it does on different tasks". It is built from
scratch, not on the app's auto-organize suggestions (`functions/organizer.ts`),
at the owner's word: "I'd rather you start from scratch."

**This reverses "It reports; it never tidies"** in
[the chaos score](../chaos-score.md) for one actor: Tex's housekeeping. Orient,
the app and every write still only report the score; nothing else tidies on
its own.

**What one run is** (`apps/mcp/src/agent/housekeeping.js`). One model turn
over the person's personal workspace. The gateway reads `orient about:
health` (the score and its biggest wins) and hands it to the model with the
Supa way of organizing, from @context-lc `guides/how-to-use-context.md` (PARA:
inbox, projects, areas, resources, archive, plus clients, teams and products
for a business), and the jobs in the order they pay off: finished projects to
the archive keeping their path, stale project statuses, duplicate contacts,
one-note folders, crowded folders grouped by theme, inbox notes older than
about three months to the archive. Contacts follow
[the contacts rule](../communications/contacts-and-chat.md#contacts-one-page-per-person-and-a-merge-never-rewrites-history):
a shared email, phone or handle merges; a shared name only gets a `review:`
question.

**What it may touch** (`housekeepingGuard.js`, before the session's own
dispatcher). Reads; `move_note`, `move_notes`, `move_folder`, `archive_note`;
and `write_note` on a note that exists (an etag is required, and a rewrite
that keeps less than 60% of the note's text is refused, because housekeeping
changes front matter and merges, never cuts). Refused: anything that could
widen who sees something (`mightWiden`), any other workspace, any other tool,
every path that names a workspace (`@name/…`, which the session would route
there), every path under `tex/`, `routines/`, `website/` or `.context/`, or at
the top of the workspace, a whole top-level folder, and a move into a
top-level folder that is neither built in nor already holding notes. No cap
on how much one run changes (owner, 2026-10-17: "remove limit"); only the
model's rounds (40) and its tools' time (3 minutes) are bounded, so a turn
that never ends still ends. Until 2026-10-17 a run was silently held to a
texted turn's eight rounds, which cut the first benchmark short.

**Reversible and logged.** Every change is a move, an archive or a versioned
rewrite. `tex/housekeeping/YYYY-MM-DD.md` lists each one with the line that
puts it back, the score before and after, the model's account and every step,
the way a dream is logged. The caller gets `{ outcome, changes, chaos, line,
log }`, where `line` is one sentence it may text.

**Who runs it.** Its own client, `context_housekeeping`, on a short-lived
grant for the personal workspace; never the texting, dream or heartbeat
check-in client, because those read or write one note and this changes many.
The control plane lets that client spend the built-in model
(`builtinModel.ts`), on the same Premium plan, cap and kill switch as the
others; the first 100 accounts' founding plans count as Premium. Until
2026-10-17 it was missing from that list, so every run was refused.

**Its words.** `@context-lc ai/production/housekeeping.md`, the AI tab's
Housekeeping job, like the dream's and the check-in's: its body replaces the
built-in instructions (`HOUSEKEEPING_INSTRUCTIONS`) and its `models.main`
the model, when valid. The run's facts (today, the health report) and the
answer the gateway reads stay in code.

**When.** Once a day, at the first look after 9am in their own time zone:
after the night's dream, before the day fills up. It rides the same minute
loop as the dream and the check-in (the texting Worker's Cron asks
`/agent-texts/housekeeping/due` and reports a code to `/result`), with its own
row (`texHousekeeping`) and lease rather than sharing the check-in's, so a
slow tidy never holds up a check-in. Everyone with a linked phone is armed by a
daily sweep and by their texts; whether it runs, and as whom, is asked again
at each claim (`lib/texJobs.ts`). Every run goes on to tomorrow, one that
found no model included, and the daily sweep restarts a row that stopped. It
texts nobody: what it did is in its log, and `line` is kept for
the check-in to mention if the person asks for that.

**Many notes move by their names (2026-10-26).** A crowded folder of several
hundred dated notes is the commonest chaos, and a run that wrote its moves out
one by one spent its whole clock on one batch: @seyi's run wrote 100 moves,
sent them as a dry run (an applied keyed batch needs each note's version), and
the dry run read every note's body in turn and was cut off at 60 s. So
housekeeping's `move_notes` also takes `{ folder, match, into }`: the gateway
lists the folder, moves every note directly in it whose name matches, 100 a
batch, each batch through the same guard, planning a batch for its versions
only where the store asks for them. A keyed workspace's dry run now plans from
each row's version without reading bodies, and a keyed batch looks its notes
up ten at a time. The log states, from what the gateway saw rather than from
the model, how many dry runs it made and whether a change was still running
when the run ended, because that run's own account called a timed-out move a
dry run. Tests: `apps/mcp/test/housekeepingByName.test.mjs`. To check a fix on
a real run without waiting for 9am, the manual "Tex housekeeping now" workflow
brings one person's next run forward (`runHousekeepingNow`); the next Cron tick
claims it like any due run.

The first bench run over a crowded folder (240 run logs) showed two more ways
a run stalled: the model wanted a quarter (three months) and `*` cannot say
it, and it named its new subfolder bare (`into: "2026-03"`), which the landing
check read as a new top-level folder; it then tried to write `about.md` notes
to make the folders, which housekeeping refuses. So the pattern also takes
`[1-3]` sets and `{01,02,03}` alternatives, a bare `into` is a subfolder of
`folder`, and the instructions say the move makes the folder.

**Measured.** `apps/mcp/bench/ai/tests/housekeeping.md` (`mode: housekeeping`)
(AI Benchmark, job `housekeeping`, with the live setup note) runs it on
Tomas's deliberately messy workspace and grades where each note
ended up with `must file` checks (`bench/checks.mjs`), not with the judge.

**What a simplification would cost.** Running it under the texting client or
an MCP grant lets a conversation trigger unwatched bulk changes. Dropping the
guard's protected paths lets a tidy move routines (which stop running) or the
website (which unpublishes). Dropping the log loses the undo. Tests:
`apps/mcp/test/agentHousekeeping.test.mjs` and `apps/convex/__tests__/housekeeping.test.ts`, each with its sabotage record; `apps/agent/src/housekeeping.test.ts` for the Worker.
