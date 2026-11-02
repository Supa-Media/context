# A person's texts with Tex are one record in their Tex object (2026-11-01)

_Part of [the texting assistant](../texting-assistant.md). Decided by the owner, 2026-11-01, repeated many times: "ONE copy only, in the durable object, for 1:1 AND groups", no expiry, no second copy anywhere, and a texted turn never reads its history or About me from storage. The group side is [group-memory-one-copy](./group-memory-one-copy.md)._

## What holds

- **The history is one record.** A person's one-to-one texts with Tex are one JSON record, `.context/agent/history/texts.json` (`agent/history.js`), bounded by the same characters and turns as before (`conversation.js`). The store's routing keeps it in the workspace's own Tex Durable Object, `person:<workspaceId>`, at `state/agent/history/texts.json` (`store/texRouting.js`, `isAgentHomeKey`), never in the bucket, and fails closed when the object can't be reached.
- **Every writer writes that record.** A texted turn, a routine's text, a check-in, an attention ping, a job's update, a settled yes and the Worker's fixed texts all go through `appendConversation`, a read and a conditional write on the record's etag, retried when another writer won. Nothing else is written: no exchange files, no whole file, nothing handed to the texting Worker to carry beside a copy (`sealBeside` is gone).
- **The turn bookkeeping lives beside it.** Turn records (`turns/`, the `{clean}` verdict that keeps a tainted turn from being laundered), and the running, cancel and steer marks keep their `.context/agent/` names for every caller and live in the same object. Their semantics are unchanged (`loggedTurn.js`, `steer.js`).
- **One call before the model.** A texted turn's first read is the object's desk (`texStore/desk.js`): the record and, by the keys the record keeps (`direct`), About me and the jobs list, in one call. Those keys are looked up behind each reply (`agent/texDesk.js`, `learnDeskKeys`), only for the person's own connection to their personal workspace as owner with the private tier, and only keys of notes in this person's own object. A note the desk can't answer is read the old way.
- **No Worker-side copy.** The sealed warm copy the texting Worker carries (`warmCopy.js`) holds the setup, the learned skills, who the person is by their account, and the chat's event log and clean marks. It never holds the history, About me or the jobs list, and a copy sealed before this change is opened without them.
- **The move.** A person with no record yet has the bucket's old copies (the exchange log, or the whole file before it) read once and written as the record, only where none is. The workflow `Tex history into its object` (`apps/convex/functions/texHistoryMigration.ts`, `agent/agentHomeMove.js`) does it for every workspace first, with the turn records (a `clean: false` always copied, a `clean: true` only where none is), so no texted turn has to. Nothing in a bucket is deleted by it; the old keys stay three days as the way back, then the cleanup thread removes them.
- **Export.** Every day's texts are written as they happen into the person's `tex/transcripts/` notes (`transcript.js`), which Download as folders carries. The record is the working copy the next turn reads; carrying the object's state itself in the export is the export thread's (`workspace-objects` migration, T10).

## What a simplification would cost

- Putting any of it back in the bucket, or reading the exchange files "just for a cold turn": the 150-file, 7-second reads before the model (2026-10-31) come back, and with them two copies that can disagree.
- A cache of the history or About me in the texting Worker "for speed": a second copy that expires or falls behind, which is the regression the owner rejected repeatedly.
- Reading the desk's notes by key for any connection other than the owner's own private one: a read that skips the privacy engine for someone it might narrow.

## Tests

- `apps/mcp/test/texHistoryOneCopy.test.mjs`: a texted turn makes no bucket request for the history or the bookkeeping (apart from one move-in for a person with no record); the history, About me and the jobs list come in one desk call before the model; every writer reaches the record; the copy handed back holds none of it, and an old one is not used for it; the bookkeeping keys fail closed without the object; the desk names only this person's own notes.
- `apps/mcp/test/agentWarmBudget.test.mjs`: the warm turn's bucket and control-plane calls (7) and calls to the person's object (3, one desk).
- `apps/mcp/test/agentConversation.test.mjs`: concurrent writers keep every exchange; the old file and log are moved in once and never read again; a read is one call.
- `apps/mcp/test/agentHomeMove.test.mjs`: the move keeps every verdict, never launders a `clean: false`, deletes nothing, and runs again as a no-op.
