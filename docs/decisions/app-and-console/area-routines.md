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
- **Where a bot works is its person's to say.** A bot's card may list the
  areas it may work in, each with a cap: `works_in: [areas/operations/Scorecard · 20%]`.
  A bot works in an area only when the area names it *and* its card lists
  the area. A card with no list works wherever an area names it, uncapped, as
  cards always did. An area off the list is sent nothing, by routine or mail.
- **The budget is a share of the bot's week.** Context cannot see inside a
  bot, so the bot says what each answer took: `write { action: "mail", …,
  args: { text, used: 12 } }`, kept on the line as `[used 12%]`
  (`packages/shared/src/mail.cjs`). The object adds these up per bot, area
  and week (Monday to Sunday, New York). Once an area's share is spent its
  routines and mail pings are held until Monday: the mail still lands in the
  note, nothing is lost, and the routine's last outcome says "held".
- **Bots talk only in Context mail.** Every bot prompt
  (`packages/shared/src/areaBots.cjs`, `mailOnlyText`) and `orient` say so:
  to reach another area or bot, write in that area's mail; never your own
  app's messages, tasks, memory or schedules. `orient { for }` lists the
  other bots this connection can see and the areas they hold.

**What a simplification would cost.** Letting each bot keep its own routine
loses the record, splits a job across apps nobody else can open, and lets a
bot spend a person's week however it likes. Counting usage anywhere but the
mail line would need a store of our own beside the notes, invisible to
Download as folders. Sending the routine's words in the webhook call would
put note content where its reader's clearance is never checked.

**Tests.** `apps/mcp/test/areaRoutines.test.mjs` (what a routine path is, its
next time, the cards' `works_in`, weeks, sent once, no backlog, answered and
counted once, held when spent and sent again on Monday, not listed, no bot
or Tex, paused, removed, and a reader shown only what it can see; breaking
the hold in `botMail.js` fails two of them),
`apps/mcp/test/noteMailKinds.test.mjs` (the `[used N%]` tag),
`apps/mcp/test/orientArea.test.mjs` (routines, budget and other bots in
orient), `apps/mcp/test/setArea.test.mjs` (`bot.works_in`),
`apps/convex/__tests__/botHooks.test.ts` (the routine call and its limits)
and `apps/mobile/__tests__/areaBotPrompts.test.ts` (the prompts).

**Not built yet.** The `areas/bots/<bot>/about.md` folder that replaces
`people/` as the home of bot cards, with only a bot's person able to change
its card, and the app's Bots and Conversations views: the next pull requests.
Readers already look for a card in `bots/` first, then `people/`.
