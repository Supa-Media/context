# The Lab's test chats run the real turn on a copy that changes nothing, over a simulated Photon line (2026-11-16)

Dev2, 2026-11-16: "I need the ability to test new architecture changes and send test texts to the new architecture
without having to put it in prod ... I should be able to use maya, or my users existing 1:1 or group chats, and send
test messages to see how the new architecture responds, I should be able to write as anyone in the group, delete some
test messages and retry, and also have all the changes in the workspace / group chat object be sandboxed so it doesn't
actually affect production"; then "go ahead and build everything" (piece 3 of the Lab runs plan).

**One route, the caller's own grant: `POST /tex-lab/sandbox` `{ op, ... }`** (`apps/mcp/src/labSandbox/route.js`), and
`tex_dev`'s `sandbox` action, which calls the same route in-process with the connection's own grant, so the Lab and
an AI do the same things (the Lab-parity rule). Ops: `chats`, `sets`, `open`, `send`, `react`, `edit`, `retry`, `back`,
`drop`, `reset`, `get`.
The control plane decides who may, on every call (`apps/convex/functions/texLabSandbox.ts`, `/gateway/tex/lab-sandbox`,
reads only): a staff member who owns or edits the pinned context, on the Lab's own client (`context_console`) or an
AI client of their own, never one of Tex's texting clients. It also hands back the session a real texted turn in the
chosen chat would run on, read from that chat's live grant **without its token**: the person's own 1:1, or a group
chat whose home names them (`homeUsers`). A chat they are not in answers exactly as one that does not exist.

