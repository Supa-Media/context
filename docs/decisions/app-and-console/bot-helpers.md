# A bot's helpers are its visible sub-agents, never a bare "Claude"

*Asked for by Dev, 2026-11-27* (thread "Make Grok's Claude helpers visible
sub-agents").

**Why.** Bots (Grok Bot, Pablo, Pipeline and the rest) hand deep work to Claude
Code (`claude -p`) on their own machine. That session had no Context connection,
wrote no notes, could not ask anyone, and nothing showed it was working: "it's
not really writing ... recording its progress". Dev: give it Context and the
mailing channels, a standard brief, always report back to the session that
spawned it, and "it doesn't register directly as Claude, but it registers as
Claude by way of grok".

**What it is.**

- **A helper is started by its bot.** From its bound connection the bot calls
  `manage area { start_helper: { task, name? } }`. Context writes the helper's
  note in the bot's own folder, `bots/<bot>/helpers/<day>-<task>.md` (front
  matter `helper`, `via`, `status`, `progress`, `task`, `started`, `ends`; a
  Progress list; its mail with the bot), and answers with a one-time shell
  command, the command line and the brief.
- **Its connection is its own, and short-lived.** The command spends a ticket
  (ten minutes, once) at `POST /api/bot-helper` and writes the helper's MCP
  config straight to a file only the bot's user can read. The token is minted
  when the ticket is spent and goes only into that file, so it never passes
  through the bot's model or a chat (the `botHookTickets` pattern). Like a Tex
  computer run's grant, the control plane's `botHelpers` row is a pointer to
  the bot's own grant: the same person, workspaces and role, and every live
  check on the parent applies on every request, so revoking the bot's
  connection ends its helpers at once. It ends with `end_helper`, at its
  `ends:` time (8 hours by default, 24 at most), or with the bot's grant. At
  most 8 run per bot grant.
- **It is shown as "<name> via <bot>".** Its session's client name is "Claude
  via Grok Bot", so activity, carets and "agents active" say so (one row per
  helper); its mail lines are signed with its own mail name
  (`claude-via-grok-bot-a3f1`, within mail's 24-character names) and that app line, never as the bot. It can't join
  mail under another name, bind a bot, set a webhook or start a helper of its
  own; its token clears as no owner or editor in the control plane.
- **Its note is mail to its bot.** A line in `bots/<bot>/helpers/*.md` wakes
  that bot exactly as a line in `bots/<bot>/mail/` does (only inside a bot's
  own folder, never an area's `helpers/`).
- **The standard brief** (`packages/shared/src/botHelpers.cjs`
  `helperBrief`), passed as the helper's system prompt: orient for its bot,
  record progress in its note as it goes, ask the area or bot that owns a
  question by mail, check for an answer every 5 minutes for up to 30 after
  asking anything, report to its bot in its note's mail, and end with
  `end_helper { summary }`.
- **The rule lives in the bot's setup.** Every bot's memory (the setup
  prompt's text below the line, and `setup_bot`'s answer) says to start Claude
  Code or any agent only as a helper, because a bot's app treats an order in a
  tool's answer as a prompt injection.

- **The app shows them where the bot is.** The bot's panel has a Helpers
  section under its health: each live helper with its task, status, time and
  last progress line, the ended ones folded into one line. The Bots page row
  says "2 helpers working". Agent Mail and the panel's Mail tab name its lines
  "Claude via Grok Bot" with Claude's mark and the bot's face at its corner.
  A helper whose time ran out without ending reads stopped from its `ends:`.
  All of it is read from the helper's note; there is no store of its own.

**What a simplification would cost.** Letting the helper use the bot's own
connection makes it the bot: its work signs as the bot and nobody can tell the
bot from its helper. Handing the token back in the tool's answer puts a live
credential in the bot's model context and its app's logs. Showing the helper as
its app alone ("Claude") is the black box this replaces.

**Tests.** `apps/mcp/test/botHelpers.test.mjs` (signing, refusals, the claim
route, the session field, the setup prompt) and
`apps/convex/__tests__/botHelpers.test.ts` (start, one-time claim, revocation
with the parent, who may end it, expiry), and
`apps/mobile/__tests__/botHelpersView.test.ts` (the panel, the Bots row, the
name read back from a mail name).
