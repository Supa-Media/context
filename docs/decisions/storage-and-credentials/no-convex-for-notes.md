# A busy workspace object says busy; nothing about a note falls back to Convex (2026-11-06)

On 2026-11-06 the owner decided: "we shouldn't be falling back to convex for anything note related, i'm not sure
convex is even up to date anymore". It came after one workspace object took 18,624 requests in a minute. Before this,
a read the object could not answer went to Convex (`store/objectLookup.js`, `store/objectManifest.js`). Convex then read
its tree from that same object through its door (`apps/convex/functions/lib/nodes/objectTreeStore.ts`), at about 2.3 s
a listing page. So every failure sent more work to the object that was already failing. When Convex gave up, its bare
`{served: false}` reached the agent as "malformed note id entries", and the note looked gone.

## What changes (first part)

For a workspace whose notes live in its object (`home: object`), the following are `WorkspaceBusy` and never sent to
the control plane:

- an object failure;
- an object still behind after its own wait (an open mark, `workspaceStore/marks.js`).

This covers the row lookup (writes and reads), note-id resolve, facts, writer names, `orient`'s survey, the agent
listing and the name guards' children. An AI client gets "this workspace is busy right now; try again in a few
seconds". A route gets a 503 `workspace_busy` with `Retry-After: 5`, which Tex's jobs already read past
(`apps/agent/src/machineTurn.ts` `passing`). The reason stays in the gateway's logs.

Behind still never serves the object's older rows. A share just taken back is not listed. The reader is asked to try
again, and is not given another store's answer.

A control-plane lookup that is not served now says `note id lookup not served`, not `malformed note id entries`.

## Still asked of the control plane, and moved next

These are questions the object can't yet settle on its own. They aren't failures:

- a built-in folder's default name (`inbox/…`) and a new note's Tex home (`workspaceStore/lookupMiss.js`);
- a row the object doesn't plainly hold (an ambiguous id, a key that isn't a note's);
- a check-in's `changedSince` listing (Convex's change index);
- the binding's `notesBehind` (an outbox entry still waiting), which sends the whole session to Convex's rows;
- a keyed write's `wrote` or a new note's `adopt` that the object defers or fails;
- the control plane's own tree reads through the door.

The next step moves each of these into the object, or removes it.

## What a simplification would cost

Putting the fallback back turns one busy minute into a feedback loop on the same object, and serves rows Convex may
no longer keep up to date. `apps/mcp/test/objectLookup.test.mjs`, `objectManifest.test.mjs`, `objectFacts.test.mjs`,
`namesTaken.test.mjs`, `objectChildren.test.mjs` and `workspaceMarks.test.mjs` fail if a failure or a behind answer
reaches the control plane again. `callCounts.test.mjs` fails if a tool stops saying busy.
