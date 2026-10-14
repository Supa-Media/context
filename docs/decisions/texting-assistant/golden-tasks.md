# Golden tasks and task skills

Part of [the texting assistant](../texting-assistant.md).

## Some jobs Tex must always get right, and they gate a setup (2026-10-11)

Decided by the owner on 2026-10-11, after a texted conversation (archived in
the owner's own workspace) in which Tex could not check whether ChatGPT was set up
("the workspace map timed out"), said it could not get into ChatGPT without a
saved login, sent a vault link instead of signing in, and promised a browser
link that never came: "we need to establish some golden tasks that Tex MUST
do well." Connecting ChatGPT and Claude to Context is "one of the biggest
bottlenecks"; signing in to a site, saving a login, and finding or booking
something on a site are next.

- **They are a test of their own, `bench/ai/tests/tasks.md`**, run with
  `pnpm ai run texting-assistant --test tasks` (the Action's `test` input).
  Every question is `kind: task`, and a task is a gate: one failed must or
  must-not line, one failed check, or one run the model never answered fails
  the setup, whatever else it scores. An average of how often Tex connects
  ChatGPT is not a number anyone should promote on.
- **They are graded on what was done, not only on what was said.** Lines like
  `must reach: chatgpt.com/plugins`, `must type: https://mcp.context.lc/mcp`,
  `must hand off: chatgpt.com` and `must set: connected chatgpt` are checked
  from the run's own record (`bench/checks.mjs`) and never sent to the judge:
  a judge can be talked round by an answer that says "done", and the record
  cannot.
- **They run on a scripted web** (`bench/sites.mjs`, one file per site in
  `bench/ai/sites/`). A run cannot sign in to the real chatgpt.com, and a
  result that depends on what a live site shows today measures the site. The
  stand-in answers on the gateway's own `SITE_SHOTS` binding, so the address
  guard, the typing rule, the handoff link and `browserProviders.js` are the
  production code. The person signs in only through a handoff: the text after
  one comes once they have signed in on that site. ChatGPT's and Claude's
  pages follow the app's own setup guides (`agentSetup/guides.ts`), so a guide
  change and a site file change together.
- **A task says what must happen, never how.** How lives in a skill.

What a "simplification" would cost: averaging tasks into the score lets a
setup that never connects ChatGPT be promoted; judging them from the answer
alone lets one that says it did. Tests: `bench/test/score.test.mjs` ("a golden
task's gate breaks on any failed line but a judge line, and on a run never
answered"), `bench/test/judge.test.mjs` ("a task's checks are graded from the
run's record and never sent"), `bench/test/tasks.test.mjs` (a scripted model
connects ChatGPT end to end and passes every check of task 1).

## A short core set is the default run; the long sets stay for rounds (2026-10-14)

Decided by the owner on 2026-10-14: "we have like sixty questions, we
probably need to reduce it to twenty golden task questions or ten for now and
see if we could do some basic things." `bench/ai/tests/core.md` is fifteen
basics, every one `kind: task` and so a gate: a lookup, two facts, a lookup
across workspaces, a fact the notes don't have, a to-do list, a write to the
note that covers it, a tick-off, a correction, a greeting, "are you a bot", a
web lookup, connecting ChatGPT, saving a login, a one-off reminder and a
weekday routine. Most are copied from `texting-assistant.md` and `tasks.md`
with their wording and lines; the two reminders are new.

- **It is what runs when no test is named**: `pnpm ai run texting-assistant`
  (`testFor` in `bench/run.mjs`) and the Action with `test` left empty. The
  long sets, `texting-assistant.md` (59 questions) and `tasks.md`, are kept
  unchanged and run by name, for a full round before a promotion.
- **A reminder is graded on the note it wrote**, not on the reply:
  `must write: maya/routines/once/ with at: 2026-10-09 9:00 am` passes only
  when the run's record has a note written under that folder whose front
  matter says that date and time, read the way `routines.cjs` reads it, so
  `9am` and `09:00` are the same and tomorrow's date is not today's.

What a "simplification" would cost: running only the long sets makes a round
too slow and dear to run on every prompt change, so the basics stop being
checked; dropping the long sets loses the privacy gates and the voice
questions a promotion needs. Tests: `bench/test/run.test.mjs` ("the texting
assistant runs its core set unless a test is named"), `bench/test/checks.test.mjs`
(a one-off reminder fails on the wrong day, hour, folder or workspace).

## How Tex does a job lives in a skill note, read when it applies (2026-10-11)

A setup names its skills, one line each saying when it applies:

```yaml
skills:
  connect-chatgpt: they want ChatGPT to use Context, or ask whether it does
```

The gateway (`src/agent/skills.js`) offers `read_skill` with those lines in
its description, and reads `ai/production/skills/<name>.md` from the pinned
`@context-lc` workspace only when the model asks, through the caller's own
reach and `privacy.md`, exactly as the setup is read. A name the setup did not
list is refused, so the tool reads nothing but the files named, under the one
folder. A round's skills are `@context-lc ai/setups/<job>/skills/`, pulled
with the setups and placed where production keeps them; promoting a setup
promotes the skills it names with it.

Why not in the prompt: every skill would be paid for on every text, and a
how-to is long. Why not a code path per task: a better how-to should be an
edit to a note, proved by the benchmark, like the prompt is.

Tests: `test/agentSkills.test.mjs`.

## A skill Tex read vouches for its addresses and its marked values (2026-10-11)

The browser opens only an address the person wrote, a search result or a link
on a page it opened, and types only the person's own words, or anything on a
site they named (`browse.js`). So "connect my ChatGPT to Context" could open
nothing and type nothing: neither chatgpt.com/plugins nor Context's MCP
address is in that sentence. A skill read this question now vouches for two
things: its addresses may be opened, and each value it marks in backticks
(`` `https://mcp.context.lc/mcp` ``) may be typed exactly as written
(`webSession`'s `vouch`, called by `read_skill`).

Why this is safe: the guard exists so that a page cannot make Tex send the
person's notes somewhere. A skill is written by staff in `@context-lc`
before any page is read, no page or note can add to it, and its values are
the same for every person, so typing one carries nothing of theirs. Exact
values, never the skill's words one by one: those include its step numbers,
and a page could then have a door code typed out a digit at a time (the first
version did vouch for words, and was narrowed in review before it merged). A
skill never makes a site "named": the anything-goes rule stays the person's
alone. It lasts one question, like the person's words; a skill tells Tex to
read it again when they text back mid-job.

Tests: `test/agentSkills.test.mjs` ("a skill's addresses may be opened and its
backticked values typed once it is read, and nothing more", which also types
"1 2 3" and fails; "a texted turn's read_skill lets the browser open the
skill's address"); sabotaged, `bench/test/tasks.test.mjs` fails too.

## A handoff that made no link says so, in the gateway's words (2026-10-11)

In the same conversation Tex said a browser link was on its way and none came.
Now `browse` describes a handoff only when the browser can be handed over
(`canHandOff`), and when a handoff was asked for and no link was made, the
reply ends with the gateway's own line saying so (`NO_LINK_LINE`), whatever the
model wrote. The prompt lines about signing in (`webPrompt`, `fill_login`)
put the handoff before the vault link: a missing saved login is never a reason
to stop. Tests: `test/agentHandoff.test.mjs`.

## The benchmark searches the real web (2026-10-11)

The world refused every request but the model's, so since search_web joined
the run on 2026-10-09 every search in a result had failed. A run with a
search key now lets Brave's endpoint through; a scripted run answers searches
from its sites instead.
