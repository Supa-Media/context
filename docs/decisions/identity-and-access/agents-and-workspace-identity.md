# Identity and access — agents and workspace identity

### The hook is a capture-only OAuth client, and that is the whole design

An agent can call `save_context` when it finishes, and the failure mode is not
refusal — it is a long session that ends without one, where the thing worth
keeping was in the part nobody wrote down. The hook is the safety net, and
because it runs unattended it is the one credential in this system that sits on
somebody's laptop indefinitely.

So it asks for `context:capture` and nothing else. That grant writes to
`0-inbox/` and **cannot read a single note** — no search, no listing, no
existence oracle. The obvious upgrade, `context:write`, would let the hook
honour the user's own save destination instead of always landing in the inbox,
and it would also mean a stale credential on an old laptop can read every
private note its owner has ever written. That trade only goes one way, and a
capture landing in `0-inbox/` is not even a compromise: it is what that folder
is for.

It authenticates with the ordinary authorization-code flow over a loopback
redirect, which the gateway already supported — `redirectUriMatches` implements
the RFC 8252 §7.3 port exception precisely so native clients can do this. The
three alternatives were considered and are worse: a dashboard-minted long-lived
token is a bearer secret with no client identity behind it, so revoking it is
all-or-nothing; reusing the token the AI client already holds would require
reading another application's credential store; and token-in-URL is already the
compatibility fallback and never the boundary.

Each machine registers its own client, so revoking the laptop you lost does not
sign out the one on your desk.

**The capture boundary is an allow-list, and it is the most security-sensitive
code in the package.** A session log holds the system prompt, the model's
reasoning, every tool call and result, and the contents of files read along the
way. A message travels only if its role is `user` or `assistant` *and* its
content block is declared `type: "text"`. Switching on the declared type rather
than reaching for any `.text` present is what stops a `tool_result` — whose
nested blocks also have a `.text` — from being posted; the fishing version
passes every test written with plain string messages, which is why the suite
seeds a log carrying six distinct marker strings and asserts each one absent.

**The session-start hook is where the scope question actually bites.** Claude
Code injects a `SessionStart` hook's output into the session before the first
turn, which is the only mechanism anywhere in this product that does not depend
on an agent deciding something — and it is therefore the strongest available
answer to "connected agents never call `orient`". Fetching a real orientation
needs read access, on the credential that sits unattended on a laptop, so there
are two versions and the default is the narrow one: capture-only injects an
instruction to call `orient`, and `--orient` injects the orientation itself.

Three things hold that line. The wider mode is a flag somebody types, never a
default they discover afterwards. A change of scope **re-registers the client**
rather than re-authorizing the one that declared it wanted less. And neither
mode ever requests `context:private` — a hook that could read every note its
owner marked private is past what any convenience is worth, and the cost is
paid honestly: on a mostly-private context the injected orientation is thin and
says so.

Both hooks fail towards doing nothing loudly rather than something wrong
quietly. The start hook runs before the person has typed anything, so a revoked
grant, a slow gateway or a capture-only credential all come out as the
directive, and a capture-only install does not even spend the request finding
out it cannot read.

**A hook is only offered for a client whose contract can be read rather than
guessed** — and the first version of that list was wrong, in a way worth
recording because the error was not in the rule.

It said Claude Code was the only client with a documented end-of-session hook.
That was **asserted from memory and never checked**, and it is false: Codex CLI
and Gemini CLI both ship hook systems of the same shape — a command per
lifecycle event, `session_id`/`transcript_path`/`cwd` on stdin, and an
`additionalContext` field at session start. The claim shipped into a doc
comment, a README, a console string and this file before a question caught it.
Never state what another product does or does not support without looking; a
confident sentence about somebody else's software is the cheapest thing here to
get wrong and the most expensive to notice.

The rule itself survives intact, and still excludes two: **Cursor** has hooks
(`beforeSubmitPrompt` … `stop`) but publishes no transcript path, so the capture
half has nothing to read; **hosted ChatGPT** has no hook system at all. A hook
that silently never fires is worse than no button, because the person believes
their sessions are being saved and finds out months later that none were.

Three details differ between the three that are supported, and all three are
places to be careful: the file (`~/.claude/settings.json`, `~/.codex/hooks.json`,
`~/.gemini/settings.json`); what the end of a session is called (Codex says
`Stop`); and **the unit of `timeout` — seconds for Claude Code and Codex,
milliseconds for Gemini CLI**. The installer writes no timeout at all rather
than carry a number that means two different things depending on where it lands.

It also writes **no property outside the client's own schema.** An earlier
version stamped a marker key onto its hook entry to recognise it later; that is
an unknown field inside somebody else's config, across three parsers whose
strictness we cannot test, and the cost of being wrong is their whole settings
file failing to load. Our entries are identified by the command string instead —
still recognised on read, so an upgrade replaces an old marked entry rather than
stacking a second one beside it.

