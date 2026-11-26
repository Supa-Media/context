# Four rules for Tex's tools, held in CI and watched in the Lab (2026-11-20)

The owner adopted four rules for every tool a model is shown, and asked for
them in CI and "surfaced and monitored in the Tools tab in the lab":

1. **One fixed tool list.** Never add or remove a tool between turns; a tool
   that can't run right now stays listed and answers with a clear error.
2. **Each tool's description and schema under 4,000 characters.**
3. **State through dedicated tools, never a shell or a plain file write.**
4. **Every error says what to do next.**

An audit that day (Context note `projects/tex/tool-rules-audit.md` in the
team workspace) found Tex's own tools far off: 61 different tool lists across
253 production model calls, `send` alone shown in 47 forms; 1:1 `send` at
about 25,000 characters; four of Tex's state files written as plain notes;
and 29% of tool failures were calls to a tool or action the turn didn't hold.
The Context MCP's own tools passed rules 1 and 2.

**The rules are one module:** `packages/tex/src/toolRules.cjs` (the limit,
how a tool's size is counted, how an error is rated actionable, partial or
not, and which files are Tex's state). The gateway, Convex and the CI check
all read it, so the Lab and CI never disagree on a rating.

**CI is a ratchet** (`apps/mcp/test/toolRules.test.mjs`, baseline
`apps/mcp/test/toolRules/baseline.json`, measured through the replay harness
by `apps/mcp/test/toolRules/report.mjs`): no surface may gain a tool list or
a differing tool, no tool may grow past `max(4000, its baseline)`, no shell
tool or new generic state file, and no source file may gain a
non-actionable error. A fix lowers the baseline with
`node scripts/tool-rules.mjs --write` in the same pull request.

**Production is measured, never estimated.** Every turn logs the tool list its
model was shown (a fingerprint of the list and each tool's name, size and
fingerprint) and which state file a plain write touched when that file has a
dedicated action of its own (check-ins and pings: `send` `setting`; about
them: `remember`). Voice and routines are notes by design, written plainly,
and are not counted (corrected 2026-11-20: the audit had all four as
generic). The Lab's Tools tab
draws the "Tool rules" panel from that, and tex_dev `tool_stats` returns the
same numbers under `rules`. A turn from before this was logged counts for
nothing.

**What it would cost to drop:** without the ratchet, each feature adds a
conditional tool or a long description again, and cache misses and calls to
tools a turn didn't hold come back unseen. `toolRules.test.mjs` fails when any
number grows; `apps/convex/__tests__/texLabToolStats.test.ts` fails when the
report miscounts.

## One fixed list, with each action's guide on demand (2026-11-20)

The owner chose "short lines, manual on demand" to bring `send` under 4,000
characters, keeping the six tools. With `toolList: "fixed"` on the front door
or job step (a Lab setting, `texConfig.json`), every turn of a 1:1 (texts,
check-ins, routines, jobs) and of a group chat is shown the same six, byte
for byte (`sixToolsFixed.js`, `toolCatalogue.js`): every action its kind of
chat can take, one line each. `fetch manual:<action>` returns the action's
args and its carrier's whole description. What a turn may really call is
still its own grants; an action shown but not held is refused with what is
available now and what to do. `test/sixToolsFixed.test.mjs` and the replay
the replay-harness test in it fail when a 1:1's check-in is shown a different list
or a tool goes over the limit. Main keeps `"turn"` until a scored Lab draft
is promoted.

## `send` keeps each action's argument shape, in 8,000 characters (2026-11-20)

The fixed list went live on 2026-11-20 at 14:12 UTC. Within hours, emails in
the owner's 1:1 were refused 15 times:

- `to` was passed as one string, not a list (9 times).
- A "Re:" reply was sent without `in_reply_to` (6 times).

The same task had worked the day before. The cause was the short lines. They
dropped each action's argument shape, which the per-turn list had carried
inline. That shape then lived only in `fetch manual:<action>`, and the model
called without reading it.

The owner's call: send is "a tool of tools". The basic shape of its critical
actions (email, messages, calendar edits) "has to be part and parcel" of it,
and it gets more budget. So:

- **Every send action's line carries its args again.** `familyTool` in
  `sixTools.js` does this, within send's own budget of 8,500 characters
  (`TOOL_CHAR_LIMITS` in `toolRules.cjs`).
- **The email lines name the reply rule.**
- **Every other tool keeps 4,000.** write and manage keep their short lines
  and manuals.
- **The Lab's Tool rules panel reads each tool's own limit.**

`sixToolsFixed.test.mjs` fails when a tool goes over its own limit, or when
send's email line loses its args.

On 2026-11-26 send's budget went from 8,000 to 8,500 characters. Main sat at
7,996, so a new action (`send_sticker`, which the owner chose that day) could
not join without dropping another action's args.

## A failed call brings its action's manual back (2026-11-20)

Asked whether a failed call sends the manual back, so a thing doesn't fail
twice, the owner called it a cheap fix. Until then, a refusal only told the
model to `fetch manual:<action>`. That cost a round, and the model often
retried blind instead.

Now, on the fixed list, a call that fails gets its action's manual added to
the error. This covers a refusal, a thrown error, and a bad argument. The
rules for it:

- **It applies to actions this turn holds** (`manualOnFailure` in
  `sixTools.js`).
- **It is sent once per action per turn.** It is not sent again when the
  model already read that manual.
- **The chat's ledger logs it with the result.** So Replay shows what the
  model read.
- **Some failures get no manual.** An action the turn doesn't hold gets
  none, because its manual would not help; the error names what is
  available instead. A held call, waiting for the person's yes, also gets
  none.

`sixToolsFixed.test.mjs` fails when a refused call in a 1:1 text comes back
without the manual, or when it comes back twice.

## A check-in searches, and is told it only reads (2026-11-20)

In the week before this change, 319 calls asked for an action their turn
didn't hold. They came from check-ins:

- All 50 send refusals ("Yours: say_nothing") were check-ins.
- So were the search refusals, where the check-in wanted the email search
  it did not hold.

A check-in reads only, by design (`heartbeat.js`). It runs with nobody
asking, and it reads strangers' mail.

The owner chose **"give check-ins read-only search"**. A 1:1 check-in now
also holds:

- **`search_email`**, an untrusted read, like `read_email`.
- **`search_web`.** This is a search with no computer: no page is opened
  and nothing is typed (`checkInWeb`). Reading a result marks the look
  untrusted.

Sending, saving, changing and moving stay refused.

The tool list stays the cached one a text is shown. The owner's words:
"we just add a prompt that clearly says, like, you are a check-in … You
can only use read-only tools". So every check-in's question carries
`CHECK_IN_TOOLS`, whatever its setup's words say.

`agentHeartbeat.test.mjs` fails in any of these cases:

- the dispatcher refuses email search;
- the web session offers anything but search;
- a search result leaves the look trusted;
- a setup's own words drop the line.

## Every action's args are held to its own schema before it runs (2026-11-20)

The six tools stay fixed so the prompt cache reads them, so each one's JSON schema says only `action` and `args:
object`. An action's own arguments were text on its line and in its manual, and nothing checked a call against them
until it reached the gateway, and Tex's own actions (`ASSISTANT_SEND_ACTIONS`: browse, open_page, job_status and the
rest) not at all: a key one of them did not take was dropped unseen (Dev2, 2026-11-20: "the way to treat actions better
with the validated schema ... we just need to get this down pat").

Every action already has exactly one schema, its carrier tool's `inputSchema`, and its list line and its manual are
both written from it. `sixTools.js` `checkedAction` now holds every write, manage and send call to that same schema at
one place, before anything runs (`actionArgs.js`, through the gateway's own `validateArguments`): an unknown key, a
missing required one, a wrong type, or a value outside its enum or bounds is refused as `bad_arguments`, naming the
argument and what the action takes, and the manual follows once per turn. The schema is read as closed even where the
carrier leaves it open, beside the call's own `context`, `mailbox` and `person_said`.

One reading is taken rather than refused: a lone string where a list of strings goes (send email's `to`, 7 of 19
failed emails in the week to 2026-11-20), the list's name in the singular (`url` for `urls`), and a number or yes/no
written as text. A string with a comma or semicolon is never split into a guess.

What a simplification would cost: dropping the check sends unknown keys back to being silently ignored and wrong
types back to each tool's own code. `apps/mcp/test/actionArgs.test.mjs` fails, and its census fails when an action on
either fixed list has a schema keyword the check would ignore or requires an argument it does not describe.
