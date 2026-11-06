# The forwarding ledger is read from the workspace object (2026-11-06)

Asked for on 2026-11-06 while getting read tools under 0.1 s. In production over the last 24 hours, 58 of ChatGPT's
139 `fetch` calls named a path that was not there (an old link, a path written down before a move), and each then
waited a median 722 ms on `/gateway/tree/facts` with `ask: "forwarding"` for the forwarding ledger
(`apps/mcp/src/forwarding.js`). That put ChatGPT's fetch median at 855 ms at the server, against 255 ms for Claude.
Every other fact a read asks was already answered by the object (`OBJECT_FACT_ASKS`); the ledger was the one still
asked of the control plane on every miss. It fits the decision that a workspace's rows live in its object
([workspace-objects](./workspace-objects.md), [facts-in-objects](./facts-in-objects.md)).

## What changes

For a workspace whose notes live in its object (home `object`):

- **The object keeps a copy of the ledger** (`apps/mcp/src/workspaceStore/forwardingRows.js`): one row, the whole
  ledger (at most `FORWARDING_ENTRY_CAP` entries, a few tens of kilobytes) and the version it was sent at.
- **The control plane sends it, whole, behind every change.** Every recorder still writes the control plane's rows
  (`forwardingEntries`) through `smallData.recordForwarding`, by the same `addForwarding` rules, and those rows still
  write the export's `.context/forwarding.json`. Each change moves the ledger's version (`markChanged`), which
  schedules `smallDataObject.sendLedger`: the whole ledger and that version through the gateway's door as
  `ws.forwarding.put` (`apps/convex/functions/lib/smallData/objectLedger.ts`). The bucket import sends it too, and
  now moves the version whenever the file brought entries in.
- **A send is kept only at a version at least the one held**, so two sends that land out of order leave the newer.
  Sending whole, rather than each move, means a send that fails is repaired by the next one, and there is no second
  copy of the collapsing rules to drift.
- **`ask: "forwarding"` is answered by the object**, judged like the control plane's branch in
  `lib/nodes/gatewayFacts.ts`: an entry whose old path the reader may not see is left out; one whose new path it may
  not see is served with `to: null` ("moved somewhere you cannot see"). A folder entry is judged as the listing shows
  the folder, a note's as a read. With no rules held, it is not served.
- **The migration is the first send.** An object that holds no ledger yet answers `{served: false}`; the gateway then
  asks the control plane as before, whose answer asks for a send (`smallData.request` with `objectLedger: true`). So
  every workspace's existing ledger moves into its object the first time a read misses there, and every one with a
  move recorded after this change moves at that move. A workspace nobody reads keeps it in the control plane until
  then, which costs nothing.

## What it does not change

The control plane stays the ledger's writer and the export's source for now. Its own readers (a share's entry note,
the console's activity, a move's rewrite inside a Convex action) still read its rows. Making the object the writer
means moving those readers too; it is the next step, not this one.

Nothing here is the only copy of anything. Drop the object's table and every read falls back to the control plane
until the next send; drop the ledger and a stale link stops resolving, which is what the ledger has always promised
(`forwarding.js`, rule 4).

## Simplifying it

Reading the ledger from the control plane again puts the 720 ms back on every miss. Sending each move instead of the
whole ledger needs the object to run the collapsing rules over a copy that can miss a move, and a missed move would
never be repaired. Keeping a send regardless of its version lets a late, older send undo a newer move. Skipping
`sees` names a private note's old path to a team reader.

**The tests that fail:** `apps/mcp/test/objectForwarding.test.mjs` (judging, versions, homes, isolation, the gateway
reading the object and not the control plane) and `apps/convex/__tests__/smallDataObject.test.ts` (a move sends the
whole ledger at its version, only for an object-home workspace; a read the object did not answer sends it).
