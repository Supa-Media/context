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
- **Known risk: a pairing code can be phished**, as any device-code flow can:
  somebody sends a person a link with their own machine's code. The approval
  screen names the machine, its OS and when it asked, and says to approve only a
  computer being set up right now; and a machine only ever gets the jobs Tex
  sends it, under its owner's rules. Accepted by the design; revisit if abused.
