# An area's routines and its bot's budget are the area's, and Context keeps the clock

*Decided by the owner, 2026-11-25* (boards "Area routines and budgets" and the
clickable prototype, approved with "BUILD").

**Why.** A Grok bot given an area asked whether it should set up its own
routine to check the area on a loop. The owner's answer: "I think routines
should be able to be defined for an area", and "if I attach a grokbot I can
define how much of my weekly usage it can use". Later the same day: bots
talk to each other using mail "and not some other system, like grokbot has
its internal system, because we can have bots from different users and
different agents". A routine kept inside a bot's own app is invisible to
everyone else, dies with that bot, and runs on whatever budget the bot
decides.

**What it is.**

- **A routine is a note in the area.** `<area>/routines/<how often>/<name>.md`,
  in the format Tex's routines use (`packages/shared/src/routines.cjs`): the
  folder says how often (`daily`, `weekly`, `monthly`, `every-2-weeks`…),
  front matter says when (`at:`, `on:`, `timezone:`, `paused:`), the body is
  the job. New York time unless it says otherwise. The routines folder is
  never a sub-area and never one of the area's notes.
- **Context runs it.** The workspace object keeps the list
  (`apps/mcp/src/workspaceStore/areaRoutines.js`), rebuilt after a change
  under the Areas folder and at least every six hours, and wakes on its one
  alarm beside Tex's routines. When one is due it tells the area's bot (its
  bot owner, or a person owner's one delegate; never Tex for now) through the
  control plane, exactly as mail does: a signed call to its webhook of type
  `routine` naming the area and the routine note, never the note's words
  (`apps/convex/functions/botHooks.ts` checks the note is in that area's
  `routines/`). The bot reads the note at its own clearance, does the job, and
  answers in the area's mail. `orient { for }` lists the routines waiting for
  its answer, so a bot that checks its mail on a timer finds them too. A run
  missed while nothing woke the object goes out once; never a backlog.
- **A bot's caps are its person's to say.** A bot's card may give a cap for
  each area it holds: `works_in: [areas/operations/Scorecard · 20%]`. A bot
  works in every area that names it; where no number is written (a bare
  entry, an area off the list, or no list) there is no cap (decided by the
  owner, 2026-11-27: "if theres not a number we should assume no cap",
  replacing the rule that an area off the list was sent nothing;
  `apps/mcp/test/areaRoutines.test.mjs`).
- **The budget is a share of the bot's week.** Context cannot see inside a
  bot, so the bot says what each answer took: `write { action: "mail", …,
  args: { text, used: 12 } }`, kept on the line as `[used 12%]`
  (`packages/shared/src/mail.cjs`). The object adds these up per bot, area
  and week (Monday to Sunday, New York). Once an area's share is spent its
  routines and mail pings are held until Monday: the mail still lands in the
  note, nothing is lost, and the routine's last outcome says "held".
  Saying it is required: in any note in a `mail/` folder (a bot's own mail or
  an area's), an agent's mail line without `used` is refused, so no answer
  goes unlogged, and Agent Mail shows it on every line and this week's total
  in the thread's head (decided by the owner, 2026-11-26: "make sure you log
  how much usage its used and showing it for sure, this is crucial";
  `apps/mcp/test/noteMail.test.mjs`).
- **Bots talk only in Context mail.** Every bot prompt
  (`packages/shared/src/areaBots.cjs`, `mailOnlyText`) and `orient` say so:
  to reach another area or bot, write in that area's mail; never your own
  app's messages, tasks, memory or schedules. `orient { for }` lists the
  other bots this connection can see and the areas they hold.

- **A run needs no research: the routine note brings its brief.** *Decided by
  the owner, 2026-11-26* (the area routines backlog, from a call with Grok
  Bot: every routine push carries the area, its seat, the metric's value now
  and its readings, sub-areas, the area above, projects and the budget left).
  The webhook call still names only the note. When the bot fetches a note in
  an area's `routines/`, the gateway adds a **Run brief** after it
  (`apps/mcp/src/orient/routineBrief.js`): which routine and mode, where to
  answer, then `orient { area }`, which now works the area's metric out
  (`areaMetrics.js`, the app's formula engine over the sheets the reader can
  read; a sheet it can't read makes the value "hidden"), names each
  sub-area's seat and metric value, the area above to escalate to, and where
  heavy lifting goes (`areaContext.js`). Context computes the values because
  a bot can't over MCP, and computes them at the bot's clearance because the
  call's words never are checked.
- **Heavy lifting goes where the person works.** A `heavy_lifting:` line on
  the bot's card, else on its person's card in `people/`, says the tool
  (Claude Code, Codex, anything); with none, the brief says Claude Code if
  they have it, otherwise Codex. No template names a tool.
- **Pulse checks write routines from templates.** `manage area` with
  `pulse: true` writes `routines/daily/improve-metric-loop.md` for every area,
  run every six hours (`at: 12am, 6am, 12pm, 6pm`; Dev, 2026-11-27: "it
  should be at least every 6 hours"), and one routine per mode it has (Visionary's weekly direction check,
  Manager's weekday loop, Doer's weekday ship-the-next-item;
  `packages/shared/src/areaRoutineTemplates.cjs`), each marked `template:`.
  A note already there is never written over; `pulse: false` pauses only
  the template-made ones, and `pulse: true` resumes them. In the area
  panel, pulse checks are a button while the area has no routines and a
  switch above them once it has any, on while a template-made routine runs
  (Dev, 2026-11-27: the button "disappears when there is a routine").
- **Several runs a day are a list of times.** *Decided by the owner,
  2026-11-27*: `at: 9am, 1pm, 5pm` (or `at: [9am, 1pm]`) in a daily, weekly
  or monthly routine runs at each, up to 12; `every-N-hours/` folders keep
  even spacing. A time that can't be read stops the routine with a problem,
  never runs at a guessed time.

**What a simplification would cost.** Letting each bot keep its own routine
loses the record, splits a job across apps nobody else can open, and lets a
bot spend a person's week however it likes. Counting usage anywhere but the
mail line would need a store of our own beside the notes, invisible to
Download as folders. Sending the routine's words in the webhook call would
put note content where its reader's clearance is never checked.

**Tests.** `apps/mcp/test/areaRoutineBrief.test.mjs` (the metric now and
hidden, sub-areas, the area above, heavy lifting, the brief on fetch, pulse,
several times a day), `apps/mcp/test/areaRoutines.test.mjs` (what a routine path is, its
next time, the cards' `works_in`, weeks, sent once, no backlog, answered and
counted once, held when spent and sent again on Monday, not listed, no bot
or Tex, paused, removed, and a reader shown only what it can see; breaking
the hold in `botMail.js` fails two of them),
`apps/mcp/test/noteMailKinds.test.mjs` (the `[used N%]` tag),
`apps/mcp/test/orientArea.test.mjs` (routines, budget and other bots in
orient), `apps/mcp/test/setArea.test.mjs` (`bot.works_in`),
`apps/convex/__tests__/botHooks.test.ts` (the routine call and its limits)
and `apps/mobile/__tests__/areaBotPrompts.test.ts` (the prompts).

**Where bots live.** *Decided by the owner, 2026-11-25* ("top level bots
yes", after asking whether bots should live in the Areas folder at all, since
a bot can hold many areas): a bot is a folder `bots/<bot>/` beside the Areas
folder, its card `about.md` and its mail `mail/<sender>.md`, and the Areas
folder's Bots and Mail tabs are gone. The app draws `bots/` as the list of
bots and `bots/<bot>/` as that bot's page. Cards are read in `bots/` first,
then the Areas folder's old `bots/`, then `people/`, and changed where they
are, so a workspace not yet moved keeps working; a new card goes to the new
home. A bot's own folder is never held by a budget: its mail is to the bot,
not work in an area (`areaRoutines.js` `budget`). Tests:
`apps/mcp/test/setArea.test.mjs`, `apps/mcp/test/orientArea.test.mjs`,
`apps/mobile/__tests__/areasBotsView.test.ts`. Only a bot's person changing
its card is shown in the app, not enforced.

**In the area panel.** *Decided by the owner, 2026-11-27* (Dev approved the
artboards: "please build end to end"): the area panel has a Routines section
after Owner and before Mail (`PanelRoutines.tsx`), and the `routines/` folder
is no longer one of the area's Notes, as `mail/` is not. Rows come from the
notes' front matter, so names and schedules show at once; runs, answers and
the bot's week come from the workspace object's state through
`POST /@slug/files/area-routines`, and where that can't be asked the rows show
without run lines rather than placeholders. The editor writes only what an
agent writing the note would: Repeats is the folder (a change moves the note),
On is `on:`, At is `at:` (a list for several), the switch is `paused:`; Add
writes the note with its name as its heading and opens it, and "Turn on pulse
checks" writes the same templates, kept and resumed the same way, as
`manage area { pulse: true }`. On a phone the same panel is drawn full width in
place of the Areas list. Tests: `apps/mobile/__tests__/areaRoutines.test.ts`,
`apps/mobile/__tests__/areasRoutinesPanel.test.ts`,
`apps/mobile/__tests__/areaRoutineState.test.ts`.

**Proof it arrived, proof it was answered.** *Asked by the owner, 2026-11-27*
("there must be artifacts that the loop was received, and artifacts that work
was done in the place we are expecting it ... this is true for EVERY area").
A census of every area's routines found three ways a gap looked like success,
each now closed in `areaRoutines.js`:

- **Sent is not received.** Each send keeps the webhook's reply
  (`delivered_status`, `delivered_at`); one no webhook took (status 0, or not
  2xx) becomes `failed`, which the app already shows as "Didn't reach". A bot
  that checks its mail itself can still answer it.
- **Only its own bot answers it.** A routine is answered by a line from the
  bot it was sent to, in the area's mail or the routine's own note; the payload
  asks for `<area>/mail/<bot>.md` (`answer_in`), but bots answer as often in
  the note they were already writing in (the 12 PM round that day: Beth and
  Capabilities), and with one routine out per bot, its next line there is the
  answer. Before, any line by the area's holder answered every routine in it.
- **One routine at a time per bot.** A bot woken for four routines at once
  answered one. The next is queued until the bot answers the last, or twenty
  minutes pass, retried every two minutes; Run now is unchanged.

A routine sent and unanswered after an hour is `missed` in the state, and
`orient` names it with where its answer belongs. Tests:
`apps/mcp/test/areaRoutines.test.mjs` (the last three tests; dropping the
one-at-a-time check fails one).

## A bot with no webhook checks in cheaply, every 5 minutes

Decided by the owner, 2026-11-27: "we do want to support [a polling loop], but
design it in a lightweight way where the MCP can just return whether it has
anything new in its inbox or not, that way the loops don't burn a lot of
tokens, and only when it has something new does it give the agent the mail and
give it options to view the mail ... as long as the agent is pinging every 5
minutes it can be in good standing".

- **An inbox per bot, in the workspace object** (`workspaceStore/botInbox.js`,
  `ws_bot_inbox`). Every routine sent to a bot and every mail line told to it
  is kept as one row per bot and note, newest time kept, whether or not a
  webhook took it. The bot's own mail line in that note clears it; a routine is
  also cleared where it is marked answered (its line in any of the area's mail
  notes).
  Rows older than two weeks go, and a bot keeps at most fifty. Note ids, paths,
  areas, senders and times only: never a message's words.
- **The cheap call.** `orient { for: "<bot>", check: true }` records the
  check-in (`ws_bot_checks`, by mail name) and never builds the full holder
  answer. Nothing waiting: `Nothing new. Check again in 5 minutes.` Something
  waiting: `<n> new for <Bot>:`, one line per note (mail: who and when, then
  its path; routine: its name, then its path), then how to read it
  (`fetch { id, args: { mail: true } }` for one, `orient { area }` for its
  whole area, `orient { for }` for everything). Each line names its area. Only notes this connection may read are listed, judged in the
  object as `ws.bots.state` is (`ws.bots.check`). A workspace not on its object
  says check-ins aren't available there yet.
- **The full orient, once a working session.** A bot's first check-in, and
  its first after six hours without one, is answered with the full
  `orient { for }` instead: how Context works and every area it holds (Dev,
  2026-11-27: "the full orient does have important things for the bot to know
  ... so at what point will it call the full orient?"). The object says when
  the bot last checked (`previousAt`); `orient/botCheck.js` `FULL_AFTER_MS`.
- **Good standing.** `ws.bots.state` (and the app's area-routines route) carries
  `checks: [{bot, at}]` and `inbox: [{bot, count}]`; the app shows a polling
  bot as checking when it checked in within ten minutes.
- **Told in the prompt.** A bot set up with reach `mail` is told to make that
  call every 5 minutes on a timer that survives its session, and open only what
  it lists (`packages/shared/src/areaBots.cjs` `mailText`). Webhook bots are
  unchanged.

Anyone who may read a bot's notes can check in under its name; a check-in is a
liveness signal for the app, not an identity. Tests:
`apps/mcp/test/botInbox.test.mjs` (dropping the clear in `botMail.js`, or
putting a message's text into an item, fails a test each).

## Each app has its way of reaching Context, and setup_bot hands its guide

Decided by Dev, 2026-11-27: "there should be a preference per bot, like grokbot
we know has webhooks so thats the most reliable, but for things like muse,
instinct etc it might be a little tough, so we should store skills or guides in
the connect_bot action?"

- **The apps** are one list, `packages/shared/src/botApps.cjs`: Grok (webhook),
  Muse and Instinct (checking in every 5 minutes), each with one line on why. A
  card's `bot:` names its app; `BOT_KINDS` is that list.
- **A card's `reach:` wins; with none, its app's way.** `reachOf(reach, bot)`
  is what the app and `setup_bot` read, so a Grok card with no `reach:` is a
  webhook bot and a Muse card with none checks in. An app not listed checks in.
- **The guide comes back from `setup_bot`.** A webhook bot gets the relay
  routine as before; a check-in bot gets the check-in job (`checkInSteps`): a
  job every 5 minutes whose only call is `orient { for, check: true }`, opening
  only what it lists, and telling its person if its app can't run a schedule.
- **The app** asks which app when a bot is added, writes the app's way on the
  card, and says the app's why beside the Webhook / Checks in choice.

Tests: `apps/mcp/test/botLogins.test.mjs` (a card with no reach is set up its
app's way), `apps/mobile/__tests__/areasBots.test.ts`,
`areasBotsView.test.ts` (adding picks the app), `botSetup.test.ts`.

## Every bot checks in, its mail note is made for it, and an answer is an answer (Dev, 2026-11-27)

Capabilities' routine answers bounced NOT_FOUND because nothing had made
`<area>/mail/capabilities.md`, and a Grok bot's webhook wakes queued until Dev
wrote in its chat, then came at once and were dropped. Dev: "fix these PLEASE",
and "maybe we should setup both webhook and a lightweight check every 5 minutes".

- **A missing mail note is made by its first line.** A mail write or join to
  `<folder>/mail/<name>.md` beside an `about.md` (an area or a bot card) makes
  the note first (`tools/notes/mailNoteMade.js`); `manage area` makes a bot's
  note when it takes an area. Any other missing path stays "not found", so a
  typo never makes a mail folder. This covers bots seated before it too.
- **Webhook bots keep the 5-minute check-in as well.** Their pasted prompt,
  kept memory and `setup_bot` answer all carry it, beside the relay routine:
  a webhook call may not start a turn in the bot's chat; the check-in does.
- **Every bot answers every waiting routine and mail line, oldest first**,
  never only the newest (`routinesText`). The rule lives in the pasted prompt,
  since bots refuse orders in tool replies.
- **A delivered webhook is not an answer.** A webhook bot reads Answering only
  once it answered a routine this week or checked in within 10 minutes;
  otherwise Reachable ("Webhook took the last call … No answer yet.").
- **A bot's own mail line counts as a check-in** (`botInbox.js` `seen`): only
  its bound login writes as it, so its line proves it is reached.

Tests: `noteMail.test.mjs` (first line makes the note), `setArea.test.mjs`,
`botLogins.test.mjs`, `botInbox.test.mjs`, `apps/mobile/__tests__/botHealth.test.ts`,
`areaBotPrompts.test.ts`.
