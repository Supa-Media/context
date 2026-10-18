# Privacy and sharing — the egress gate

_See `docs/decisions/README.md` for the index._

### The widening gate is removed (decided by the owner, 2026-10-17)

"Is approvals still a working feature? No, I need to remove that. … I was
getting paranoid about prompt injection, so I had done approval, but then
everything needed approval" (Dev2, leadership weekly, 2026-10-17; confirmed
in the thread: "yeah go ahead and remove it"). It had been switched off on our
deployment since 2026-10-10, and is now gone from the code, so a self-hosted
gateway no longer holds widenings either.

**What runs at once now, from any AI client.** A share link, a website
publish, an image fetched from an address the model chose, a note or folder
made team-visible, people named on a note, a write or a move into another
workspace. Each is still recorded in the audit trail under the client that
made it, and each can be undone (narrow it, revoke the link, move it back).
The tools' own `confirm_team_publish` still guards a publication, as it did
before 2026-10-09: the model must pass it, and nothing passes it for the
model.

**What still waits for the person, and why it is not this gate.** Each is a
single yes to something nobody can take back, asked for separately:

- an email (`send_email`; [sending-email](../communications/sending-email.md));
- a calendar change (`calendar_event`; [calendar-writes](../communications/calendar-writes.md));
- claiming a workspace's @handle (`create_workspace` without `dry_run`;
  [workspace setup](../gateway-protocol/workspace-setup.md)), held by
  `handleClaimOf` in `apps/mcp/src/tools/session.js`;
- an AI using a vault key for the first time
  ([vault](../texting-assistant/vault.md)).

They keep the machinery the gate built: the pending record under
`.context/approvals/`, the texted YES or NO settled before any model runs
(`agent/textedApprovals.js`), and the app's list at `/approvals`, which the
console's right panel now shows only while something is waiting.

**What is kept from the ledger.** A turn the gateway sees whole still records
whether it took in anything from outside the workspace (`privacy/egress.js`):
Tex vouches for a delegated message only from a clean turn (below), and the
texting thread remembers answers written after an outside read. Which
workspaces a turn read, and at what tier, is no longer recorded: only the
gate weighed it. `mightWiden` stays because Tex's housekeeping refuses
anything it says yes to.

