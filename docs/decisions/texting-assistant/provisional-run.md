# A Provisional run starts a step before the steps that decide whether it should run (2026-11-17)

Dev2, 2026-11-17: Front door is the longest step of a turn, and it waited behind Triage, Decide and the Queue. Start it
on every text at once, and when those steps decide Tex should not answer, stop it mid-call instead: wasted work, traded
for speed. Dev2 then asked for one new wire kind rather than two ("early" and "kill"), named it **Provisional run**, and
set what the run may do before its go: "it can read, it can write, but it has to be undoable... any irreversible action
is not allowed... drafting an email is fine", choosing "Revertible now" over a read-only first version.

**One wire mode, `provisional` (`packages/tex/src/texGraph.cjs`).** A → B, provisional: B starts at once instead of
waiting for A, and A drives it. A's output tags, matched against the wire's `when`, say `stop:<tag>` or
`restart:<tag>`; any other output is the go. The wire's `allow` says what B may do before the go: `read` (every write
waits) or `revertible` (the default). Provisional wires are never fired by `run`, never counted as inputs or in the
cycle check; `provisionalWiring(config)` is what the texting Worker reads, from the bundled config or a Lab draft. The
Lab draws it (amber, dotted), edits it (Before its go, Stops it when, Restarts it when), simulates it (the target starts
at its other inputs, `send` never before the sources end) and promotes it.

**What the gateway holds (`packages/tex/gateway/agent/steer.js`).** The Worker asks `/agent` with `provisional: true` and the
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

**What the texting Worker does (`packages/tex/worker/provisional.ts`, `groupTurnRun.ts` `startEarly`).** In a group, once
the config wires the Door step as a Provisional run, a burst's asker's messages start their turn at once, beside
Decide (answered first, or in memory where there is no workflow). Decide's choice is the verdict: exactly the messages
it started on is the go; quiet, a wait, or any other set stops it, and the drain carries on with that choice as before,
so a different set is answered by a fresh turn. Until the go, nothing reaches the chat: no tapback on a tool, no
progress line, no fixed line, no answer. A run lost to a restart before its go is nobody's turn (its record is dropped,
its messages wait for the drain). Each verdict is the chat's `provisional` step (the Front door's, in the Lab), with why
and how long the run had gone. The wiring comes from the config the Worker was built with, or a Lab test chat's draft
(`env.TEX_GRAPH`). A 1:1 chat's judged path is next; its texts mostly go straight to Tex already (p50 wait 0.03 s).

**When the early run starts is the wires' `unless`.** Each provisional wire may list `firstLook` (a chat Tex is not set up in), `sms`, and `unpaired` (the worker has the workflow or answer-first, not both). The texting Worker (`earlyGate`) and the Lab's simulation both ask `provisionalHeld`, so a burst the config names does not start the door early: the door still runs, after Decide. A wire with no `unless` starts on every burst. Production lists all three, which is the gate the Worker used to keep in code. A skip is logged (`provisional`, `skipped`, and why).

**`firstLook` and `sms` cannot be dropped.** They are privacy, and they live in editable config, so a Lab Promote or a hand edit could take one off and no later check would notice. `configProblems` (CI, `scripts/tex-config-readers.mjs`), Promote (`scripts/tex-lab-promote.mjs` `configFrom`) and the Lab / `tex_dev` check (`draftProblems`, on the answer to a save and before Promote asks) refuse a provisional wire whose `unless` omits either. The error names the wire and the missing hold, and the refusal is logged (`provisional_hold_refused`). The promote workflow prints that log and sends the Lab only the sentence. `unpaired` may be absent. The runner is unchanged: a config that already keeps both holds runs as before, and `provisionalHeld` still reads a wire as written. A migration that put the holds back would hide the drop, so an old draft that never had them is refused until someone adds them, not rewritten. A simplification that removes the check lets a Promote or a hand edit start the door on a first look or an SMS. Tests: `apps/mcp/test/texProvisionalHolds.test.mjs`, the self-test in `scripts/tex-config-readers.mjs`, and the self-test in `scripts/tex-lab-promote.mjs`.

**What a simplification would cost.** Putting that gate back in `groupInbox.ts` makes the Lab start the door early for a first look, an SMS, or a one-path worker, which is the drift this removes. `packages/tex/worker/groupProvisional.test.ts` ("the early start is the wires' unless") and `apps/mobile/__tests__/texLabProvisional.test.ts` ("a first look, an SMS or an unpaired worker does not start the door early") fail if it is reversed.

**What a simplification would cost.** Running writes before the go without the undo leaves a note changed by a turn
that was never meant to answer; dropping the end-of-turn wait answers before Decide said so. Both are caught by
`apps/mcp/test/agentProvisional.test.mjs` (its header lists the sabotage each test catches), the Worker's
`packages/tex/worker/groupProvisional.test.ts`, and the Lab's `texLabProvisional.test.ts`.

**Door beside Front door (Dev2, 2026-11-17).** On a Provisional run the cap check (`allowed`, the control plane's
daily-limit answer) runs beside the model instead of before it, as on a lean chat: nothing a provisional run says or
changes past an undoable save leaves before the go anyway, and `allowedFirst` still holds every tool until the cap has
answered, so a refusal ends the turn with no tool run. Measured over the two days before (`tex_timing`), the check was
0.25 s of Door at the median and 0.7 s at p90, with rare 4 to 16 s spikes; the history read stays in front, because
Front door's first call is built from it. Simplifying this back costs that time on every provisional run;
`agentProvisional.test.mjs` ("Door beside Front door", "the cap refuses") fails if it is reversed or the hold is lost.
