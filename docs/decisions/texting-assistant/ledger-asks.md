# The advisor's asks, the Mail checker's verdicts and jobs go in the chat's ledger (2026-11-02)

_Part of [the texting assistant](../texting-assistant.md); the ledger itself is [chat-ledger](./chat-ledger.md)._

Dev2 approved the "What Tex is working on" page on 2026-11-02, and the same
morning decided that each chat keeps one record, its ledger, from which every
view is rebuilt. The page's Behind the scenes section shows three things a
turn's own steps don't, so the gateway writes them into that ledger as they
happen (`apps/mcp/src/agent/workEntries.js`), never into a store of the
page's own:

- `advisor`: each answered ask of the advisor (`advisor.js` `record`): the
  everyday model's own words just before it asked (the person's text when it
  said none), the answer, how many tool results it read, and how long. A job's
  check against its finish line (`jobCheck.js`) is one too, marked `check`.
- `mail_check`: each email the Mail checker read (`tools/emailGate.js`): to,
  subject, verdict (`stopped` on its no, `waiting` while held, `sent` on a yes
  to an offer) and why. A held email's check is kept under an id made from the
  held approval's; when the person settles it (`settlePending`), a new entry
  says sent or stopped with `ref` naming the first. Nothing is rewritten.
- `job`: each job a turn started, under the id the texting Worker runs it by
  (the gateway picks it, `background.js`), and the state each check left it in.

**What a simplification would cost:** a page-only table beside the ledger is
a second copy, which the owner has ruled out; rewriting a check in place
loses when it was held. Tests: `apps/mcp/test/ledgerWorkEntries.test.mjs`
("a texted email's check is read back from the chat's ledger, and its yes
names it").