**What the removal costs, said plainly.** The section below names the attack
it stopped: an instruction planted in a page, an email or a meeting title,
written to look like a normal step of the task, can now make a link or a
publish happen without a person in the loop. The owner accepted that risk
for less friction ("prompt injection is something that everybody's just
accepting"). Bringing a gate back means a new decision here, not reverting
this one blindly: the old one held so much that nobody used it. Tests:
`apps/mcp/test/agentEgress.test.mjs` ("a share link from an MCP client comes
back at once", "a handle claim from an MCP client is held") and
`agentEgressTexting.test.mjs` ("a texted share runs at once, even after a page
read").

### Sharing runs when the person's own words ask for it, read by a judge (decided by the owner, 2026-10-18)

"I want people to just be able to type yes or yeah, go do it … you probably
need a sub agent to give the okay … with very, very minimal context, … see
what the user said and what you want to perform and decide whether you can go
ahead" (Dev2, 2026-10-17), then "Yes, ship the judge for sharing approvals and
turn it on in production" (2026-10-18). Approvals stay removed: nobody taps
anything and nothing is held.

`SHARING_JUDGE = "on"` (`apps/mcp/wrangler.toml`, production and staging)
puts a second, small model (the gateway's default Haiku) in front of every
call that would let more people see something, as `privacy/widening.js` names
it: a link, a website publish, an image fetched from an address the model
chose, a visibility change where the manifest reads narrower now, people named
on a note, a move asked to publish. The judge
(`privacy/judge.js`) is shown two things only: the gateway's own one-line
summary of the call, and the person's words, fenced as data it must never
follow. It answers with a boolean. Yes runs the call (writing
`confirm_team_publish` for a publication, since their words were the yes) and
leaves a `judge_allow` audit row; anything else (no, an error, a non-boolean,
no words) is "not done", and the model is told to ask in the chat and call
again. `judgedGate` in `apps/mcp/src/tools/session.js`.

**Where the words come from.** A turn this gateway runs itself (`/agent`: the
texting thread, the app's panel, a routine) has the person's real message,
after the last thing they were told, so a bare "yeah" reads as the answer to
the question it answers; a routine's words are its own note, and a turn of
ours with no person behind it has none. For those turns a model's
`person_said` is never read. An MCP client's chat is never seen here, so every
tool takes `person_said`, the client's report of what the person wrote,
stripped before any tool runs.

**What it costs, said plainly.** That report is the weak point: a model steered
by a planted instruction can also invent the person's words, and the judge
cannot tell a faithful quote from an invented one. It still stops the common
failures (a widening nobody asked for, words about something else, a share
with one person stretched into a public link), and every judged yes is in the
audit trail. One small-model call per widening; none on reads or ordinary
writes.

**Not judged:** an ordinary write into another workspace the caller belongs to
(`elsewhereOnly`), which names no link, no publication and nobody new, and was
the friction approvals were removed for; nor, for now, a move of a note into
another workspace, which takes its own path (`moves/acrossContexts.js`) and
carries the note's visibility with it. Without `SHARING_JUDGE`, or without an
AI gateway to ask, nothing is judged and such calls run at once as before.
Tests: `apps/mcp/test/agentEgressJudge.test.mjs`, sabotage record in its
header.

### History: the gate as it was, 2026-10-09 to 2026-10-17

Kept as the record of what was built and why; none of it holds now except
where the section above says so.

#### An AI client never widens who can see something without a person saying yes (decided by the owner, 2026-10-09)

**Switched off on our deployment for now (decided by the owner, 2026-10-10).**
"It's causing more friction than we need right now, and needs to be properly
configured. I will enable it later when we make orient less reliant on
personal contexts and smarter based on the task." Most holds were ordinary
writes from a personal connection into a shared workspace, which nobody had
to approve before. The gate is kept whole and switched by
`EGRESS_APPROVALS = "off"` in `apps/mcp/wrangler.toml` (production and
staging); unset, as on a self-hosted gateway, it holds exactly as below.
Turning it back on is deleting those two lines. The check
`with the gate switched off, a write into another workspace runs at once`
and `unset, the gate holds it again` in `agentEgress.test.mjs` pin both.

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
`set_folder_visibility` where the manifest reads narrower now; naming people
on a note (`people` on `set_visibility`, 2026-10-17), whoever is named;
`write_note` or `save_context` publishing to the team; a move asked to
publish (`confirm_team_publish`) into a folder more people can read or into
another workspace — without that flag the move tools inside one workspace
carry a note's visibility with it or refuse, which shows it to nobody new;
into another workspace a move is a widening with or without the flag, because
a team note lands team there and "team" there is other people; any write
addressed into another workspace, which is any tool that is not read-only,
derived from the tool definitions rather than listed, so a tool nobody has
classified is held rather than let through. A call is classified by the name
it is dispatched under (`archive_chat` is `save_context`; `create_form` is
unlisted and still a note), and by every way it widens at once: the person who
is asked is told all of them, and the gate supplies `confirm_team_publish`
only when the call asked to publish. Reads, ordinary
writes inside the workspace the call started in, and dry runs never widen
and never ask; nor does `report_problem`, whose one destination is Context's
own support intake rather than an address the model chose. Nor do the
workspace setup tools (`create_workspace`, `apply_layout`, `connect_google`;
Dev2, 2026-10-17), wherever they are addressed: they show nobody anything new
and carry nothing the model chose (`NEVER_WIDENS`; see
[workspace setup](../gateway-protocol/workspace-setup.md)). A real
`create_workspace` is held anyway, for a different reason: it claims a handle
that is never freed, so it is marked `permanent` and waits for the person from
every turn, with the deployment switch off too (Dev2, 2026-10-17; same page).
`apps/mcp/src/privacy/egress.js` is the list.

**When a widening waits for a person.** A turn this gateway sees whole — a
texted question, the app's agent panel — keeps a ledger: which workspaces the
model read, at which visibility, and whether anything came from outside (a
mailbox day, a contact page, a meeting, a saved chat, a web page, a search).
A widening then asks only when the turn read something the new audience
could not already see, or anything untrusted; a turn that read nothing is the
person's own words and runs. A listing (`list_notes`, `scope_info`) is names,
not content, and marks nothing; the three listings that carry words a stranger
chose (`list_meetings`, `list_contacts`, `list_proposals`: an invite's title, a
sender's name, a filing agent's reason) mark the turn untrusted without marking
anything read. The ledger does not end with the turn: the texting thread's
history remembers which answers were written after an outside read, and a turn
that opens with one of them in its history starts untrusted, because the model
reads that history and an answer that repeated a planted instruction is that
instruction one text later. "Seen whole" is a claim about who wrote the question, so only our own clients
make it (the texting thread, the app, a routine): a connected AI client that
drives `/agent` is held like its tool calls are. An MCP client's turn is **not** seen whole:
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
before any model runs, settles only what that thread's latest ask put to the
person: asked within the last half hour (a bare "yes" texted tomorrow must not
run what was asked today), not since moved on from (any text that goes to a
model disarms the asks before it, so a "yes" to the model's next question
cannot release a call raised two texts ago; the app can still answer it), and
never a call another client raised that the person was not told of. An ask
whose turn failed before its line went out is withdrawn. The turn's answer
ends with the ask in the gateway's own words rather than the model's, as one
plain line: the summary is built from arguments the model wrote, so control
characters and bidi overrides are stripped before a person reads it. The app's owner answers at `/approvals`
(`http/approvals.js`), first-party client only, same person only. Both
settlements are audit entries (`approve_action`, `deny_action`). An approval runs the call once through the same dispatcher as the person
who approved, with their own authority (their yes in their own app is at
least the consent a client's grant recorded), recorded in the audit trail
under the client that asked, and keeps the result for an hour so the client
that asked (that client, not another of the same person's) can call again
with the same arguments and be handed it. The
released result is handed back to the identical re-call whether or not that
call still widens: a publish already done no longer widens, so the re-call
would otherwise run again against the state the release left. The gate looks
for the released result on any call that could have been held
(`mightWiden`), and only for a turn it does not see whole.
`confirm_team_publish`, the tools' earlier answer to "did the person
really say so", is now written by the gate when it lets a widening through
and ignored otherwise, because a model passes it as easily as not.

**What the person reads (2026-10-10).** The first benchmark round after the
gate (the texting assistant, four setups) showed the two texted lines the gate
writes: the ask after the model's own words, and the reply to YES. The ask
stays as it is, in the gateway's words with the one-line summary, because a
person can allow only what they were told. The reply to YES is now that
summary and nothing else ("Done: write projects/x.md into @woodshop."): it
had carried the tool's own text, an etag and a visibility line, which is for a
model, and failed every voice line the judge grades. What went wrong still
says what the tool said. The `/agent` answer also carries `asked`, how many
held calls its last line asks about, so a caller that plays the person (the
bench) answers YES the way a person who asked for the change does. Test:
`agentEgressTexting.test.mjs`, "a texted YES runs it without a model, and
says so"; `bench/test/run.test.mjs`, "the played person answers YES when the
gateway held a call for their OK".

**The ask goes out in a text of its own (2026-10-17).** Appended to the
model's answer and left there, the ask line is the model's to lose: the reply
worker keeps three texts and folds every later paragraph into the third
(`apps/agent/src/format.ts`), then sends at most 3,000 characters of each
(`apps/agent/src/clients.ts`), so a long enough answer cuts the ask off its
own end — while the record stays armed for half an hour and a later bare
"yes" releases what was never read. So `textedAsk` hands every ask back as a
`verbatim` part, which the reply worker pulls out of the answer and texts
whole and last, and an ask too long for one text is withdrawn rather than
cut. This had been done for an ask holding an email and not for the rest; the
rest is where the handle claim is, which is the one ask the deployment switch
still makes and the one thing here nobody can undo. Test:
`emailGate.test.mjs`, "an ask holding no email is texted whole too, or
withdrawn rather than cut".

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

**Known limits, found by trying to break it and left as the owner decided.**
An ordinary write inside the workspace never asks, so a model that has read
something private and something hostile can still copy the private text into a
note that is already team-visible, linked, or a website draft; the gate stops
the *publication*, not the copy. The ask names a path, not content, so a note
the model has just filled and named "public-faq.md" is asked about as that name.
A hostile client can fill the context's fifty pending slots with distinct junk
calls and starve a real ask (it fails closed: nothing runs). `report_problem`
and the texting assistant's web search carry model-chosen text to Context's
intake and to a search provider, by earlier decision. A held call's record, with
its arguments, lives in the bucket of the workspace the client connected to,
which for a member of a shared workspace is not their own.

**Not built, deliberately.** MCP elicitation (the client showing the person a
dialog) would let an owner approve without leaving the chat; the transport
here answers plain JSON and would need a server-to-client channel first. A
push or email when an MCP client's call is held is a control-plane job for
later; until then the app's approvals list and a text to the assistant are
the two surfaces. The console's screen for the list is the follow-up PR.

### Naming people on a note (2026-10-17)

An AI client can now add people to one note's list: `people: [{ who, role }]`
on `set_visibility` (the `visibility` action of `manage`), where `who` is a
member's or a group's `@handle` or anyone's email address. It adds and never
removes, owner only, through the control plane's `addGrantees` op
(`lib/nodes/addGrantees.ts`), which resolves every name the way the console's
`setGrantees` does and gives one refusal for any that does not resolve.

With the sharing judge on (2026-10-18, above) it runs when the person's words
ask for it; without it, it runs at once, as since the widening gate was removed
(2026-10-17, above);
until then it was held as a widening at the widest audience, whoever was
named. A domain (`@acme.com`, `*@acme.com`) is refused by the tool, since a
note's list names people, not domains. Tests: `agentEgress.test.mjs` ("naming
people on a note is never held"), `egress.test.mjs` ("mightWiden counts naming
people on a note", so housekeeping never does it).

### A delegated job's message leaves only for the agent's own site, and only from a clean turn (2026-10-17)

`delegate` ([delegation](../texting-assistant/delegation.md)) gives Tex a
message of the model's own words to type into another agent's chat box
(claude.ai, chatgpt.com). The words can carry anything the turn read, so the
browser may type them without open web only under two conditions. First, the
message was written by `delegate` in this call, in a turn whose egress ledger
is still clean: nothing from a page, a search result, an attachment, another
agent's mail or a tainted earlier answer has been read. Second, it is typed on
that agent's own host and nowhere else, with the host re-checked at the keys
(`browse.js` `delegateValue`). `again` rebuilds the message from the task
note, which anyone who can write the note may have edited, so it never
vouches. The note's brief is not the person's words.

The reason: in a clean turn, nothing outside the person and their notes can
have chosen the words or the destination. The site is the person's own
account with an agent they picked, the same trust as a site they named. A
host-wide allowance (another person's GPT on chatgpt.com, say) is accepted
for that reason: no page has been read that could steer the model there.
Under `open_web: yes` (our deployment) typing is unrestricted anyway, by the
owner's decision of 2026-10-14. These conditions are what a self-hosted
gateway without open web keeps.

What a simplification would cost: vouching in any turn lets a page read
earlier in the same text dictate a brief full of the person's notes, which is
then typed onto that site. Vouching `again` lets a collaborator's edit to a
task note do the same. Tests: `agentDelegate.test.mjs` ("a turn that read
something from outside never vouches for the message", "again gives the same
message … writing nothing", "a delegated message is typed only on its agent's
own site").

### An inline reply's quoted message is not the person's words (2026-10-18)

Texting Tex, somebody can reply to one message in the thread, and Sendblue
names the message they picked. Tex reads a bare "this one" better when it
knows which message that is, so the words are fetched
(`apps/agent/src/sendblue.ts`, `repliedToText`) and shown to the model.

They are sent to `/agent` as their own field and never folded into
`question`. Four guards read `question` as the person's own words: the
openable addresses a browser may fetch (`vouched` in `agent/route.js`), the
addresses a texted answer may send a picture from (`outgoingPictures.js`),
the sharing judge's reading of what was asked (`privacy/judge.js`, through
`session.egress.turn`), and the Mail checker's words (`agent/mailChecker.js`).
A texted YES or NO is matched against it too, before any model runs.

The message replied to may be one Tex sent, and a Tex answer carries whatever
Tex read that turn: an email, a note a collaborator writes into, a page. So
folding it in makes a previous answer vouch, which is the laundering
`route.js` already refuses for a routine's last run — an address read on a
page, repeated in an answer, becomes openable the moment somebody replies to
that message. `agent/quoted.js` keeps the two apart: it scrubs the quote of
the characters that would end its mark, and only `runTurn` is handed both,
with the quote marked as vouching for nothing.

What a simplification would cost: one string for both, and a stranger's words
arrive on the person's line wearing the person's authority. Tests:
`agentEgressJudge.test.mjs` ("a texted turn is judged on the person's own
text, never the message they replied to", "the model still reads the quoted
message, marked as quoted and vouching for nothing");
`apps/agent/src/reply.test.ts` ("sends the message a reply answers apart from
the person's own words").
