# Privacy and sharing — the egress gate

_See `docs/decisions/README.md` for the index._

### An AI client never widens who can see something without a person saying yes (decided by the owner, 2026-10-09)

The owner's ask, verbatim in spirit: be able to say "that's just never going
to happen" about private content leaving through an AI client, and know what
it costs in productivity. Prompted by Wajo's Fo trust pitch and Archestra's
OpenAPPA; the research is in the owner's workspace, not here.

**Why the fence was not enough.** The gateway already marks content strangers
wrote (a mailbox day, a web page) and tells the model not to follow
instructions in it. That makes an attack rarer, never impossible: the labs'
own browser-agent numbers put a frontier model's failure rate on a planted
instruction at a few percent per attempt, climbing with retries, and OpenAI's
own position is that prompt injection is "unlikely to ever be fully solved".
An instruction written to look like a normal step of the task ("the client
asked for a public link to the Q3 notes") has nothing in it a fence can
catch. At thousands of turns a day, a defence that fails one time in fifty
leaks daily. The reliable fix is the one every information-flow design lands
on: private data, untrusted content and a way to send something out are safe
in any two and never all three. This removes the third leg for the few calls
that are it, and keeps the fence as the thing that makes asks rare.

**What widens.** A call that lets more people read something than can read
it now, or hands something to an address outside the workspace:
`create_link` and `share` on `write_note`; publishing the website; an
`images[].url` on `write_note` (the gateway fetches an address the model
chose, so a note's text can ride in it); `set_visibility` and
`set_folder_visibility` where the manifest reads narrower now, and
`write_note` or `save_context` publishing to the team; a move asked to
publish (`confirm_team_publish`) into a folder more people can read or into
another workspace — without that flag the move tools carry a note's
visibility with it, land it at the narrower end, or refuse, which shows it to
nobody new; any write addressed into another workspace. Reads, ordinary
writes inside the workspace the call started in, and dry runs never widen
and never ask; nor does `report_problem`, whose one destination is Context's
own support intake rather than an address the model chose. `apps/mcp/src/privacy/egress.js`
is the list.

**When a widening waits for a person.** A turn this gateway sees whole — a
texted question, the app's agent panel — keeps a ledger: which workspaces the
model read, at which visibility, and whether anything came from outside (a
mailbox day, a contact page, a meeting, a saved chat, a web page, a search).
A widening then asks only when the turn read something the new audience
could not already see, or anything untrusted; a turn that read nothing is the
person's own words and runs. A listing (`list_notes`, `scope_info`) is names,
not content, and marks nothing. An MCP client's turn is **not** seen whole:
Claude Desktop reads web pages with its own tools, and a planted instruction
there reaches this gateway as a clean `create_link`, so a widening from an
MCP client always waits, whatever this gateway saw. Absent ledger fails
closed. The decision is `approvalRequired`, pure, and the gate sits in
`callToolForSession` (`apps/mcp/src/tools/session.js`), the one place every
AI client's call passes, after every other refusal and before dispatch.

**Who says yes, and how.** Never the model, and never anything the model can
call. A held call is a record under `.context/approvals/pending/` in the
context the client connected to: the tool, its arguments exactly as sent, a
one-line summary, who asked. The texting assistant's person replies YES or NO
on the thread; `agent/route.js` matches a text that is nothing but that,
before any model runs, settles only what that thread asked and asked within
the last half hour (a bare "yes" texted tomorrow must not run what was asked
today, and never releases a call another client raised that the person was
not told of), and the turn's answer ends with the ask in the gateway's own
words rather than the model's. The app's owner answers at `/approvals`
(`http/approvals.js`), first-party client only, same person only. Both
settlements are audit entries (`approve_action`, `deny_action`). An approval runs the call once through the same dispatcher as the person
who approved, with their own authority (their yes in their own app is at
least the consent a client's grant recorded), recorded in the audit trail
under the client that asked, and keeps the result for an hour so the client
that asked can call again with the same arguments and be handed it. The
released result is handed back to the identical re-call whether or not that
call still widens: a publish already done no longer widens, so the re-call
would otherwise run again against the state the release left. The gate looks
for the released result on any call that could have been held
(`mightWiden`), and only for a turn it does not see whole.
`confirm_team_publish`, the tools' earlier answer to "did the person
really say so", is now written by the gate when it lets a widening through
and ignored otherwise, because a model passes it as easily as not.

**What it costs, measured rather than guessed.** Nothing on reads and
ordinary writes: the gate is one classification per call and touches storage
only for a widening. For the texting assistant, one extra text on a widening
after a private read, and none on a clean turn. For an MCP client, every
widening is one approval in the app or by text; those are rare in ordinary
use, and the product's own claim depends on them never being free.

**What a simplification would cost.** Trusting the fence alone, or the
model's `confirm_team_publish`, puts every mailbox and every page one
sentence away from a public link. Letting an MCP client's clean ledger
count as "the person's words" trusts a conversation this gateway never saw.
Letting any client answer `/approvals` is the model approving itself. Tests
that fail if this is reversed, in `apps/mcp/test/agentEgress.test.mjs`: "an
MCP client's widening is held, whatever it read", "a texted turn that read a
private note is asked before it widens", "an MCP client cannot approve its
own call", "a page read makes the next widening ask", "a text that is more
than yes goes to the model"; and `egress.test.mjs` for the pure half.

**Not built, deliberately.** MCP elicitation (the client showing the person a
dialog) would let an owner approve without leaving the chat; the transport
here answers plain JSON and would need a server-to-client channel first. A
push or email when an MCP client's call is held is a control-plane job for
later; until then the app's approvals list and a text to the assistant are
the two surfaces. The console's screen for the list is the follow-up PR.
