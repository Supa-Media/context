# The app names its workspace in the address, and every route word is reserved

Decided by the owner, 2026-11-09.

**What broke.** The gateway's front door reads the first part of an address as
a workspace name (`/@seyi/...` or `/seyi/...`) unless that word is on its list
of route words (`apps/mcp/src/workspacePath.js`, `RESERVED_FIRST_SEGMENTS`).
The app's delete, restore, move, rename, copy and duplicate were sent to
`/files/trash` and the rest from 2026-11-02, and `files` was never on the list.
Every one of them asked a workspace called `files` for `/trash`, got 404
`not_found`, and the app showed "That note is not there any more". The app's
search bar, `/app/search`, had the same fault and quietly fell back to the
control plane's search. It was the fifth time a route word was missed
(`meetings`, `agent`, `approvals`, `machines`), each time with a green suite,
because each route's tests call its handler directly.

**Decision.**

1. **The app names its workspace in the address.** A file operation goes to
   `/@<slug>/files/trash` (`apps/mobile/features/console/files/objectFileOps.ts`,
   `objectFileOpUrl`), so the address says which workspace it acts on, as every
   other workspace address does. The token still decides what the caller may
   reach; the name only selects.
2. **Every route word is reserved anyway**, so a bare address (an app already
   open, a client that does not know the slug) is never read as a workspace.
3. **The route table is held to the list by a test.**
   `apps/mcp/test/routeWords.test.mjs` lists every route set the front door
   dispatches on and fails when any path in it is split off as a workspace, or
   when a reserved word is a handle a person could claim in the control plane
   (`apps/convex/functions/lib/names.ts`). A new route set goes in that list.
4. **The routes are tested through the front door.**
   `apps/mcp/test/fileOpsFrontDoor.test.mjs` sends the app's own requests to
   `worker.fetch`, with and without the workspace in the address, against a
   workspace object holding the note, and checks the note left its name.
5. **Each is counted under its own name** (`files`, `app` in
   `observability/callCounts.js`), addressed to a workspace or not, so a
   failure shows instead of hiding under `other`.

**What a simplification costs.** Dropping a word from the list, or a route set
from the guard, brings back a route that answers 404 for everyone while its
own tests pass. The sabotage is recorded in both test files.
