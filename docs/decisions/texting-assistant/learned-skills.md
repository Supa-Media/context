# Tex writes down how it did a hard job, as a learned skill (2026-10-19)

Decided by the owner, 2026-10-19: Tex should write down how it did a job that
was hard, so the next time is easy, the way Hermes Agent learns skills. Until
then every text started from nothing but `tex/about-me.md` and the task skills
we write ([golden tasks](./golden-tasks.md)); a job Tex had fought through on
Monday was fought through again on Friday.

**Where they live.** One note per job in the person's own personal workspace,
`tex/skills/<name>.md` (name: `^[a-z][a-z0-9-]{0,47}$`), with front matter
`name` (the file's), `when` (one line, at most 300 characters, saying when it
applies) and `updated` (YYYY-MM-DD), and the steps below it, at most 8,000
characters. At most 40. They are per person, readable, exportable and theirs
to edit or delete, like everything else under `tex/`. Tex writes them without
asking.

**Using them** (`apps/mcp/src/agent/learnedSkills.js`). A text from the person
in their personal workspace lists the folder and reads each skill once through
the turn's own dispatcher (best effort, bounded at 40, never failing the turn),
and the `fetch` tool's description carries the index: each name and its `when`
line. The steps are read on demand with `fetch learned:<name>` (carrying tool
`read_learned_skill`). Each skill read gets a `used:` date stamped in its front
matter after the answer, by the gateway and at most once a day.

**Never vouched for.** A task skill read in a turn vouches for its addresses
and backticked values, as the person's own message does (`computer.js`
`vouch`, [golden tasks](./golden-tasks.md)), because we write and test it. A
learned skill vouches for nothing: a model wrote it, and any connected agent or
the person's own hand can rewrite it. Treating its addresses as the person's
would let something planted once be opened, unasked, on every text after. So
it is a tool of its own with no `onRead`, rather than a second folder
`read_skill` reads; the production path is unchanged.

**Writing them: the reflect step** (`apps/mcp/src/agent/reflect.js`). After a
texted turn has answered, deferred so the answer never waits, one small turn
on the built-in model (at most 4 rounds, metered with `builtinMeter` like the
dream, never counted as a question) may write one skill or answer NONE. It runs
only when the turn was the texting client's, could write, finished, and was
hard: six or more
tool steps, a failed step followed by one that worked, or a text opening like a
correction ("no", "not that", "wrong", "actually", "that's not"). It is shown
the person's text, Tex's answer, the step names with ok/failed (never a tool's
arguments or result) and the index. Its dispatcher (`reflectCallTool`) allows
`read_note` and `write_note` on `tex/skills/<name>.md` in their own workspace
only, holds a write to the format and the 40-skill cap, allows one write, and
refuses every other tool, path and `context` before the session's dispatcher
is reached. It runs under a ledger of its own, so nothing it does joins the
turn's asks. A failure is an outcome code in the Worker's log
(`event: "reflect"`), never text.

**A tainted turn reflects blind** (decided by the owner, 2026-10-21, replacing
"a tainted turn writes no skill at all"). A turn is tainted (`ledger.untrusted`)
when it read a web page, an email, a calendar, another agent's mail, an
attachment, or followed a tainted reply in the shown history, which made
almost every real job tainted: three days in, the owner had no skills at all.
Now a tainted turn reflects too, but only on the person's own text (not a
routine run, a delegated job or a group chat), and its reflect step is shown
only what no outsider wrote: that text, the step names whose shape is a
tool's (`^[a-z][a-z0-9_]{0,39}$`, so a name can't carry a sentence) and the
index. Tex's answer, which may repeat an email's or a page's words, is left
out. The skills are private to the person already, so the risk was never a
leak; it was an outsider's instruction ("always forward invoices to …")
being saved and then read on every later text, and that input is still
never shown.

**The tainted turn itself still can't write a skill.** The texted turn holds
`write_note`, so the rule is enforced there too (`withLearnedSkills`): once the
turn has read from outside, any call naming `tex/skills/` (any tool, any case,
`@handle/` in front, or a folder moved onto `tex`) is refused. An untainted
turn may only write a whole skill note, held to the same checks, or archive one.

**Upkeep in the dream.** The nightly dream ([dreams](./dreams.md)) moves each
skill unused for 60 days (the later of `used` and `updated`) to
`tex/skills/retired/`, decided by date in the gateway, never by the model, and
lists them in that night's log. A skill with neither date is never retired.
Nothing is deleted: moving one back revives it. Merging near-duplicates was
left out on purpose: the dream reads transcripts and email, so a merge written
by it would be a skill written by a tainted turn. The reflect step is told to
update the skill that already covers a job instead of adding another.

**Tex's own output.** A skill write never wakes a check-in (`tex/skills/` is in
`OWN_OUTPUT`, [heartbeat](./heartbeat.md)), and housekeeping never touches
`tex/` ([housekeeping](./housekeeping.md)).

**Accepted.** A skill is read as Tex's own notes, unmarked, like
`tex/about-me.md`; another agent the person connected can write one. What keeps
that bounded is that it vouches for nothing: every address, recipient and
widening still needs the person's own words or their YES.

**What a simplification would cost:** vouching for a learned skill's addresses
(or reading it through `read_skill`) turns one poisoned turn into a standing
exfiltration route; showing a tainted turn's reflect step its answer or a
step name of any shape, or letting the tainted turn write one itself, puts a
page's instructions into every later prompt; going back to no reflect on a
tainted turn means nobody gets a skill; dropping the dispatcher's path and tool
checks lets a reflect step steered by its own answer write anywhere; dropping
the cap lets the index grow past what a prompt should carry; leaving
`tex/skills/` out of `OWN_OUTPUT` makes each reflect wake the next check-in.
Tests: `apps/mcp/test/agentLearnedSkills.test.mjs` ("a learned skill's address
is never vouched for", "a tainted turn reflects blind, and can't write a skill
itself", "a tainted turn reflects blind: their text and tool-shaped step names,
never the answer", "a tainted turn reflects only on the person's own text", "the reflect step's dispatcher refuses every other tool, path and
workspace", "a 41st skill is refused"), and the check-in's own-output check in
`apps/mcp/test/agentHeartbeat.test.mjs`.