### A workspace's name can be given back, and only its owner can give it

A workspace claims its slug at step 1 of its creation flow — before a bucket,
before a member, before anything — out of the same global namespace usernames
come from, and `createWorkspace` counts it against `MAX_WORKSPACES_PER_USER`
the moment it commits. Until `account.deleteWorkspace` existed, the only thing
that released either was deleting the whole account. A workspace somebody named
and never finished was therefore a reservation nobody could cancel, including
the person who made it: the name was spent globally, one of their ten contexts
was spent, and the flow's "nothing here expires" was true in a way that read as
reassurance.

The release path is deletion, not expiry. **A name must never vanish from under
somebody**, which rules out reaping an idle workspace on a timer: a context with
no binding is a state the schema supports on purpose, and "no activity" is
indistinguishable from "not started yet" for a workspace whose members were
invited and have not answered. So the name comes back when its owner says so and
never otherwise, and the creation flow now says which it is.

Four guards, and each is the reason the other three are safe to offer:

- **Owner only.** `requireWorkspaceRole(…, "owner")`, which tells a stranger
  nothing beyond "not found". An editor tearing down somebody else's workspace
  is the worst thing this mutation could be made to do.
- **The slug, typed, checked on the server.** `DeleteAccountCard` is armed by
  pressing twice, which is right for the one account a person has. A person can
  have ten workspaces open in as many tabs, all reached through the same
  settings section, so "the one I was looking at" is not a guard and the
  confirmation is the name itself. The console gates its button on the same
  comparison, but the mutation is what enforces it — a client that skipped the
  field cannot skip the check.
- **Shared only.** A workspace's slug is the person's own username and its capture
  address is live on the apex, so releasing it is account deletion's business
  and is deliberately not reachable from a settings panel (`PERSONAL_CONTEXT`).
- **Not while we hold the only key.** On managed storage the notes live in a
  bucket the customer has no credential for, and the free hand-off path is still
  unbuilt (`billing.md`, "What is deliberately not built"). Deleting the row
  would either strand their notes in our infrastructure with nothing pointing at
  them or destroy the only copy; non-negotiable #1 permits neither, so it is
  refused with `MANAGED_STORAGE` and the refusal is drawn in place of the field
  rather than after the press. The export and hand-off work is what lifts it.

What is deleted is `deleteAccount`'s cascade, unchanged — our metadata about the
workspace, credential envelopes included. **A bucket the customer owns is never
touched**: the same "revoke the key and we're gone" promise `disconnectStorage`
makes, which is precisely why this is safe to offer at all. Their notes stay
where they put them and stay openable in Obsidian.

**The tests that fail if this is reversed.**
`apps/convex/__tests__/deleteWorkspace.test.ts` walks every guard, proves the
name is claimable again afterwards, and proves one workspace's deletion leaves
another's rows alone; `apps/mobile/__tests__/deleteWorkspaceCard.test.ts` holds
the console half — the typed-name gate, the refusal drawn instead of a button,
and the sentence saying the files stay.

### OPEN: the local agent and the console agent are two different principals

*Recorded 2026-09-19, unresolved. Raised by the self-review on #724 rather than
by a bug, which is the reason it is written here instead of nowhere: it is
invisible from either file that has it.*

The agent panel can reach a person's context by two roads, and they authenticate
as different things.

- **The gateway road** (`/agent`) uses a grant minted by
  `functions/agentGrant.ts` for the console client, **clamped to the caller's
  role in the workspace being asked about**, one hour long, revocable from the
  connections list.
