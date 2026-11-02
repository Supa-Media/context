# The advisor's asks, the Mail checker's verdicts and jobs go in the chat's ledger (2026-11-02)

_Part of [the texting assistant](../texting-assistant.md); the ledger itself is [chat-ledger](./chat-ledger.md)._

Dev2 approved the "What Tex is working on" page on 2026-11-02, and the same
morning decided that each chat keeps one record, its ledger, from which every
view is rebuilt. The page's Behind the scenes section shows three things a
turn's own steps don't, so the gateway writes them into that ledger as they
happen (`apps/mcp/src/agent/workEntries.js`), never into a store of the
page's own:

- `advisor`: a job's check against its finish line (`jobCheck.js`), marked
  `check`, with the verdict and advice, how many steps it read, and how long.
  An ask the model makes in a turn is not written again: its `ask_advisor`
  tool entry, with its result, already is that ask, and the page reads it
  from there.
- `mail_check`: each email the Mail checker read (`tools/emailGate.js`): to,
  subject, verdict (`stopped` on its no, `waiting` while held, `sent` on a yes
  to an offer) and why. A held email's check is kept under an id made from the
  held approval's; when the person settles it (`settlePending`), a new entry
  says sent or stopped with `ref` naming the first. Nothing is rewritten; the
  page's view (`texStore/pageViews.js`) shows only the latest entry of each
  check, so a settled email no longer counts as waiting.
- `job`: each job a turn started, under the id the texting Worker runs it by
  (the gateway picks it, `background.js`), and the state each check left it in.

**What a simplification would cost:** a page-only table beside the ledger is
a second copy, which the owner has ruled out, and so would an `advisor`
entry beside the `ask_advisor` tool entry; rewriting a check in place loses
when it was held, and a view that ignores `ref` shows a sent email as still
waiting. Tests: `apps/mcp/test/ledgerWorkEntries.test.mjs`
("a texted email's check is read back from the chat's ledger, and its yes
names it", which also reads the page's mail-check view).
