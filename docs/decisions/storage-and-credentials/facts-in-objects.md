# Storage and credentials — notes' facts live in the workspace object

### A note's links and props are read from the object that holds its text

*Decided by the owner, 2026-11-02* ("Yes to all of this. You know, I approve
all the changes needed."), approving the move of notes' facts out of Convex
and into the workspace object, after the workspace-objects migration
([workspace-objects](./workspace-objects.md)) put the text of an object-home
workspace's notes in its object.

**What moves.** For a workspace whose notes live in its object (home
`object`), each note's facts are kept in the object beside its text
(`apps/mcp/src/workspaceStore/facts.js`):

- its links, one row each (`ws_links`: kind `path` or `name`, target), parsed
  by the same `linkRowsOf` the control plane and a move's rewrite run;
- its props (`ws_facts`): the front matter, inline tags, first heading, first
  paragraph, line count and website flags, exactly what `propsOf` gives, as
  JSON; `sealed` for an encrypted note, which keeps neither.

Both are keyed by the note's storage key, never its path, so a move (one row
change) carries a note's links with it, as the control plane renames a link
row's `source`.

**How they stay current.** No fill chain, no change log and no cursor: the
object holds the text, so a fact is read again whenever the note's stored etag
differs from the one it was read at, at the moment somebody asks. An answer is
never older than the text. One ask reads at most 2,000 changed notes; past
that it is not served and the control plane answers, while the notes read so
far stay read, so the next ask catches up.

**Who reads them.** The gateway's `treeFacts` (`apps/mcp/src/http/routing.js`)
asks the object first for `props` (`orient`'s folder descriptions,
`evaluate_lists`, `list_meetings`, `list_channel_days`, `list_contacts`),
`links` (a move's rewrite candidates) and `neighbors` (`related_notes`),
through `objectFirstFacts` (`apps/mcp/src/store/objectLookup.js`): the same
gate as the object's row lookups, so a session reads the object only where the
notes live there, its scope and audience are ones the object judges, and the
object is not behind the control plane (the binding's `notesBehind`, and the
behind check asked beside every call). Every path in an answer has passed the
object's `canSee` over its own rows and rules for that reader; a hidden note
is never named, and a hidden seed answers what a missing one does. Anything
the object does not serve (another ask, a failure, behind, not caught up) is
the control plane's, as before.

**The app's readers too.** The control plane's own readers that run as
actions read the object through its door (`ws.facts.rows`, unfiltered like
the internal queries they stand in for, each caller judging every path with
`canSee`; `apps/convex/functions/lib/nodes/objectFacts.ts`): a List's or
Board's front matter, the chaos score's extras and the map's links
(`lib/nodes/treeReads.ts`). Each falls back to the control plane's copy for
whatever the object does not answer, path by path for a List, so a row whose
push has not landed yet still shows.

A website's page lists and its share checks (`lib/websites/treeFacts.ts`,
`shareReadability.ts`, `lib/shares/readPath.ts`), routines' schedules
(`lib/routines/sync.ts`) and a console move's link candidates
(`lib/nodes/treeNames.ts`) do the same: the control plane's query still
decides which notes the reader may see and where each is (`publishedRows`
answers each note's real path, `at`), and the object answers what the note
says, read at its current text. So a routine edited a moment ago is never
left waiting on its props, and a website never shows a page's old front
matter.

**What has not moved yet.** The control plane still computes its copy
([convex-facts](../app-and-console/convex-facts.md)) for every workspace,
because a few readers read it inside queries and mutations, where the object
cannot be asked: shares' inbox titles, `references` and `nodeLinkSources`
(which notes hold links), a folder move's link renames (`folderLinks`), the
old-copies classifier, the outsider check and Tex triage. Moving those, then
stopping the control plane's fill for object-home workspaces and dropping its
rows there, is the next step. The asks that are not note facts stay on the
control plane: `names` (with note writes), `jobs` and `forwarding` (rows and
the ledger), and the chaos score's daily history (`nodeChaosDays`).

**What it changes about non-negotiable #1.** The control plane no longer is
the only keeper of a note's rebuildable facts: for an object-home workspace
the object holds them, as derivatives of the text beside them. Nothing here is
the only copy of anything, and the exit never reads it.

**Simplifying it** back to the control plane's copy for the gateway puts a
Convex round trip (and a fill that lags the text) in front of every List, move
and `related_notes` on a workspace whose text is one call away. Skipping the
etag check serves an edited note's old props; keying links by path loses a
moved note's links; skipping `sees` names private notes to a team reader.
**The tests that fail:** `apps/mcp/test/objectFacts.test.mjs` and
`apps/convex/__tests__/nodes/objectFacts.test.ts`.
