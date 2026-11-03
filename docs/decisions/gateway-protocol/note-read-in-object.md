# Gateway protocol: a note is read inside its workspace object in one call

**Decided 2026-11-03**, for Dev's "every read under 0.1 s". Fetch's production
median was 571 ms against its 150 ms bar. A read of a note that people had
edited together made four trips to the workspace object, each waiting on the
one before: the row lookup, then the Markdown beside the editing history's
head, then the document's state, then its current revision.

### The rule

Once the gateway's lookup has found the note and the reader may see it,
`read_note` asks the object for the note's Markdown and its editing history's
current text in one call: `ws.collab.read`
(`apps/mcp/src/workspaceStore/collabRead.js`). The object runs the same
engine (`readDocumentIfStarted`) over the same keys `ws.collab.replace` uses,
against its own storage. Any write the read makes (a pending save finished)
is handed back and copied to the bucket behind the response, as a save's are.

The object answers `{served: false}`, and the gateway reads as before, when:
- the notes do not live in the object, or it is not backfilled;
- the live row at the path is no longer the note the lookup resolved;
- the Markdown is not held there, or the engine needs a saved version only the
  bucket keeps.

An encrypted note, or one collaboration does not cover, comes back as its
Markdown alone. An engine refusal comes back as a refusal, and the read fails
closed as it did.

### What it must not become

- **Asked before `canSee` decides.** A refusal must cost what every other
  refusal costs: the lookup and the forwarding read. The object's read is
  asked only for a note the reader may see, and it judges nobody itself.
- **Trusted without the row check.** Without it, a note moved or trashed
  between the lookup and the read would answer another note's words.

Tests: `apps/mcp/test/readNoteInObject.test.mjs`.
