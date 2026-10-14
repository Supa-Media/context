# The tool shelf and a shorter memory

Part of [the texting assistant](../texting-assistant.md).

## A setup hands Tex a few tools and names the rest (2026-10-14)

Decided by the owner, 2026-10-14, after finding Tex "very stupid": "we only
give it the absolute necessity tools ... it should know the names of the tools
... and then it uses tool search to get the actual schema." Every texted turn
was handed about fifty tools, some 18,000 tokens of schema, on every round,
and a small model buried in descriptions picks slowly and badly.

A setup may name its core tools (`core_tools: [search_notes, read_note, …]` in
`ai/production/<job>.md`). A turn is then offered those, each cut to the first
paragraph of its description, plus `find_tools`; every other tool it holds is
listed in the system prompt by name and first sentence, and `find_tools`
(by names, or by a few words) puts the full definition in the tool list from
the next round on (`apps/mcp/src/agent/toolShelf.js`). With four core tools the
tools and the list together are about 3,600 tokens. A setup with no
`core_tools` is offered everything, as before.

The shelf changes what the model is told about, never what it may reach: every
shelved tool is one the turn already holds, so a model that calls one by name
without loading it has it loaded and run, and a name the turn does not hold is
still refused. `write_note`'s routine help sits in its first paragraph so a core
`write_note` keeps it. This is ours rather than a provider's tool-search
feature because a turn can fall back to a non-Claude model mid-turn.

**What a simplification would cost:** offering every tool again puts the
18,000 tokens back on every round; hiding the shelved names from the prompt
gets "I can't do that" for things Tex can do. Tests:
`apps/mcp/test/agentToolShelf.test.mjs`.

## The conversation is kept long and shown short (2026-10-14)

Same conversation: "Every text is a brand new turn. I don't necessarily think
that that is bad ... if it does need to, we should have a tool that just shows
it what was said in the past because we should still keep running history."
The conversation file keeps the last 40 texts (40,000 characters); a turn is
shown the setup's `history:` count of them (12 when unset, 0 allowed), and
`earlier_texts` reads the whole file in words when a text points back further.
Reading it marks the turn as having read from outside when anything in it was
written after such a read, as the shown part already does.

**What a simplification would cost:** showing the whole file again is the
bloat the owner asked to remove; dropping the file loses "the second one".
Tests: "a turn is shown the newest texts its setup asks for, and
earlier_texts reads them all", `apps/mcp/test/agentConversation.test.mjs`.

## Tex keeps what it knows about the person in `tex/about-me.md` (2026-10-14)

Same conversation: Tex "knows nothing about me when the text arrives", and
its memory belongs in a `tex/` folder, "memory about me that it's always
updating", not in a framework's opaque store. A texted turn reads
`tex/about-me.md` from the person's own workspace through the session's
dispatcher (so `privacy.md` and the grant decide, as for any read), puts up
all of it in the system prompt, and, when it can write, is
told to add lasting facts there with `write_note`, reading first. A missing or
unreadable note is an empty one, never a failed turn
(`apps/mcp/src/agent/aboutMe.js`). It is an ordinary note: the person reads,
corrects or deletes it like any other, every change is in its history, and it
leaves with an export.

The note has a hard size: 500 lines and 40,000 characters (the owner,
2026-10-14: "it doesn't need to be more than 500 lines"). `write_note` refuses
any write past it, whoever the writer, and `remember` goes through the same
check, so the prompt always carries the whole note and Tex is told to merge
and drop what's stale as it grows.

**What a simplification would cost:** keeping the profile anywhere but a note
makes it the opaque memory the owner ruled out. Tests:
`apps/mcp/test/agentAboutMe.test.mjs`, and "Tex's memory note holds at most 500
lines, from write_note and remember alike" (`apps/mcp/test/remember.test.mjs`).

## Every turn knows the time where the person is (2026-10-14)

