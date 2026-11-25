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
- **One delegate per area** (decided by the owner, 2026-11-25: "1 delegate
  per area please", replacing a delegate on the person's card and the area's
  Helper). An area is owned one of two ways: a person owns it and at most one
  bot, Tex or agent acts for them there (`delegate:` in its `about.md`), with
  the person's approval rules; or a bot owns it outright and has no
  delegate. A person is never a delegate ("a human shouldnt be a helper to a
  bot"). The panel's Delegate row offers Nobody, Tex, the bots and the
  agents, never a person; a bot made owner drops the delegate. The old
  `helper:` line is still read as the delegate under a person owner, and
  cleared when the delegate is written; a person card's `delegation:` lines
  are cleared when the card is saved. A delegate bot gets the same setup
  prompt as an owner bot, its areas marked "for" their owner, and
  `orient { for: "<bot>" }` lists the areas it owns and the ones it is the
  delegate of, with whose approval each needs. A bot can work at any size:
  one area, several, or (later) one project. `setArea.test.mjs` fails if a
  person is accepted as delegate or a bot owner keeps one;
  `orientArea.test.mjs` fails if a bot-owned area's old helper reads as a
  delegate.
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
- **Every orient says who holds each area, and to mail the area that owns a
  problem, delegate first** (the owner, 2026-11-25: agents should know "when
  there are connected agents with expertise that can help out with their
  area? like for example reporting a slow CI to the Devops Area", and "always
  reach out to delegate first"; option "Yes, build it"). The connected
  workspace's block lists each area whose about.md names an owner, with its
  delegate and its `mail/` folder, read at the connection's clearance, and
  one line: tell the area in its mail, its delegate is alerted first, and its
  owner only when it has no delegate or for what its approvals name. Mail in
  a person-owned area alerts its delegate bot (`botMail.js` `botOfArea`).
  `orientArea.test.mjs` fails if the list or the rule goes.

- **A bot's webhook is sealed like an app connection** (the owner,
  2026-11-25, option A of two: "ok A"). The bot's Reach is Webhook or
  Checks its mail, on its card. For a webhook, an owner or editor types the
  address and an optional `Name: value` header in the panel; the app makes a
  signing key (`ctxbot_…`, `packages/shared/src/botHooks.cjs`) and shows it
  once to copy into the bot. The control plane seals all three to the
  workspace (`botHooks` table, `functions/botHooks.ts`); nobody reads them
  back, and only whoever set it or an owner replaces it. Only a public https
  address saves and is called (`packages/shared/src/publicAddress.cjs`,
  checked against DNS before each call), with no redirects followed.
- **The workspace notices new mail itself** (the owner, 2026-11-25: "A, plus
  the workspace noticing"). The workspace object that saves a note sees a new
  line in `<area>/mail/` wherever it was written: the app, an AI client's
  `write { action: "mail" }` or by hand (`apps/mcp/src/workspaceStore/botMail.js`).
  It is told once per new line, never for the bot's own reply or an edit
  elsewhere in the note. Then it posts `/gateway/bots/mail` behind the gateway's
  secret alone, as the rows mirror does. That door can only make a bot that
  already has a webhook in that workspace hear "mail arrived" for a path in
  its area's mail, within 120 calls an hour per bot. It reads nothing back.
- **A call says where, never what.** It is a POST signed with
  `x-context-signature: v1=<HMAC-SHA256(key, "<timestamp>.<body>")>`, and its body
  is the workspace, the bot, the area, the note's path and who wrote it. The bot reads
  the message and answers through its own Context connection, at its own
  clearance, so the control plane never carries a note's body. A call is
  retried once when the bot can't be reached or answers 5xx, and audited with
  its status. **Send a test** is the same call from an owner or editor.
- **Everything the panel sets, an agent sets too** (the owner, 2026-11-25:
  "someone should be able to make updates to the areas, the area settings,
  assign metrics, update bot configs easily through tex or through the mcp").
  It is `manage` action `area` (`set_area`, `apps/mcp/src/tools/notes/setArea.js`),
  not a new tool: owner, the area's delegate, modes, approvals, the area's
  one metric, a bot's card, and a bot's webhook. It writes the same
  front matter the panel writes, at the connection's own clearance, with the
  version it read. A metric must be one the workspace has in its data
  folder's `metrics/`, matched ignoring case; a wrong name is refused with the
  names there are. A webhook goes to `/gateway/bots/hook`, which takes both
  proofs (the gateway's secret and the person's own token, cleared as an
  editor). Its answer is the host and the header's last four characters. When
  the agent passes no signing key, Context makes one nobody can see, and the
  answer says how to set a known one.
- **A bot sets itself up from one prompt** (the owner, 2026-11-25: "we
  should just give people a prompt for their grokbot to set it up themselves,
  also we cant assume that they have the mcp setup"). The area panel's "Set
  up <bot>" prompt (`setupPrompt`) has the bot connect Context at the MCP
  address and wait while the person signs in, hand Context its webhook, put
  its logo on its card, and keep the rest in memory. A bot that owns several
  areas gets one prompt covering them all, oriented with `orient for: <bot>`.
  Typing a webhook in the panel is behind "Set the webhook up by hand".
- **The secret goes from the bot's shell, never through a chat.** A bot may
  hold its webhook's secret only in an environment variable. `manage area`
  with `webhook.header_from_shell: "Authorization"` mints a ticket for that
  one bot, address and header name (`/gateway/bots/hook`, action `ticket`;
  `apps/convex/functions/botHookTickets.ts`) and answers with a curl command;
  the bot runs it (`PUT /api/bot-hook`, `apps/mcp/src/http/botHookUpload.js`)
  with the value as the body. The ticket is good once, for ten minutes; only
  its hash is kept; spending it clears the person who minted it again with
  the same token, so a revoked grant or a lost role spends nothing. A value
  whose variable the shell never filled in (`$NAME`) is refused.
- **No signing key with a header.** A webhook with a header already proves
  each call is Context's, so its key is made and sealed but never shown; the
  key is shown once only for a webhook with no header.
- **A bot shows its own logo.** Its card's `avatar:` names a picture stored
  in the workspace; the area list, the Owner row and mail draw it where the
  robot was, read through the card (`readNoteImage`: the card is the gate). The
  bot puts its own there from its setup prompt (`write` with `images`, which
  rewrites `avatar:` like a page's `photo:`); `manage area` takes
  `bot.avatar`; an editor can press "Upload logo" in the Owner row.

**What a simplification would cost.** A bot kept in a table of its own would
be invisible to agents reading notes and to Download as folders. A webhook
secret on the card would put a credential in Markdown. One shared mail note
per area would mix every sender's thread into one log.

**Tests.** `apps/mobile/__tests__/areaBotPrompts.test.ts` (the prompts and
mode meanings), `areasPanel.test.ts` (adding a bot, its prompt, the delegate
dropdown, and that no secret-like key is ever written to a card),
`areasSeat.test.ts` (bot cards), `apps/mcp/test/orientArea.test.mjs` (orient
by area and for a holder, and no oracle for an area the caller cannot see),
`apps/convex/__tests__/botHooks.test.ts` (sealed, signed, no private address,
owner-only replace, the mail door's limits), `apps/mcp/test/botMail.test.mjs`
(told once per new line, never its own reply) and
`apps/mobile/__tests__/areaBotHook.test.ts` (the key shown once, the address
never shown again), `apps/mcp/test/setArea.test.mjs` (`manage area`'s front
matter, the metric match and its refusal, no secret in the answer, the logo,
the one-time command) and the agents' door and shell-ticket tests in
`botHooks.test.ts` (once only, a revoked grant spends nothing), and
`apps/mcp/test/botHookUpload.test.mjs` (the PUT never echoes the value, an
unfilled variable is refused).

**Not built yet.** A bot's answer in the webhook's reply body is not written
back as mail: the bot answers in the note through its own connection.