**Tenancy: one Durable Object per person's test chat, `labsandbox:<userId>:<sandboxId>`** (`LabSandbox`,
`labSandbox/object.js`). The route names it from the caller's own user id as the control plane answered it, so
another person's `sandboxId` reaches a different, empty object: "no such test chat". It keeps the rows the Lab shows
(the real texts it started from, `prod: true`, and every test text and reply), the list of what each test text's turn
would have changed or sent (`writes`, each `by` that text), the copy-on-write overlay, and the test chat's own ledger
(the real ledger's code, `texStore/ledger.js`), seeded at open with the real chat's ledger up to `base` (that text left
out, for Replay's "Try from here"): every kind a turn reads (texts, replies, notes, tool calls, days), never the steps'
logs. Tex's history is rebuilt from the texts with their replies; a copy of the texts alone rebuilt none, and test
turns ran with no history (found in production, 2026-11-16; `labSandbox.test.mjs` "opens on the whole real chat"). Reset deletes all of it; an alarm deletes it 24 hours after its last use. Nothing
in it is anybody's but a copy of what the caller could already read.

**A test text arrives as a real text arrives** (Dev2, 2026-11-16: "expected it to go through the "A text arrives"
node end to end, but it looks like it skipped straight to front door"). `send` hands the text to the texting Worker's
own chat object (`apps/agent/src/chatObject.ts` `SenderInbox`, the class the gateway's TexChat runs), at `/accept` for
a 1:1 and `/group-accept` for a group (`labSandbox/chatRun.js`). Its route logs node `text`, asks Old number?
(`oldLine`), queues it, and its alarm runs Triage, Decide and the queue (`lanes`) before it asks `/agent` (the same
`texEntryPoint` and config graph, with the draft's wiring: each step's on/off and its wires when every wire names a
step this build has, `graph/turnGraph.js` `withDraft`) and sends what comes back. None of that path is copied or
skipped; only what the object reaches outside itself is the Lab's, handed in as its `env`: its storage is in memory,
kept in the test chat's object between texts (dropped when a cut takes the text it was kept after); the gateway it
calls is this gateway's own handlers on the test chat's session and sandboxed env, reached with a token minted for
that one text and known only there; the control plane is answered from what the control plane told the Lab about the
chat (a group's people, slug, engagement, instructions and updates, and the old-number setting, read without minting),
with a decide gate always open and every change refused and listed; its line keeps what Tex sent as the reply row and
texts nobody; it never gets the Worker's secret or a real token. The people are addressed by made-up 555-01xx numbers,
Tex's line by its Photon number, and the chat by a `lab:<sandboxId>` chat id; a group's real key and members, which its
ledger and home are found by, are put back on the turn's body at the `/agent` hop. A group's object starts set up for
its people, as the real chat's is once Tex answered there. A Lab test text's arrival names its provider `photon` (it
was `lab` until the line below). A tapback, an edit and an unsend go in the same way, as
Tex's line hands each over (`photonEvents.ts`): a tapback to `/react` in a 1:1 or to `/group-accept` as a group message
carrying `reaction` (on Tex's text with its words and `onTex`, else `onOther`), an edit or an unsend to `/edit`, whose
`edit` step asks node `edit` over `/texts/edit` on the draft (found in production, 2026-11-16: they had run the turn
alone, and the route had decided a tapback's "noted" and run node `edit` itself). The Lab polls `get` with `after` the last real
row, so a long chat is sent once; `running` names the step that last finished, and the running text's row carries
each step as it finishes: the chat object's own steps as it posts them to the ledger, then the turn's nodes as each
reports (`onNode`), never estimated.
"Write as anyone": in a group, `as` is a person's handle (sent as `group.from`) or any other name, sent as a guest who
tagged Tex. Retry drops that text and everything after it and sends it again; Back keeps it and its reply and drops
the rest; Drop removes it and everything after it. Each cut takes the texts' writes, overlay changes and ledger
entries with it, and the ledger is rebuilt from what is left. A real text is never cut: open again with `base`.

**The contract** (`labSandbox/route.js` header, `tex_dev`'s guide):

- `chats` → `{ chats: [{ chatId, name, kind: "1:1" | "group", people }] }`; `sets` → `{ sets: [{ id, title, set,
  kind, people, texts }] }`, the Training and Dev conversations (the control plane's `sets`, `texSets.ts`
  `listDrafts`, laid over the repo's copy; never the Test Set). The Lab's picker tabs: Your account (`chats`), Test
  account (`chats` on that account's grant), Training / Dev (`sets`, opened with `source: "set"`, or `"maya"`).
- `send { sandboxId, as?, text, pics?, replyTo? }` → `{ msgId }`. `pics` is up to 6 `{ url, type?, name? }`, checked as
  a Testing-set message's are (`texSetOps.cjs` `checkPics`: https, picture types) and each a plain https name
  (`remoteImage.cjs` `fetchableImageUrl`: no address, port or userinfo); `text` may be empty with pictures. `replyTo`
  is any row of this test chat with words, real or test.
- `react { sandboxId, msgId, emoji, as? }` → `{ msgId }`, `emoji` one of ❤️ 👍 👎 😂 ‼️ ❓ on any row with words
  (Tex's included, never a tapback or a quiet reply).
- `edit { sandboxId, msgId, text, as? }` → `{ msgId }` and `unsend { sandboxId, msgId, as? }` (the Lab's Delete,
  iMessage's Undo Send): only one of the test texts (never a real one, Tex's, a tapback, an edit or unsend row, or a
  text already taken back), in a group only as its sender. The row (`kind: "edit"` with the new words and `edited:
  true`, or `kind: "unsend"`) is the person's change; the chat object takes it as a Photon edit or unsend
  ([edits-and-unsends](./edits-and-unsends.md)): `same` keeps nothing, `turn` queues the new words as a text, `withdraw`
  takes a waiting text back. Its `edit` step is on the row, and a quiet reply row says what the object did. Retry sends
  an edit or unsend again as itself. tex_dev's `sandbox` has both ops.
- `get` rows carry `pics`, `replyTo`, `reactions: [{ who, emoji }]` on a tapped row, and each tapback's own row
  (`kind: "reaction"`, `emoji`, `on`, its line as `text`). Retry sends a text again with its pictures and reply, and a
  tapback again as itself. The daily cap counts every text, tapback, edit and unsend.

**Each event reaches the turn as production hands it to `/agent`**, built by the texting Worker's own code
(`apps/agent/src/gatewayInbound.js`, which the bundler follows into its TypeScript, as `gatewayChat.js` is;
`labSandbox/inbound.js`):

- *Pictures.* The event's kind is `kindOf`'s (`picture`); at answer time the files are made into `attachments` by
  `prepareAttachments` (the bytes decide the type; a HEIC or oversize picture becomes a JPEG through `IMAGES`; one that
  cannot be opened is said in words). A group turn takes the chat's last four since Tex last spoke (`filesFor`), and an
  empty line reads `(sent a picture or file)`. The download is the only fetch a test turn makes outside the four fences
  below, as the Worker's is: a GET with no credentials, to a named https host, every redirect checked again.
- *A quoted reply.* The event carries `replyTo` (the replied-to event id) and `quoted` (its words), as `replyQuote.ts`
  `replyFields` writes them. The turn gets `quoted` in a 1:1 (cut to Sendblue's 3,000), and in a group Tex's own words
  only, else `replied: true` (`groupModelTurn.ts`, `readOwnMessage`).
- *A tapback.* Logged as its line, "❤️ (yes) on Tex's message …" (`reactions.ts` `reactionLine`). In a 1:1
  (`inbox.ts` `react`) one that answers something (`answers`, or a 👍/❤️/👎 on an ask, `thumbs.ts` `holdsAsAnswer`)
  runs the turn with its emoji as the question, the words it was on as `quoted` and its name as `tapback`; any other is
  only noted and runs no turn (its reply row quiet, saying `noted`), and the next text carries it as `reacted`. In a
  group (`groupInbox.ts` `acceptReaction`) the asker's 👍/❤️/👎 on Tex's ask (anyone's on a lent computer's ask) goes as
  the tapback, and any other reads on as its line.

**Egress is stubbed in four fences, each deny by default** (`labSandbox/policy.js`, `labSandbox/wire.js`):

1. *The env.* A test turn's env is the real one's plain settings, the model's bindings (`AI`, `IMAGES`), analytics
   datasets that keep nothing, and the two object namespaces wrapped. The texting Worker, site shots, Tex's jobs and
   chat objects, live rooms, tickets, the eval service and the sandboxes themselves are left out, so no code path can
   reach one, and `AGENT_WORKER_SECRET`/`TRANSCRIBE_WORKER_*` are withheld.
2. *The objects.* Every call to a workspace or Tex object passes `sandboxedStub`, decided by its op name: a read goes
   to the real object (a key the test chat changed is answered from the overlay; the test chat's own ledger from its
   object); a put or delete lands in the overlay; an alarm, a lock or a page push answers as done and never arms;
   every other op, a `ws.*` write or anything unknown, is refused with the object's own refusal (422). The store caching its
   (blanked) storage binding is answered as done, never kept; a turn's own run markers (`state/agent/running|cancel/`)
   stay in the overlay but are not listed as changes. Objects are
   reached by name only (`idFromString` and `newUniqueId` throw).
3. *The control plane.* The one `post` every control-plane method uses checks `controlPlaneAnswer`: a listed read
   (`CONTROL_PLANE_READS`, or a route that reads by its body) is sent; the turn's bookkeeping (usage, turn log,
   signals, the daily cap's verdict) is answered as done; everything else, an email, a calendar change, a share, a
   job, is refused and listed. The storage binding comes back with every secret field blanked, and `ws.open`'s kept
   binding is dropped, so a bucket could refuse every request even if one were reached.
4. *The tools.* Where Tex's model calls a tool (`agent/turn.js`) and where every MCP tool call passes
   (`tools/session.js`), `toolAnswer` decides: a read in `READ_TOOLS` runs for real (a note the test chat wrote is
   read from it), a job tool runs (`RUN_IN_SANDBOX`, above), a write the test chat does itself is done there
   (`sandboxTools.js`), a browser or computer is refused, and any other tool gets a stub answer ("Done. ... nothing was
   changed or sent") and is listed, so the turn carries on as it would have. `vault_list` and `report_problem` are not
   reads here. `toolAnswer` is async now; `turn.js` awaits it.

**The test chat acts like an actual chat** (Dev2, 2026-11-16: "the sandbox should act like an actual chat... by default
wire/pretend it's a Photon iMessage thing so it should simulate default latency on that and text should arrive on the
new number (+1 415 791-8922). It actually does the research things and sends messages and subagent responses to the
sandbox chat. All the read only tools should still work, and all the write tools should work but in a sandbox that is
discarded, so new notes etc, simulated email sends, we should be generating pages that are working but just are short
lived and disappear with the sandbox"; contract `lab-live-sandbox/contract.md`).

- *The line* (`labSandbox/line.js`). Every test text goes over Photon to Tex's new number, +1 415 791-8922 (a public
  business line, kept in code; no secret). It is held for the line's delay in, counted from when it was sent, before it
  reaches the chat object, and each text Tex hands the line is held for the delay out before it shows as delivered. The
  delays are the p50 of real Photon deliveries: the texting Worker logs the provider's lag on every text (`text` step)
  and send (`send` step, delivered) since #3318, but nothing aggregates them across chats, so a test chat measures its
  own chat: at open it reads the real chat's newest 2,000 logged steps (read only) and takes each way's median of
  Photon's lags. A way with fewer than five logged gets a fixed default, **1.5 s in and 2 s out, which is not a
  measurement** (`PHOTON_DEFAULT`; the `line` says how many samples each way used, `measured`); no hold is over 30 s.
  Training and Dev conversations get the default. The holds are steps of their own, `lineIn` and `lineOut`, `kind:
  "line"`: the simulated line is the sandbox's transport, not Tex, so they are no nodes of `texConfig.json`, and
  `scripts/tex-diagram-check.mjs` (check 6) fails CI if the sandbox records a step that is neither a node nor that
  transport, if a transport name becomes a node, or if the code's list (`steps.js` `TRANSPORT_STEPS`) drifts from the
  check's (`LAB_TRANSPORT`). Rows carry `line: { name, inMs, outMs? }`, and `get` the line every new text uses.
- *Background jobs run* (`labSandbox/jobs.js`). The job tools (`start_background_job`, `steer_background_job`,
  `restart_background_job`, `plan_big_ask`, and `text_progress`) run for real (`policy.js` `RUN_IN_SANDBOX`). The chat
  object spawns the job's object as it does in production, here the Worker's `SenderInbox` on storage in memory, held
  by a namespace (`sandboxInboxes`) that holds this text's chat object and its jobs and nothing else. Each pass runs
  through the config graph's job node exactly as `texJob.js` runs it (`gatewayGraph().runNode("job", ...)`, via
  `TexJob`), so Job check, the Hand-back judge and the Advisor on job mail are reached over the job node's wires; the
  job's own turn is `/agent` on the same fences, and its report goes to the chat object, whose turn and line text the
  result: a Tex row `from: "job"` the moment its line delivers it. What differs is only who drives the passes: the
  sandbox, one after another, not the Worker's workflow. Limits: 15 minutes and 14 passes a job, 6 jobs a text (one more
  is refused as a step); a job for one of the person's computers is never run (its refusal is a `job` step with `ok:
  false`, listed, and the job ends through `/job-failed`, so the chat hears it failed as it would); a tool that needs a
  browser or a computer (`browse`, `fill_login`, `fill_card`, `delegate`, the computer tools) is refused in words the
  turn reads as a refusal and listed (`MACHINE_REFUSAL`).
- *Writes happen in the test chat* (`labSandbox/sandboxTools.js`, `object.js` `sb_notes`, `sb_assets`). `write_note`
  writes the note whole into the test chat; a later turn's `read_note`, `read_notes` or `fetch` of it reads it there,
  and its `list_notes`, `search_notes` and `search` name it after the real answer (`afterRead`, in
  `tools/session.js`). `remember` adds its line to a note the test chat wrote, or, on a real note, keeps the line and
  shows it below the real note when it is read. `send_email` and `save_email_draft` send nothing: the write keeps who
  to, cc, subject and the whole body (`sent: false`). A `.page.md` is a page served from the test chat
  (`labSandbox/pages.js`, `GET /tex-lab/sandbox/page/<sandboxId>/<id>` and the route's `page` op), read at the moment it
  is asked so a later edit shows; a picture Tex sends (its line's `uploadPicture`) is kept and served the same way, PNG,
  JPEG, GIF or WebP only. Every write is in `writes` with its `id`, `kind` (lowercase now: `note`, `page`, `email`,
  `draft`, `picture`, `reminder`, `refused`, ...), `title`, and its `body`, `url`, `to`/`subject` or `expires`; the
  old `summary` stays. Drop, Back and Retry take a text's notes, pages and pictures with it; Reset and the 24-hour alarm
  delete them all, and the address answers 404.
- *Who may open a page: the test chat's owner only* (chosen as the safer of the two, as asked). The address needs the
  caller's own grant, and names the object from the caller's user id as the control plane answers it, so anyone else,
  another Tex developer holding the link included, reaches a different, empty object and gets the 404 an address that
  never existed gets. An unguessable link alone would have worked in any browser tab, but a page is made from the
  person's own notes, and a link that leaked would show them to whoever had it; the 128-bit id is kept as a second
  lock, never the first. What is served can run nothing on the gateway's origin: Markdown as text, or (`?as=html`) a page
  with every character escaped, under a CSP that allows no script and sandboxes the document, `no-store`, `noindex`.
- *Every step, as it runs* (`labSandbox/steps.js`, the gate in `harness.js`). Each step has an `id` (`<row id>.<n>`),
  `at` (ms from when the text was sent, the line's hold included), `parent`, whole `in` and `out` (up to 16,000
  characters of JSON each, cut further only when a row's steps would not fit its 2 MB), `calls` (each tool call the
  turn logged, on the model step running when it was logged: `kind: "read"` ran for real, `"write"` landed in the test
  chat), `model` and `effort` (the draft's config for that node), `tokIn`/`tokOut` (the usage the turn reported, on
  the model step running then, else the last one), `bg` (a background wire's run, a job handle's, a job's pass), and
  `think` where a tool call carried thinking. A running step is in `get` at once, with no `ms`; the running row is
  posted on every change, one post at a time. Parents are recorded as things run, never inferred from times: the
  graph runner (`packages/shared/src/texGraph.cjs`) now gives every run an `id` and the `parent` run that started it
  (the caller of a `uses`, `loop` or `job` handle, or the node whose fired wire fed it) on its log entry, and tells
  `onStart` as each run starts; the ledger's node entries are unchanged. A graph's first run hangs under the chat
  object's last step before it asked `/agent` (or, in a job, under the job's pass); the chat object's steps chain in the
  order it logged them from `lineIn`; a `lineOut` hangs under the step the text came from (the line hands it on before the `send` node logs, so that `send` is its sibling). A Tex row's `cause` is the
  chain from its `lineOut` back to `lineIn` with every helper a step on it called (`uses` and `loop` runs, and theirs);
  the turn's reply row is `from: "fd"` and keeps the whole text's steps, a job's row `from: "job"` the steps of its
  cause. A text is "running" until its jobs end, so a new test text waits for them (409), where a person can text
  while a real job runs.
- *One text at a time, and Reset ends it* (an adversarial review, 2026-11-16). The running mark is claimed in the test
  chat's object in one step (`object.js` `claim`) before the text's row is added, so two sends at once start one turn
  and the other gets 409; reads before it only refuse early. The mark is the text's own: its turn refreshes it with
  every step (`beat`) and a job at least once a minute while it waits (`jobs.js` `beatingSleep`), so a 15-minute job is
  never taken for a turn that died (`RUNNING_STALE_MS`, 6 minutes); only a mark left that long is taken over, and only
  its own text frees it (`release`). A test chat that is gone, by Reset or never opened, answers only `init`, `state`
  and its person's index: a turn running through Reset is refused at its next write, writes nothing and arms nothing,
  and the gate says it is `cancelled`, so its jobs stop before their next pass. An address nobody opened is asked with
  `exists`, which makes no table and arms no alarm. A row's `prod` is its own column, so a row's steps cannot hide it
  from the cap; a test chat made before the column gets it from each row's own top level once.

**Sources.** `chat` (`chatId` `me` or a group's key), `set` (a Training or Dev conversation, the Lab's draft over the
repo's copy; the Test Set is refused, it is people only), and `maya` (the bench's Maya, her Dev conversation). A
conversation's messages seed the test chat's ledger as today's texts; a 1:1 one runs on the caller's own 1:1 session
(their own notes read), a group one in a group chat of theirs named with `chatId`, whose Tex notes are read. Each
person gets 200 test texts a day across their test chats: every one runs the real models.

**The draft runs whole.** A test turn's env carries its gate, and `texConfig.js` `texConfigOf(env)` lays the draft over
main's config: each step's on/off, model, effort, time limit and context, its wires, and its prompt modules' words
(`p-<name>`). The setup read (`production.js`), every judge that asks the AI gateway (through `aiGatewayConfig(env).tex`)
and the egress judge read that config, so a draft's change to them runs in the test chat; a real turn's env has no gate
and reads main's. What Promote would refuse (a model main's table has no gateway id for, a module with no words) runs
as main's. Steps whose models are fixed in code, not read from the config (decide and the router on clef, the picture
maker, nudge, reflect), do not change with a draft, in a test chat or live.

**Known gaps, said rather than hidden.** Only `write_note` and `remember` write notes in the test chat; moving,
archiving, deleting and the website's actions are still recorded and answered as done, and a note the test chat wrote
is found by a listing or a search only by its path and words, after the real answer, never ranked among it. An email is
kept as sent at once: the yes that production's egress gate waits for before an email goes is not asked in a test
chat. `create_link` is recorded and answered as done; a page's own address is the write's `url`. Jobs live only for
their text's run: a job cut off by the limits is not carried to the next text, which finds no such job.
`ws.rows.files` and `ws.rows.listing`
answer "not served here", which callers already read as "ask the other way". A group turn's control-plane calls carry
the caller's own grant, as a 1:1 turn's do; a route that reads by the chat's own grant answers for the caller's.
The texting Worker's judge (decide) is not asked before a test turn, for a text or a tapback: every test row that
production would queue runs its turn, so a tapback the judge would have left unanswered still gets one (Tex may stay
quiet). A group's chat lines are the rows since Tex last spoke, as the Worker keeps them until a turn takes them. Tex's
reply is one row, where production may send several texts, so a 👍 on "the line above the ask" is a 👍 on the whole
reply (`thumbs.ts` `onTheAsk`). A picture over 5 MB is not read (`remoteImage.cjs`'s ceiling, enforced on the bytes as
they arrive, since the download runs in the shared gateway), where the Worker would download up to 25 MB and convert
it, and the turn is told it was over 5 MB rather than that the download failed; an address that turns out to be audio
or a document is not read either.

Every turn reads the draft as saved at that moment, not as it was when the test chat opened, so an edit saved in the
Lab is what the next text, or a retry, runs; the Lab's ▶ calls a text stale exactly when the draft as the server
confirmed it has changed since it ran, leaving out where steps are drawn (a save of the page's own edit included). A
retry cuts its old text only after everything that could refuse it (the daily cap, the chat, the draft) has passed, and
only if no other text started running while those checks were out, so a refused retry loses nothing.

**Tests** (`apps/mcp/test/labSandboxLive.test.mjs`, sabotaged 2026-11-16, each edit reverted): the line's p50 and
default (`median` returning the mean, on samples with a slow outlier, fails "the line is Photon ..."); the runner's ids and parents (`texGraph.cjs`
passing no parent on a `uses` handle fails "the runner names ..."); a Tex row's cause is its chain, helpers in,
background out (`steps.js` `causeOf` taking every child, not only helpers, fails "a Tex text's cause ..."); a running
step has no `ms` (`steps.js` `begin` setting `ms: 0` fails "a running step ..."); a note is read back by the next turn and
nothing leaves (`policy.js` `toolAnswer` skipping `sandboxWrite`, so the write is only stubbed, fails "a note written
..."); an email is kept and not sent; a page opens for its owner only and is gone after Reset (`pages.js`
naming the owner's object whoever calls, as a link that carried its owner would, fails "a page is served ..."); Drop takes a text's notes and pages;
one tenant's test chat never reads another's notes; a job runs through the job node and its text is a row `from:
"job"` whose cause runs `lineIn` → job → `lineOut` (`jobs.js` driving `/job-pass` without the job node fails "a job the
turn starts ..."); a computer's job is refused as a step; `get` names the line and each write's id. `scripts/tex-diagram-
check.mjs --self-test` covers check 6. The review's fixes, each sabotaged and reverted: a claim always granted fails "two
texts sent at once ..." and "a test chat's running mark ..."; sleeping a job's wait in one piece fails "a job that waits
longer ..."; dropping the gone refusal, or the jobs' `cancelled` checks, fails "Reset stops a running turn ..."; reading
state without `exists` first (route or page) fails "asking for a test chat nobody opened ..."; counting rows by the JSON
pattern fails "a test row is counted ..."; and shaping a node's input for an unset `onStart` fails "the runner shapes
...".
`apps/mcp/test/labSandbox.test.mjs` (sabotaged): a put lands in the test chat and is read back there while
the real object holds nothing; a real key is read through until the test chat changes it; the test chat's ledger is
the sandbox's and another chat's is never written; an alarm never arms and an unknown or writing op is refused; the
control-plane client sends nothing for a write; a non-read tool is stubbed; the env has none of the left-out bindings;
retry/back/drop cut what they should; a stranger is refused; another person's test chat does not exist for them.
`apps/mcp/test/labSandboxEvents.test.mjs` (sabotaged): a picture is logged as one and reaches the turn as the Worker
prepares it; a redirect to an address is never followed; a reply's `replyTo`/`quoted` and a group's `replied`; a ❓ runs
the turn as the tapback and a ❤️ on a plain text is only noted, uncounted, and carried as `reacted`; the refusals (http,
an address, a non-picture type, 7 pictures, an unknown `replyTo`, a seventh emoji, a tapback on a tapback, an edit or
unsend of a real text or Tex's); an edit runs the edit step and, changed, its turn; an unsend runs none and leaves the
chat lines; `sets` never lists the Test Set and it never opens.
Control plane (`apps/convex/__tests__/controlPlane/texLabSandbox.test.ts`): who is let in, the session carries no token,
a chat the caller is not in answers as one that does not exist.

What a "simplification" would cost: running test texts on the real objects with a flag to skip writes puts every
write path's honesty on one boolean and production's data one bug away; running them in the bench harness instead
tests a turn that is not the one people text. Reading a Tex text's cause from step times instead of recorded parents
plays the wrong steps the moment two run side by side (a background node, a job beside the next turn); serving pages to
whoever holds the link turns a test chat's page, made from someone's notes, into a public one; making the line's steps
nodes of the config would put the Lab's transport in the graph every real turn runs.

## An AI's test chats (2026-11-16)

Dev2, 2026-11-16: an AI through the MCP sends test texts, sees after the run which steps ran and which did not, what
each got, gave and thought and how long it took, and tries a change against main, "running as me"; and "if I go into a
session/draft an AI is updating / editing, we can co work, and when its playing something I can see it playing". Spec
approved by Dev2: https://claude.ai/artifact/Uisi6KJQhizxCAos82TTKN.

`tex_dev` `sandbox` (`apps/mcp/src/texDev/sandbox.js`) is the same route on the connection's own grant, only shaped for
a model: `open` answers the last rows and a Lab link, never a whole chat; a send waits (at most 50 s) and answers a run
card (Tex's texts, total and first-text time, every step that ran in order, the config's steps that did not run with
the reason read from the wires and what their sources said, slowest, failures, writes); `step` reads one step whole
with Replay's own reader over the test chat's history file (route op `read`, its own chat only), so prod and sandbox
have one reader; `again`, `try` and `replay` set runs side by side with a diff. A production run's card never lists
"did not run": its graph was its own version's, and guessing it from today's would show what did not happen.

Co-working: the route's `list` names every test chat of the person's last day, who opened it and who used it last
(the Lab, or `AI (<client>)` passed as `by`), and what runs now; the AI hands the person `/lab?sandbox=<id>` to follow
it live. Both are the same person's grant, so nothing is shared beyond them.

**Tests**: `apps/mcp/test/texDevSandbox.test.mjs` (sabotaged: the not-run reasons, the wait's deadline, open's last
rows) and the route's `about`/`use`/`read`/`list` in `labSandbox.test.mjs` (another person's never answers).

## Cross-chat asks in a test chat (Dev2, 2026-11-17)

Dev2's standing rule: a feature is done only once it works in the Lab. A test turn's `ask_chat` runs for real through
the Cross-chat gate. The test chat's chat object sends the ask as production does, but the other chat's object is
never the real one. `jobs.js` keeps the ask, and `crossRuns.js` carries it once the turn ends:

- The group's linked test chat is opened once on that group and kept with the asking test chat as `linked:<key>`. It
  takes the ask through its own chat object (`/cross-ask`) as a row of its own, and its run answers back without
  texting there.
- That answer reaches the asking test chat's object (`/cross-answer`), which runs its own turn with it.

Each run is an ordinary test run (real models and reads, writes kept in the test chat), and each is counted as a sent
text. The asking reply row names the linked chat and both rows (`cross`), and the `tex_dev` card carries them. One hop,
as in production. A chat shared with the developers never asks, because its person's groups are theirs.

Faking the ask, as test chats did before, made Dev2's 1:1 failure invisible in the Lab. Its tests are
`apps/mcp/test/labSandboxCross.test.mjs` (sabotaged).
