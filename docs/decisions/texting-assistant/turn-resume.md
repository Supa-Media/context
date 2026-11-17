# A retried turn goes on from what its last try did (2026-11-17)

Dev2, 2026-11-17, after weighing a move to LangGraph: stay on our own runner and take LangGraph's best idea, a run
that saves after every step and continues from the last one, "immediately". Dev2 had Fable review the plan and the
code before it shipped; this is the reviewed shape.

**What it fixes.** A texted turn that dies after its tools ran (a crash in its checks, the gateway out of memory, a
dropped stream) is tried again by the texting Worker, up to four times (`apps/agent/src/inbox.ts`). Each try started
from the person's text, so every search, page and note save ran again.

**What is kept, and where.** After each tool call returns, the front door's model loop (`apps/mcp/src/agent/turn.js`,
`turnResume.js` `roundsKeeper`) keeps a snapshot: the messages after the question, the model's calls and what each
returned. It is kept in the chat's own home, beside its ledger (`apps/mcp/src/texStore/rounds.js`): a person's in their
personal workspace's object, a group chat's in its own Tex object. It never goes to the texting Worker, so a group's
sealed memory never leaves the home only its people open ([chat-homes](./chat-homes.md)). One row per text, the newest
snapshot, read back for 30 minutes and deleted once the text is answered, not a note (never listed, searched or
exported), wiped with the ledger.

**What is never carried on.** A snapshot is the transcript, not the turn's other state (asks held for a yes, jobs
started, pictures made, vault links, cross-chat asks). So it holds only calls whose whole effect is the words they
returned: a read-only tool the MCP answered, and a progress line (the Worker sends each once per text). Web and browser
steps, any call that returned a picture (its number holds for that try only), pictures and visuals made (marked
read-only, yet each goes out with the reply) and every note write are not: the first such call freezes the snapshot before it, so a try after a crash runs that call again, as every try
did before. What the carried reads showed is told again to the turn's claim check and to the facts its reply keeps,
so an answer quoting a carried read is backed as if this try had read it; each call is told as the tool that ran
(`read_note`), never the wrapper the model named (`fetch`).
Never worse than starting over. A round cut part-way keeps the calls that returned, without that round's thinking.
The outside-read mark ([agent-egress](../privacy-and-sharing/agent-egress.md)) is kept with it and put back, so a
resumed turn is exactly as untrusted as the try that read the outside thing.

**Keyed by the text.** A hash of the question, the chat events it answers and, in a group, the chat lines it was shown:
a newer text merged in, or a group that moved on, starts over. A turn whose text names no events, a job's part (which
keeps its own, [background-jobs](./background-jobs.md)) and a routine's run carry nothing. A provisional run
([provisional-run](./provisional-run.md)) reads a snapshot but keeps none, since what it does before its go may be
put back. A group text started early runs provisional, so in a group only a try that was not provisional
keeps one; measure `turn_resumed` by `group` before widening that.

**What it logs.** The resumed try writes one `resumed` step to the chat's ledger, naming the round and each call, and
never logs the first try's calls again as run (Replay shows only what ran). The gateway's log gets `turn_resumed` with
counts only, which is how we measure whether resuming pays off before building more of it (node-level saves in the
runner, `texGraph.cjs` `progress`, wait on that number).

**What a simplification would cost.** Snapshot the whole transcript regardless of effects and a crashed turn whose
email was held loses its ask: Tex says "reply yes" and the yes does nothing. Keep it in the Worker and a group home's
words sit outside it. Drop the outside-read mark and an injected page read before a crash is treated as trusted after
it. `apps/mcp/test/savedRounds.test.mjs` fails on each.