- **The local road** (`window.desktop.agent`, #724) runs the customer's own
  `claude` against the same MCP endpoint using **the grant this machine got at
  `connectMachine` time** — a different row, minted for a different client, with
  whatever scopes that machine was approved for and no relationship to the role
  the console is currently rendering.

Both are the same human, and neither road can exceed what its own grant allows,
so this is not a privilege escalation and nothing here is presently exploitable.
What it is, is an **asymmetry nobody declared**: the same question, asked from
the same panel, can be answered under two different ceilings depending on
whether a CLI happens to be installed. Non-negotiable #4 says one person or
workspace is one security boundary; two principals reaching one context from one
control is the sort of thing that sentence exists to keep visible.

Three specific consequences, none of them resolved:

1. **Revoking the console grant does not stop the local road**, and revoking the
   machine does not stop the gateway road. The connections list shows two rows
   and the panel shows one control, so "I revoked the agent" is ambiguous.
2. **The machine grant is not clamped per question.** The console road re-mints
   against the workspace being asked about; the local road uses whatever the
   machine holds, so a console switched to a context the machine's grant does
   not cover is refused by the gateway rather than narrowed to it. That is the
   safe direction, but it is a refusal the person will read as a bug.
3. **The audit trail records two different acting identities** for the same
   person doing the same thing, which `Audit records the acting identity, not
   just the scope` makes a feature — but nothing tells a reader of that trail
   that the two rows are one control.

**What a resolution would look like**, when somebody takes it: the local road
mints a console grant the way the gateway road does and hands *that* to
`--mcp-config`, so the machine grant goes back to meaning "this Mac files
meetings" and the agent means one thing on both roads. The cost is a round trip
to Convex per question from a surface that currently needs none, and a token
written to a file that today holds a longer-lived one — neither obviously worse,
both worth measuring before choosing.

**There is no test that fails if this is reversed**, because there is nothing
yet to reverse. What exists is `apps/desktop/test/localAgent.test.mjs` and
`apps/mobile/__tests__/agentLocalRoute.test.ts`, which hold the local road's own
guards; the asymmetry above is deliberately *not* asserted anywhere, because
asserting it would be ratifying it.

## The covered-context set is a reach, not an identity

`session.workspaces` answers "what may this connection address". It is read in
three places in the gateway and one of them was asking a different question —
"who is this person" — and getting an answer that happened to be right for
everybody who had never been let into somebody else's context.

The set is built by `contextsForGrant`: the context the grant was approved
against first, then that person's other memberships. A personal context is in it
whenever its owner shared it, because `schema.ts` says a personal workspace "may
gain more members when that person shares it" — sharing does not change what it
is. So a guest who connected a client to `/@alice/mcp` has Alice's *personal*
context at the head of their own covered set, and `find(kind === "personal")`
returns Alice.

`presenceDisplayName` did exactly that, and labelled the guest's caret `@alice`
in Alice's own note, where Alice was looking at it. Two things made it worth a
decision rather than a one-line fix:

- **The correct predicate already existed forty lines away.** `personalNameFor`,
  which stamps `submitted_by` on a form response, had all three clauses:
  `kind === "personal" && role === "owner" && slug`. Two functions answering one
  question is how one of them goes stale without anybody reading it, so there is
  now one, and presence calls it.
- **The guard was sited on the wrong channel.** `presence.js` says "a member
  cannot name itself" and means the socket: nothing a client sends over the wire
  sets its name. That was true and stayed true. The name still came from a
  client — asserted at an unauthenticated registration endpoint, or, here, taken
  from the wrong row of a list the control plane filled in. A sentence about one
  channel is not a property of the value.

**What `role === "owner"` rests on.** The control plane writes `role: "owner"`
in exactly one place — `workspaces.create`, for the creator — and an invitation
can confer `editor` or `member` and nothing else. So one member of a personal
context is its owner, and that owner is the person its slug names. If a path is
ever added that promotes somebody to `owner` of a personal context, this
predicate is one of the things that changes meaning, and it should be found by
grepping for that literal.

**`kind === "personal"` is load-bearing in the other direction.** Usernames and
workspace slugs are one global namespace, so a shared context's slug on a caret
or a signature reads as a person who does not exist. So does `@null`, which is
why an absent slug falls through to the client's own name rather than being
interpolated into a handle.

**What a simplification costs.** Matching on `kind` alone is one clause shorter
and mislabels every guest of every shared personal context as its host —
silently, to the host. Dropping `kind` labels people with workspace names.
Dropping the slug check invents a handle out of a missing one.

**The tests that fail if this is reversed** are in
`apps/mcp/test/presence.test.mjs`: a guest of a personal context carries their
own handle, a caller who owns a shared context is still named by their personal
one, and a covered context with no name falls through to the client's. Each was
measured by reverting one clause; the last two were **0** before their fixtures
were added, because every fixture in that file was a caller in one context.

**The timing is the argument, so it is recorded rather than left to be
inferred.** The route this was in shipped at 23:57 and deployed; the defect was
found and fixed at 02:07, two hours and ten minutes later. In between, it was
not a latent edge — every guest of every shared personal context who opened a
note was sitting in it under the host's own handle, and the person most likely
to see that was the host. The pull request that shipped the route was careful,
self-reviewed, and green on a suite that grew by 24 checks; it kept a sabotage
row at **0** *as a finding*, which is the discipline working. None of that
reached this function, because every fixture in its suite was a caller in
exactly one context, and a predicate about *which* of several contexts names a
person cannot be wrong in a world with one.

So: **a new route gets an adversarial pass before it is called done, not after
it is deployed.** The specific thing that pass must do here, and the thing a
green suite cannot do for it, is vary the *shape of the caller* — more than one
covered context, a role that is not `owner`, a personal context belonging to
somebody else — because a fixture with one of everything makes every
"which one" bug invisible and every assertion about it look true.
