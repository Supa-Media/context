# Tex writes the ask; a held call hands it facts (2026-11-27)

Dev2, 2026-11-26, after Sayo said "send it from my supa email. draft is good. go ahead" in a group and got the
gateway's fixed card asking for a 👍 again: "remember our rule for hardcoded lines. lets come up with a different way
to workaround this", then "i'd like to avoid training conversations where it isnt necessary. it bloats the front door
context", and "sure lets go" to the plan below. This applies
[no-scripted-wording](./no-scripted-wording.md) to every held call.

## What changed

- **A held call answers the model with facts, never a line** (`apps/mcp/src/tools/heldFacts.js`). The email,
  calendar, Google Chat, bug report and forward-rule gates, the sharing judge's hold (`session.js`) and an offer to
  somebody else (`offerFor.js`) return
  `{ held: true, done: false, ok_from, ok_by, what?, because?, from_account_of?, copy?, copy_shown_whole: "required" }`.
  `ok_from` is the group's tagger (`@handle`) or "the person texting". Gone: "Held for their 👍, and nothing failed …",
  "Tell them plainly what you want to do …" and the offer's fixed line.
- **Tex's reply is the ask.** The fixed card (`askLine`: "Here's the email I'd send …", "Give it a 👍 and I'll send
  it.", "I need your OK: … Should I go ahead?") is deleted. `finishTheText.js` sends Tex's words, and
  `textedApprovals.js` `withCopies` adds each held call's copy (its `detail`, else its `summary`) under them only when
  Tex's words do not already hold it whole, so a person can allow only what they read. The text that went is kept on
  the records (`shown_text`, `approvals.js` `armForText`), and a 👍 is the yes only on those words, whole or cut short
  as Messages cuts a quote (`onArmedAsk`). An edit in the app drops `shown_text` (`heldEdit.js`), so the 👍 is then on
  the copy as it now stands.
- **Which text is an ask is a fact, never its wording.** The Worker kept a regular expression of the card's openings
  (`thumbs.ts` `ASK`) to decide which tapback to hold. It now holds one only on the text the gateway handed over as
  the ask (`verbatim`, `askIds`): a phone's chat keeps it with the reply (`rememberAskReply`), a group's with its open
  ask (`OpenAsk.words`), and the app card (`withAskCard`) and the threads line follow it too. The Lab's test chats do
  the same from the Finish step's `asked` count (`packages/lab/gateway/labSandbox/inbound.js`). The machine ask
  (`groupAsk.js`) keeps its own line for now.
- **Behaviour is taught in the prompt modules, not Training**: `tools.md` (a call that answers `held: true` has done
  nothing; the reply is its ask to whoever `ok_from` names, and its copy goes whole under the words), `working.md`
  item 9 and `rules.md` (connected apps), plus the `send_email` tool description. No Training conversation was added.
- **The wording count reaches the gateway's tools** (`scripts/tex-wording-check.mjs` `FOLDERS` adds
  `apps/mcp/src/tools`): the hold lines lived there, out of its sight. `packages/tex/wording.json` now names the
  folders it counted, and a folder a pull request starts counting is not a raise; one already counted still is.

## What a "simplification" would cost

Putting the fixed card back means code writes what Tex says, and it is how Sayo was asked twice: the card showed up
under a go-ahead the checker had already agreed to. Reading which text is an ask from its wording again means every
ask Tex words its own way is a 👍 on nothing. Dropping `withCopies` lets Tex paraphrase an email the person then
approves unseen. Tests: `apps/mcp/test/agentGroupOffer.test.mjs` (the offer's copy whole, whole-handle addressing),
`apps/mcp/test/agentSupersededAsk.test.mjs`, `apps/mcp/test/heldGateStages.test.mjs` (the held facts),
`apps/mcp/test/appChatAnswer.test.mjs` (an edit drops `shown_text`), `apps/mcp/test/appChatCards.test.mjs` (the copy
read out of Tex's words; two copies are no card), `packages/tex/worker/thumbs.test.ts` ("never holds a like on words
that only read like an ask", "holds a like on an ask in Tex's own words"), `apps/mcp/test/labSandboxEvents.test.mjs`,
and the replay cases `checker-no-held` and `send-draft-settles`.

Sabotage record (applied, run, observed failing, reverted):

1. `withCopies` returning Tex's words alone → `send-draft-settles` fails (the email is not put to the person whole)
   and `appChatCards` fails (no copy to read).
2. `onAsk` in `thumbs.ts` returning true for any words → "never holds a like on words that only read like an ask"
   fails.
3. `heldEdit.js` keeping `shown_text` → `appChatAnswer` "Send with an edited body …" fails.

Still fixed lines, named for follow-up: the settle lines after a yes (`doneLine`, the stale-ask drop), the machine
ask, and the regexes `lastOffer` / `lastShownSend` still used for Slack, Chat and the forward rule.

Supersedes the card wording in [thumbs-up](./thumbs-up.md) and
[workspace-setup](../gateway-protocol/workspace-setup.md).
