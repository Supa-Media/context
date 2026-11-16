# The Lab's test chats run the real turn on a copy that changes nothing (2026-11-16)

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
texts nobody; it never gets the Worker's secret or a real token. The chat is addressed by made-up 555-01xx numbers and a
`lab:<sandboxId>` chat id; a group's real key and members, which its ledger and home are found by, are put back on the
turn's body at the `/agent` hop. A group's object starts set up for its people, as the real chat's is once Tex
answered there. A Lab test text's arrival names its provider `lab`. Tapbacks, edits and unsends still run the turn
alone (`labSandbox/harness.js`) until each goes through the object too. The Lab polls `get` with `after` the last real
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
- `react { sandboxId, msgId, emoji, as? }` → `{ msgId, turn }`, `emoji` one of ❤️ 👍 👎 😂 ‼️ ❓ on any row with words
  (Tex's included, never a tapback or a quiet reply).
- `edit { sandboxId, msgId, text, as? }` → `{ msgId, to, why }` and `unsend { sandboxId, msgId, as? }` (the Lab's
  Delete, iMessage's Undo Send): only one of the test texts (never a real one, Tex's, a tapback, an edit or unsend row,
  or a text already taken back), in a group only as its sender. Each runs node `edit` with the draft, as the texting
  Worker asks it for a Photon edit or unsend ([edits-and-unsends](./edits-and-unsends.md), `labSandbox/edits.js`),
  compared with the words the text says now: `same` keeps nothing; `turn` keeps a `kind: "edit"` row `on` the text
  with the new words (`edited: true`) and runs its turn; `withdraw` keeps a `kind: "unsend"` row with a quiet noted
  reply and no turn, and marks the text `unsent`. The event is logged as the Worker logs one (`edited`/`unsent`,
  `replyTo`, `quoted` the words before), the node's run as the row's first step; a group's chat lines leave out a text
  taken back. Retry sends an edit or unsend again as itself. tex_dev's `sandbox` has both ops.
- `get` rows carry `pics`, `replyTo`, `reactions: [{ who, emoji }]` on a tapped row, and each tapback's own row
  (`kind: "reaction"`, `emoji`, `on`, its line as `text`). Retry sends a text again with its pictures and reply, and a
  tapback again as itself. The daily cap counts every op that runs a turn, and only those.

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
  only noted, runs no turn (a quiet `noted` reply row, not counted), and the next text carries it as `reacted`. In a
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
   (`tools/session.js`), a tool not in `READ_TOOLS` gets a stub answer ("Done. ... nothing was changed or sent") and
   is listed, so the turn carries on as it would have. `vault_list` and `report_problem` are not reads here.

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

**Known gaps, said rather than hidden.** A note a test turn writes through a stubbed note tool is
not readable back (the tool never ran); a note written through the objects is. `ws.rows.files` and `ws.rows.listing`
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

**Tests** (`apps/mcp/test/labSandbox.test.mjs`, sabotaged): a put lands in the test chat and is read back there while
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
tests a turn that is not the one people text.
