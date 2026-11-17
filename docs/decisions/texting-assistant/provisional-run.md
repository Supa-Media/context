# A Provisional run starts a step before the steps that decide whether it should run (2026-11-17)

Dev2, 2026-11-17: Front door is the longest step of a turn, and it waited behind Triage, Decide and the Queue. Start it
on every text at once, and when those steps decide Tex should not answer, stop it mid-call instead: wasted work, traded
for speed. Dev2 then asked for one new wire kind rather than two ("early" and "kill"), named it **Provisional run**, and
set what the run may do before its go: "it can read, it can write, but it has to be undoable... any irreversible action
is not allowed... drafting an email is fine", choosing "Revertible now" over a read-only first version.

**One wire mode, `provisional` (`packages/shared/src/texGraph.cjs`).** A → B, provisional: B starts at once instead of
waiting for A, and A drives it. A's output tags, matched against the wire's `when`, say `stop:<tag>` or
`restart:<tag>`; any other output is the go. The wire's `allow` says what B may do before the go: `read` (every write
waits) or `revertible` (the default). Provisional wires are never fired by `run`, never counted as inputs or in the
cycle check; `provisionalWiring(config)` is what the texting Worker reads, from the bundled config or a Lab draft. The
Lab draws it (amber, dotted), edits it (Before its go, Stops it when, Restarts it when), simulates it (the target starts
at its other inputs, `send` never before the sources end) and promotes it.

**What the gateway holds (`apps/mcp/src/agent/steer.js`).** The Worker asks `/agent` with `provisional: true` and the
wire's `allow`, then says `POST /agent/go` or `POST /agent/cancel` with `provisional: true` (which may land before the
run has marked itself running).

- A model call is raced against the stop (`turn.js`): stopped, the turn ends at once, answers `cancelled`, and the call
  is left to finish so its usage is still logged (`provisional` step, `stopped_usage`), which is how the extra cost per
  text is measured.
- A save to a note that is already there, or a fact remembered on one, runs at once when `allow` is `revertible`: its
  text is read first, and on a stop it is written back over the version the run left, so anyone else's later edit is a
  conflict, never lost (`provisional_undo` step).
- Everything else that writes waits for the go: a new note (Context has no delete, and archiving needs a folder the
  context may not keep), an email draft (no draft delete yet), a move, a setting. An irreversible step (an email, an
  invite) waits for the person's yes on top, as ever ([agent-egress](../privacy-and-sharing/agent-egress.md)).
- The turn's answer waits for the go (`provisional_wait`); none within a minute is a stop. Only the Worker sends, and it
  never sends a stopped run's answer.

**What a simplification would cost.** Running writes before the go without the undo leaves a note changed by a turn
that was never meant to answer; dropping the end-of-turn wait answers before Decide said so. Both are caught by
`apps/mcp/test/agentProvisional.test.mjs` (its header lists the sabotage each test catches) and the Lab's
`texLabProvisional.test.ts`.
