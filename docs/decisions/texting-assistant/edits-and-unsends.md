# An edited or unsent text is kept beside the one it changes, and Decide judges an edit from examples (2026-11-16)

Dev2, 2026-11-16, choosing "Build edit support in Tex" on the Lab declutter's card, then: "not just edits but deleted
messages as well". Until then Photon's bridge heard iMessage's Edit and Undo Send and the texting Worker counted them
and dropped them, so Tex kept answering words a person had replaced or taken back.

**One node, "A text is edited or unsent" (`edit`, `texConfig.json`), a start of its own wired to Triage.** The chat
object's `/edit` (`apps/agent/src/editStep.ts`) finds the text the event changes, by the provider's handle the text
came with (`replyQuote.ts` `noteHandle`, kept for 1:1 texts as for a group's) or else the line's own copy of its words
(Photon's `previousText`), and asks the node on the gateway's graph (`/texts/edit`). The node is pure code and says
only what happened, never whether it deserves an answer:

- an edit whose words did not change: nothing;
- any other edit: kept and queued like a text. Triage sends a lone edit to Decide, never straight to Tex, and Decide's
  verdict stands for it as for a bare thanks: whether a fixed typo goes quiet and a changed ask is answered is taught by
  the Training conversations' labelled edits (`jo-and-tex`, `group-2`; Dev2's rule: judgment by examples, no fixed
  behavior rules; a first draft that coded "typo fixes go quiet" was taken out);
- an unsend: kept as that text taken back, and the text leaves the chat's queue if no turn has started on it, since
  it is no longer there.

A failure answers "turn" for an edit and "withdraw" for an unsend, so neither is dropped. The Worker logs the `edit`
step (counts, where the words before came from, the node's answer and why; never words), the gateway's graph logs
the node's run.

**How it is kept and shown.** The event is a person's `text` with `edited: true` (its new words) or `unsent: true`
(no words), `replyTo` the text it changes and `quoted` that text's words, both set by the Worker and refused from
anyone else (`log.js` `checkEvent`). The transcript marks it ("(edited an earlier text to) …", "(unsent an earlier
text)") with a note line naming the earlier message as the transcript shows it; a message outside what is shown is
never quoted from `quoted`, the rule a reply follows, so a group's newcomer never reads what was said before they
joined. Neither is ever "(not answered)".

**Where.** Photon's line, 1:1 and groups (a moved group's edits go to its old home, as its texts do). Sendblue sends
no edits or unsends; WhatsApp's `messages.patch` is not read yet (the capability list's `cant`).

**The Lab.** A test chat's ⋯ has Edit and Delete (Undo Send) on a test text, and tex_dev's `sandbox` has `edit` and
`unsend`: the same node with the draft, the same event, a turn only for `turn`
([lab-sandbox](./lab-sandbox.md)). As for any test text, the judge is not asked before the turn.

The judge's transcript writes them as the Training conversations do (`events.ts` `renderTranscript`, `texTraining.cjs`
`lineOf`): `(edits "…" to) …` and `(deleted "…")`.

**What a simplification would cost.** Folding an edit into the earlier text in place rewrites the record a person
owns and hides what Tex answered; sending an edit straight to Tex answers every fixed typo; a code rule for which
edits matter is a fixed behavior rule the examples should teach. Tests: `apps/agent/src/editStep.test.ts`,
`apps/mcp/test/editNode.test.mjs`, `apps/mcp/test/labSandboxEvents.test.mjs`, replay case `edit-and-unsend-shown`.
