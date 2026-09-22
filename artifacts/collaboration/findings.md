# Findings: mounted local collaboration, 2026-09-21/22

**The baseline collaboration implementation does not meet automatic merging across humans, agents,
and offline work.** The ordinary populated-note path worked in this local
build, but populated notes failed in agent and offline scenarios. This does
not reproduce or explain every possible production/account-specific failure.

Baseline: `origin/main` at `c8fd9dce`. Production editing code was left unchanged during this baseline run; the branch now also contains implementation work, recorded separately.
See `README.md` for the exact fixture boundary and reproduction commands.

| Scenario | Final observation |
| --- | --- |
| Two users type into an existing populated note | Both editors converged |
| Ordinary autosave | Bucket contained both users' additions |
| Reload after save | Both additions restored |
| Switch to another populated note | Typing appeared in the other editor |
| Elected saver leaves after a completed save, survivor types | Survivor saved successfully |
| Both clients settle into an empty note, then one types | Failed: typed text saved, but the shared documents remained empty and the other editor stayed blank |
| Agent renames a heading while a human has an unsaved addition | Failed: accepted agent write removed the human addition from both editors |
| One user edits offline while another edits online; reconnect | Failed: offline queue had one conflicted write, and the editors held different documents |
| Reload while offline | Local writing restored successfully |
| Reconnect after that offline reload | Failed: editors still differed; this case also exposed the online peer holding text without its draft becoming dirty |

The original protocol-only browser harness passed **21/21**, independently.
The mounted runner's failures are preserved in `baseline-results.json`, with
actual editor text, room text, draft state, queue counts, and bucket versions.
TypeScript checking passed and the test export built successfully.

## Agent race, observed

The agent read `# Verify\n\nfirst line\n` and its bucket ETag. A human then typed
`UNSAVED human sentence`. Before autosave, the agent wrote a heading replacement
against the still-valid saved ETag. The write succeeded. Both real CodeMirror
editors ended at `# Agent renamed heading\n\nfirst line\n`; the human sentence
was absent. The real `mergeExternalText` adapter also reproduces this loss in
an isolated test, so the failure does not depend on fake authentication.

A version check on the bucket cannot protect unsaved live text. The current
adapter replaces the difference between the *current live text* and the agent's
whole-file replacement. It needs operations derived from the agent's actual
read revision instead.

## Empty note, observed despite the previous fix

Both rooms reported `settled: true` and `phase: live`. One user's editor and
saved draft contained the newly typed text, while both shared documents stayed
empty and the other editor stayed blank.

Code inspection identifies a likely cause in `LiveEditor.web.tsx:1233`: the
callback retained in `bindIfWaiting` closes over the `presence.settled` value
from the earlier render. Invoking that callback when the prop changes does not
make its captured value current. This is a source-based diagnosis; no product
patch was applied to prove the fix in this investigation.

## Offline case, observed with a confirmed socket cut

After the network cut, local persistence succeeded. The online user saved their
addition to the bucket. Reconnection sent the offline user's old whole-file
write against the original ETag. The real file operation refused it as
`CONFLICT`, and the real foreground queue recorded `conflicted: 1` with the
note in `stuckPaths`. The open editor still said `queued`; checking only its
status would have missed the conflict in the queue.

The room hook also entered `unavailable` after a failed grant request and did
not resume collaboration automatically in the observed window. The fixture's
fetch adapter rejects offline requests immediately; production Convex can keep
them pending longer, so that timing is not proof of the exact production auth
failure. The whole-file queue/ETag conflict is nevertheless the actual product
write path, not a mocked conflict response.

The offline-reload case restored the user's local work and later saved it, but
its peer still held a different document. The peer's room text included its
online addition while its draft remained clean at the original body, illustrating
why a client whose election changes needs more than merely flipping `canWrite`.
This is a separate case from the clean handoff-after-save test, which passed.

## Proposed replacement

The design in `docs/design/collaboration-model.md` gives every client a persisted
CRDT and operation queue, routes agent changes through their read revision,
and commits through a server independent of open browsers. Reconnect delivers
operations into the same document. Plain Markdown is continuously materialized
in customer storage; versioned collaboration history also lives there.

The executable experiment passed **10/10**: nine checks of the proposed merging
properties and one expected reproduction of the current destructive adapter.
It covers base-revision agent operations, offline snapshot restore, reordered
and duplicate updates, empty documents, coordinator-state restore, overlapping
replacements, and per-author undo. It does not implement production persistence,
authorization, migration, or the service itself.

Two contradictory replacements still require a deterministic outcome; a CRDT
cannot infer intended prose. The proposed behavior requires no synchronization
merge dialog and retains history/undo. Arbitrary raw bucket overwrites without
revision history cannot receive the same guarantee as supported clients.

## Not verified

Production sign-in and real account membership; the exact deployed build;
production origin/token configuration; the full console layout/route; native
WebView parity; server crash durability; storage-outage recovery; encrypted-note
collaboration; structural rename/delete races. These remain required acceptance
work before claiming the replacement architecture is production-ready.

No real accounts, emails, customer notes, or production services were modified.
