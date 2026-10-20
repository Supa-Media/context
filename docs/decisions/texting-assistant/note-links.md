# The texting assistant — note links and how Tex asks

Split out of [texting-assistant.md](../texting-assistant.md) on 2026-10-18 when it grew past the review threshold.

### A texted write answers with the note's link, and an ask sounds like a person

Decided by the owner, 2026-10-18, while settling the landing page's sample
conversation. When a text makes Tex write a note, `write_note`'s result on
that turn carries `link: <APP_ORIGIN>/note/@<slug>/<path>`
(`apps/mcp/src/agent/noteLinks.js`), so Tex can text the person where it went,
under the rule that it only states a link it read in a tool result. The link
grants nothing: opening it is a sign-in and the console's own check, and it
unfurls as Context's card, never with the note's name. No https `APP_ORIGIN`,
no known context name or a failed write gives no link rather than a guessed
one.

The ask that ends a held call reads the way a person asks ("'Text YES to
send' seems very robotic"): "Look good? Just say yes and I'll send it." for
an email, a calendar change and a bug report, which still go only on a bare
yes, and "Should I go ahead?" for the rest (`agent/textedApprovals.js`).

### A texted read answers with it too, and an asked-for link is always given

Decided by the owner, 2026-10-20, after Tex summarised an SOP from a shared
workspace and then answered "Give me the link" with "I don't have a web link
for it". `read_note`'s result on a texted turn carries the same `link:` line,
in its header after `path:` and for whichever context the call named, shared
ones included. Every texted turn is told (`NOTE_LINK_LINE`, said whatever the
production setup says) to send that link after an answer taken from one note
when the whole note would help, to send it whenever asked, reading the note
first if need be, and to mint a share link only when they ask for one to send
to someone else. Undo by dropping `read_note` from `withNoteLinks`.

Tests: `apps/mcp/test/agentNoteLinks.test.mjs` (sabotage record in its
header), and the ask lines in `emailGate`, `calendarGate`, `reportGate` and
`agentEgressTexting`.
