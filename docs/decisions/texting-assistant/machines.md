# The texting assistant — your own machines as Tex's minions

_Part of [the texting assistant](../texting-assistant.md), beside
[background jobs](./background-jobs.md) and [delegation](./delegation.md)._

### A person's own computer becomes more minion slots, run by one Rust runner (2026-11-03, 2026-11-04)

Asked for and approved by the owner, 2026-11-03 and 2026-11-04 ("go ahead and
spawn threads that can work on this in parallel"). With a small program on a
computer, Tex runs that person's own `claude` and `codex`, signed in to their
own subscriptions, as more minion slots. The job's own Durable Object, the
advisor checking every part, steer, stop, restart and the report to the
coordinator stay exactly as they are for cloud jobs; only the part that does
the work moves to the machine.

- **A machine lives in its owning workspace object.** No Durable Object per
  machine. A personal laptop is rows in its person's workspace object; a team
  computer (the Tex Devs VM) is rows in that shared workspace's object, run by
  its owners and editors. The object holds the runner's one hibernating
  WebSocket, the slot counters and the settings rows, and exports them with
  the workspace. The control plane keeps only the machine's revocable grant,
  as it does an AI client's. Reversing it (a `machine:<id>` object) would put
  a second boundary beside the workspace's, with its own isolation to prove.
- **One runner, in Rust** (`apps/machine-runner`), headless, carried inside the
  Mac app; `npx @supa-media/context machine` only downloads it. It dials out
  and never listens.
- **One protocol, written once.** `packages/shared/src/machineProtocol.schema.json`
  is the only definition of what the runner and the workspace object say. The
  gateway's types (`machineProtocol.generated.ts`) and the runner's Rust types
  are generated from it, `machineProtocol.examples.json` holds one example of
  every message for both sides' tests, and every runner frame passes the
  validator in `machineProtocol.cjs` before a field of it is read. Test:
  `apps/mcp/test/machineProtocol.test.mjs` ("the generated TypeScript types
  match the schema", "the validator refuses a schema keyword it does not
  check"). Sabotage record (2026-11-04): adding a refusal code to the schema
  without regenerating failed the first; making the validator ignore
  `additionalProperties: false` failed "a runner frame is parsed only when it
  is valid".
- **The protocol cannot run a command.** The workspace object sends only
  `challenge`, `welcome`, `rules`, `assign`, `message`, `interrupt`, `cancel`
  and `goodbye`. An assignment's brief is words for the agent, never a shell
  line, and the runner checks every assignment against its local copy of the
  owner's rules (folders, tools, limits, who may ask) before starting
  anything, so neither a gateway bug nor a compromised gateway gets past one
  check. Test: "the protocol has no message that runs a command".
- **A hello proves the key.** Every connection opens with a challenge the
  runner signs with the machine's Ed25519 private key, over
  `helloSigningText(machineId, nonce)`, which names the purpose and the
  machine so a pairing signature or another machine's never passes. A copied
  grant without the key is useless.
- **A slot is compute, not a tool.** Any slot runs Claude Code or Codex, picked
  per job. Each machine shows a recommended count (shared use) and a most (only
  runs Tex) from its memory and cores, about 1.5 GB and half a core per
  session, never over 8 (`slotCounts`). The chat's pool is its cloud slots plus
  each attached machine's share; the workspace object refuses an assignment
  that would overfill a machine two chats share.
- **Machine jobs run longer.** Four hours by default, up to 24, the advisor
  still checking every fifteen-minute part; cloud jobs keep thirty minutes and
  ten parts. After a disconnect a job resumes the same CLI session: the runner
  reports the session id as soon as the tool names it, and its held runs in
  every hello.
- **No separate approvals for push, deploy or secrets** (owner, 2026-11-04,
  after Tex Devs' feedback). Once a job is allowed on a machine it may use what
  that machine is signed in to; the owner's choice of who may send it work is
  the control.
- **Groups.** A machine in a group serves only its owner by default ("Only
  me"); the owner may open it to everyone or to named people, with "Ask me
  first" on, which the gateway holds until the owner's own yes. Other people's
  runs never get computer use, folders outside the allowlist, the owner's
  personal notes (they run on the group's grant), the owner's kept slot, or
  the network unless the owner turned it on for that chat.

### Credentials on a device: the machine grant and the run grant (2026-11-04)

Non-negotiable #1 says credentials never live on a device. Two do here, as the
desktop app's grant already did, and this is the decided exception rather than
an implied one:

- **The machine grant**: one per machine, issued at pairing, bound to the
  machine's public key, listed and revocable in Settings like an AI client
  grant. Kept in the Mac app's safeStorage, or the OS keychain, or a `0600`
  file in the runner's own folder.
- **The run grant**: minted per job part, expiring when the part ends, scoped to
  what the job's own grant allows (the group's for a group's job), never
  carrying send actions. Written to a `0600` MCP config file, never argv or
  the environment, and deleted when the part ends.

The person's subscription logins (`~/.claude`, `~/.codex`) never leave their
machine: we never read, copy, seal or store them. The runner starts the
unmodified CLI, which signs itself in.

### Pairing: a code compared on both screens, a grant only the machine can collect (2026-11-04)

- **A runner pairs with a short code** (`POST /machines/pair`, `apps/mcp/src/machines/routes.js`):
  six characters without 0/O or 1/I, shown on the machine and in the app, approved
  by the person signed in. Only a personal workspace's owner, or a shared
  workspace's owner or editor, may approve (`mayOwnTexMachine` in the control
  plane). The control plane keeps the code's hash, ten minutes, and nothing else
  of it.
- **The grant is collected with the machine's key.** The runner polls with an
  Ed25519 signature over `pairSigningText(pairingId)`; the gateway checks it
  against the public key the pairing started with, and only then mints the
  grant (`cmg_` and 32 random bytes), which the control plane stores hashed.
  An unknown pairing and a bad signature answer the same 404. The grant is
  returned once. Test: `machineRoutes.test.mjs` ("only the machine that asked
  can collect the grant").
- **The Mac app registers its own Mac** (`POST /machines/register`) with its
  signed-in connection's session instead of a code. The Mac still gets a grant
  of its own bound to its own key, so revoking the Mac never touches the app's
  connection.
- **The socket** (`GET /machines/socket`) resolves the grant with the control
  plane, and the owning workspace object takes it and asks for a signed hello
  before reading anything (`workspaceStore/machineSockets.js`). A socket lives
  an hour, then the runner reconnects through the gateway, so a revoked grant
  stops working within the hour even without the object being told; the app's
  Disconnect tells the object at once. A browser `Origin` header on any
  machine route is refused.
- **The app's screens** (`POST /machines/app/{list,set,disconnect}`,
  `apps/mcp/src/machines/appRoutes.js`) take only the app's own session.
  A computer is run by its owner or the workspace's owner, the same two the
  control plane lets disconnect it (`revokeMachineAs`): they see its settings
  and change them, and the object tells the runner the new rules at once.
  Another editor of a shared workspace does not, even of a team computer,
  because who may send work to a computer is its rules, and an editor who
  could change them could let themselves onto somebody else's computer; any
  other member sees only its name, system, owner and whether it is online.
  Disconnect revokes the grant in the control plane first, then the object
  says goodbye on the socket and ends its live runs. Test:
  `machineApp.test.mjs`, whose header records its sabotage.
- **Known risk: a pairing code can be phished**, as any device-code flow can:
  somebody sends a person a link with their own machine's code. The approval
  screen names the machine, its OS and when it asked, and says to approve only a
  computer being set up right now; and a machine only ever gets the jobs Tex
  sends it, under its owner's rules. Accepted by the design; revisit if abused.

### A job's part on a machine: a run grant that acts as the job and never sends (2026-11-04)

- **The texting Worker's job asks the gateway, with its own texting token**
  (`POST /agent/machine/{assign,run,cancel,deliver}`, `apps/mcp/src/machines/jobRoutes.js`).
  Only a person's own 1:1 texting client with write scope reaches them; a
  group's job waits for groups. Who asked, and whether it is the machine's
  owner, come from the grant, never the body. A person's own chat is
  `texts-<userId>` to the owner's chat rules, so a rule for one person's
  chat never covers another's. Test: `machineJobs.test.mjs` ("who asked comes
  from the grant, never the body").
- **The run grant is the job's own grant, under its own client.** The gateway
  mints the run id, then the control plane a `cat_` token kept only as a hash
  in `texMachineRunGrants`, pointing at the job's texting grant
  (`/gateway/machines/run-grant`). It resolves only as an MCP session
  (`resolveRunGrant`, never `resolveLiveGrant`, so no owner clearance accepts
  it), as `context_tex_machine_run`, with the parent's person, workspace,
  scopes and group checks re-read every request; it lives at most thirty
  minutes, outlives the fifteen-minute texting token it was minted under, and
  dies with the parent grant, the machine, a refused assignment, the run's
  end or a stop. Test: `apps/convex/__tests__/texMachineRuns.test.ts`.
- **It never reaches outside.** A run session is not offered, and is refused,
  every `send` action, links, invitations and the vault
  (`tools/machineRun.js`); what should be sent goes in its answer, and Tex's
  own turn asks the person. Test: "a run grant's session is never offered,
  and never runs, a call that reaches outside". Sabotage record (2026-11-04):
  dropping the refusal in `callToolForSession`, the asker check on a run, or
  reading `fromOwner` from the body each failed its test.
- Only the person whose job it is reads, steers or stops a run; another run
  id answers `unknown_run`, as a run that does not exist does.

### Tex runs a job on the person's computer by name, in fifteen-minute parts (2026-11-04)

- **The texted turn names the computer** (`start_background_job`'s
  `on_computer`, `apps/mcp/src/machines/forJobs.js`): by name, or none when
  they have one; its tool and folder are checked against the machine's own
  lists, and a repo is a name under the folder, never a path out of it. The
  machines are read only for a chat's own turn: a person's own 1:1 chat, or
  a group chat for what was lent to it. Test: `machineForJobs.test.mjs`.
- **The turn is told their computers** (`apps/mcp/src/machines/forTurn.js`,
  2026-11-04, replacing "read only when a job asks for one"). The first
  splitting round (gh-149) gave every person a paired computer. All twelve
  code answers still ran in Tex's cloud or went to Claude Code on the web
  (`delegate`), because the turn never knew a computer was there. So a chat
  turn reads its computers beside the history (`tex.ahead("computers")`,
  one workspace-object read per workspace it reaches, never holding up the
  model longer than that read). When one with Claude Code or Codex is there,
  the turn is told it by name and what goes to it, and `delegate` drops
  Claude Code and Codex: a call naming either is answered with the computer,
  so code has one road while a computer is paired. With none, the turn is
  unchanged. Tests: `machineForTurn.test.mjs`, and "a texted turn with a
  paired computer is told it by name" (`agentBackgroundRoute.test.mjs`).
- **The job's object runs each part there** (`apps/agent/src/machineTurn.ts`):
  it assigns the part through the gateway with the job's own texting grant,
  reads the run every ten seconds, streams its steps to the chat as a cloud
  part's are, and keeps the run in progress on the job's run, so a pass that
  restarts reads the same run and never starts a second. A part is fifteen
  minutes; one out of time, or whose machine dropped, is carried on by the
  next part resuming the same CLI session. A later text goes into the running
  session and a stop cancels it there. A computer that refuses the part
  (offline, busy, over its limits, not allowed) is told in words, and the job
  can be picked back up.
- **Four hours by default, at most 96 parts** (`MACHINE_JOB_LIMIT_MS`,
  `MAX_MACHINE_JOB_ATTEMPTS`); a cloud job keeps thirty minutes and ten parts,
  and the chat marks a machine job stale only past its own limit. Raising one
  job past four hours, up to the machine's longest run, is the app's to
  offer. Test: `machineTurn.test.ts`, whose header records its sabotage.
- **The advisor checks every machine part**, as it checks a cloud part
  (`jobCheck.js`). When a part ends finished or out of time, the job's object
  asks `POST /agent/machine/check` with the job as it knows it (title, brief,
  finish line, their later texts, the last advice); the gateway reads the
  part's steps and last words from the run in the workspace object, never
  from the body, and only for the person whose run it is. `keep_going` on a
  finished part carries the job on, resuming the same session on the advice;
  `waiting` and `stuck` end it saying what is needed or why. The steps reach
  the advisor as tool calls without their results, which stay on the
  computer, and it is told so. A machine part's words are never trusted as
  the person's (`untrusted`), the check is metered as background spend on the
  job's own grant, and an advisor that can't be reached leaves the part's own
  outcome to decide. Tests: `machineJobs.test.mjs` and `machineTurn.test.ts`.
- **A computer is lent to a group chat by its own owner** (2026-11-04). A
  group's grant reaches only its shared workspace, never anyone's personal one,
  so a laptop in its owner's workspace is reached through the lending: the
  owner, one of the chat's people, lends it from the app
  (`POST /machines/app/lend`), the control plane records it
  (`texMachineChats`), and a group job's calls reach only the computers lent
  to that chat, live and with their owner still in it (`machines/reach.js`).
  Only the computer's own owner lends it, never the workspace's owner. Who in
  the chat may send it work is the computer's rule under `group-<key>`:
  "Only me" unless the owner opens it to everyone or names people, with "Ask
  me first" on unless they turn it off. The part runs on the group's own grant
  (minted again with the chat's people read again, as a group job's cloud part
  is), so it never reaches the owner's own notes, and the tagger is who asked.
  Tests: `machineJobs.test.mjs` ("a group chat reaches only a computer lent to
  it", "somebody else in the group gets the computer only as its owner's rule
  for that chat says"), `machineApp.test.mjs`, `machineTurn.test.ts`.
- **"Ask me first" is the owner's own yes, kept by the workspace object**
  (2026-11-04). An ask the rule holds makes one waiting ask per job, chat and
  person (`ws_machine_asks`), listed with the computer (`asks`), and the
  owner answers it in the app (`POST /machines/app/answer`); only the
  computer's own owner may. A yes holds for that job for the day, a no ends
  it (`declined`), and "always" adds that person to the chat's `always`, so
  they are never asked again there. The object decides whether the yes was
  given; a caller saying `approved` is ignored. The job's part waits up to
  ten minutes for the answer, inside its own fifteen, asking again each
  minute, then starts or says why not. Tests: `machineJobs.test.mjs` ("Ask me
  first waits for the owner's own yes…"), `machineApp.test.mjs`,
  `machineTurn.test.ts`.
- **What the app's machine screens needed besides** (2026-11-04):
  "more time today" (`POST /machines/app/raise`, whoever runs the computer)
  is kept on the computer as a raise for that day in its owner's time zone,
  added to the day's limit by `admit` and in the rules the runner gets, and
  gone the next day; the daily limit itself never changes. Naming people in
  a group's rule needs their ids: `POST /machines/app/chat-people` gives a
  chat's people with ids and handles, to one of them only (the control
  plane's `chatPeopleAs`). An ask from a group carries the chat's full key
  from the grant, so the owner's list names who asked by handle
  (`askerHandle`); the key itself is never sent to the app.
- **Not yet**: telling the owner an ask is waiting, beyond the app's list
  (a text or a push), and a machine's slots counted apart from the chat's
  three cloud slots.
