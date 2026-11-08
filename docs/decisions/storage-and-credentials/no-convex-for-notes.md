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

## The object pushes the change signal (2026-11-06)

A device that keeps a copy (the app's offline mirror) caught up when the control plane's change log moved
(`nodesFeed.head`), a copy written behind the object. The owner chose to keep a note's mail inside the note and have
the object push changes ("Keep in note, push from object", 2026-11-06), so the cue now comes from the object itself.

A tree socket may ask for the workspace's **head** (`{t: "watch", folders, head: true}`, `packages/shared/src/treeFrames.cjs`).
The object answers `{t: "head", token}` at once and again whenever the token moves (`workspaceStore/treeHead.js`).
The token is a digest of what that reader may see: each visible note's path and version, and the rules' version. So
it moves on a save, a mail line (it is the note's text), a new, moved or removed note, or a rules change, and never
on a change the reader may not see. It is the same on a new socket when nothing changed, so the socket's
re-authorization every five minutes costs no catch-up. Writes are gathered for a second before heads are worked out,
and readers with the same clearance share one digest.

The app follows each workspace's head over one socket (`apps/mobile/features/offline/objectHeads.ts`, `useNodeFeed.ts`)
and subscribes to `nodesFeed.head` only for a workspace whose object says it does not serve. The catch-up a moved
head starts still reads the change log (`nodesFeed.changes`); a row the mirror has not yet carried there arrives with
a later sequence and is picked up by the next catch-up, never lost. Moving the catch-up into the object is next.

A simplification that dropped the reader's judgment from the digest would tell a member, by timing, that a note they
may not see had changed. `apps/mcp/test/workspaceTree.test.mjs` ("a socket that asks for the head…") fails if it does,
and `apps/mobile/__tests__/objectHeads.test.ts` fails if a workspace the object stops serving is not handed back.

## What a simplification would cost

Putting the fallback back turns one busy minute into a feedback loop on the same object, and serves rows Convex may
no longer keep up to date. `apps/mcp/test/objectLookup.test.mjs`, `objectManifest.test.mjs`, `objectFacts.test.mjs`,
`namesTaken.test.mjs`, `objectChildren.test.mjs` and `workspaceMarks.test.mjs` fail if a failure or a behind answer
reaches the control plane again. `callCounts.test.mjs` fails if a tool stops saying busy.