Tex once answered "remind me to sleep in 2 minutes" by asking for the time on
the person's phone: no turn had ever been told the date or time. Now every
turn's system prompt carries the day, date and time in the person's zone, plus
the same instant written the way a one-off routine's `at:` line takes it
(`apps/mcp/src/agent/localNow.js`).

The zone is the one their routines run in, so a reminder Tex works out lands
when it says: the account's zone (the app keeps it in step with the device),
else the routines' default, `America/New_York`. The control plane returns it
with the texting session (`textsTimeZone`), the texting Worker passes it to
`/agent` as `timeZone`, and a routine run uses its own. A value that is not an
IANA zone is ignored and the default is named instead, never guessed at.

What reversing it costs: Tex asks people what time it is, and works out
"tomorrow" from nothing. `test/agentLocalNow.test.mjs` and the route checks in
`test/agent.test.mjs` fail.

## Every turn knows which workspaces there are, and writes where the project is (2026-10-14)

A tester found Tex writing a shared project's notes into their personal
workspace. A tool call with no `context:` lands in the connection's default,
the personal workspace for a text. Search already reached every workspace, but
nothing told a turn that writes a *new* note that the project's workspace
existed. Now every turn's system prompt lists the workspaces the person can
reach (`contextsFor`, the same list `orient` and `scope_info` give: names,
kind, read-only, default), and says to write a note beside its project's notes
with `context: "@name"`. The default is only for notes about the person alone
or when nothing points elsewhere, and Tex says which workspace it wrote in
(`apps/mcp/src/agent/workspaces.js`). A person in one workspace is told
nothing, and a list longer than 20 points at `scope_info`.

What reversing it costs: project notes pile up in personal workspaces where the
team can't see them. `test/agentWorkspaces.test.mjs` fails.

## Tex keeps its thinking from one step to the next (2026-10-14)

Claude 5.5 models think before they answer unless told not to. Tex's rounds
did think, but each round's thinking was thrown away before the next, so after
every tool call the model started its reasoning over. And `max_tokens` was
2048, which caps the thinking *and* the answer together, so a hard text could
spend the whole round thinking. The owner called thinking "very important"
for multi-step jobs.

Now a round's own blocks (thinking first, then its text and tool calls) are
handed back to the next round unchanged (`providers.js`). The API checks each
thinking block against the system prompt, the tools and the messages it was
made with. When the tool shelf loads a tool, or the turn falls back to
another model, every earlier block is dropped at once, which the API allows;
dropping some would refuse the request (`turn.js`). A round has the models' full 128K output tokens (owner, 2026-10-14).
A setup may say how hard each model thinks: `models.effort` for `main` and
`models.think_effort` for `think` (`low` to `max`, Claude's
`output_config.effort`). Absent, each model's own default applies (medium).

What reversing it costs: Tex reasons from scratch after every tool call, and
hard texts come back empty. `test/agentThinking.test.mjs` fails.

## Tex's jobs are task notes on the project's board (2026-10-14)

The owner decided Tex's plans live in Context where people can see them, never
in a framework's hidden store, and asked for multi-step jobs to become project
tasks Tex assigns itself. Every texted turn that can write is told how a job
becomes a task note:
- the note goes in the projects folder of the workspace the job belongs to,
  beside that project's notes;
- its front matter carries `status: in progress` and `owner: @maya's Tex`,
  using that folder's own status words;
- its body is a checklist of the steps.

A line for each open job goes in `tex/jobs.md` in the person's own workspace,
and that list is read into every texted turn beside `tex/about-me.md`
(`apps/mcp/src/agent/jobs.js`). The next text can then pick a job up from its
first unticked step. A finished job is marked done and leaves the list. The
gateway writes nothing itself: every change is a tool call the model makes,
attributed in history.

What reversing it costs: a job Tex can't finish in one text is lost when the
text ends, and nobody can see what Tex is doing. `test/agentJobs.test.mjs`
fails.
