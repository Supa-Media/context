# Bots hold areas: a Grok bot is an owner you can pick, prompt and talk to

*Decided by the owner, 2026-11-25* (boards "Grok bots as area owners",
approved with "build").

**Why.** The owner runs several prompted bots (Grok bots: Finance, Pipeline,
Architect and others) and wants each to own an area the way a person does:
"I want to be able to support agents that can be prompted. In particular,
different grok bots." A bot told only "you are connected to Context" orients
as a general-purpose assistant; one told which area it holds orients there,
keeps its notes there and knows what its modes ask of it.

**What it is.**

- **A bot is an agent with a card that says so.** It is a name in the
  workspace's `agents:` list, and its card in the Areas folder's `people/`
  says `bot: grok`, `belongs_to:` (whose bot it is, a person's handle) and
  `reach:` (`mail`, it checks its mail; or `webhook`). Grok is the first kind;
  another is one word in `BOT_KINDS` (`packages/shared/src/areaBots.cjs`).
  A card never holds a login, a key or a webhook address: those are kept
  sealed on the server (non-negotiable 1).
- **Picking one.** The area panel's Owner menu lists the workspace's bots in
  their own group, each with whose it is ("@seyi's Grok bot"), and
  "+ Add a Grok bot…", which asks whose bot it is and its name where it is
  drawn, then writes the agents list, the card and the owner line.
- **Its prompt.** A bot holding an area shows "Prompt for <name>" with Copy
  prompt: who it is and whose, the area it owns, `orient { area }` first, its
  notes and goals in the area, projects in the Projects folder with an
  `area:` line naming this area unless they serve another, its mail, and
  what its modes ask.
- **Delegates.** A person's card says who answers for them: nobody, Tex, or
  any of the workspace's bots or agents. A bot delegate shows its own prompt,
  which orients with `orient { for: "@person" }` across every area the
  person holds, each with its modes. A bot can work at any size: one area,
  a person's whole set of seats, or (later) one project.
- **Modes are what the bot reads, never a rule.** The meanings are the
  owner's, after The E-Myth: a Visionary sets course and corrects it and does
  not check up on tasks; a Manager makes sure the work is done at high
  quality (reviews, a loop so nothing is dropped, projects tracked and filed);
  a Doer is the technician doing the work at the highest quality. They are
  said in the prompt and in `orient { area }`, from one place
  (`MODE_MEANINGS`), so the app and the gateway never disagree.
- **`orient` gained `area` and `for`**, not a new tool. An app that froze its
  tool list at connect and drops unknown arguments asks the same with
  `about: "area <path>"` or `about: "for @who"`. Both read at the
  connection's own clearance; an area it cannot see answers exactly as one
  that does not exist.
- **Mail is a folder, one note per sender** (the owner, 2026-11-25: "mail is a
  folder and then per person it's one note, or per, not just per person, per
  AI"): `<area>/mail/<sender>.md`, so a busy area's conversations never pile
  into its `about.md`. The area panel's Mail lists each conversation with
  its newest message, and "Write to <owner>…" starts the reader's own note
  with the first message as note mail; the note's own mail box answers after
  that. A bot joins each note under its name (lowercase, as mail names are)
  and answers in it. The `mail/` folder is never a plain folder or a sub-area
  on the List, the Chart or in `orient`.

**What a simplification would cost.** A bot kept in a table of its own would
be invisible to agents reading notes and to Download as folders. A webhook
secret on the card would put a credential in Markdown. One shared mail note
per area would mix every sender's thread into one log.

**Tests.** `apps/mobile/__tests__/areaBotPrompts.test.ts` (the prompts and
mode meanings), `areasPanel.test.ts` (adding a bot, its prompt, the delegate
dropdown, and that no secret-like key is ever written to a card),
`areasSeat.test.ts` (bot cards), `apps/mcp/test/orientArea.test.mjs` (orient
by area and for a holder, and no oracle for an area the caller cannot see).

**Not built yet.** The webhook (a sealed address and secret, signed calls,
Send a test, replies written back as mail) follows in its own pull request;
until then a bot checks its area's mail on a timer.
