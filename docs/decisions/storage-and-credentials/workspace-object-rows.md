# Every row write reaches the workspace object (2026-11-01)

A workspace whose notes are judged in its object (`workspaceObjectHomes.home === "object"`) has its tree rows and
access rules copied there, and the object decides reads by them. Convex keeps taking the writes, from more than
thirty places, and a Convex query or mutation cannot call the object.

**Decision.** No writer is trusted to remember. Every mutation in the deployment is built by
`apps/convex/functions/lib/rowWatch/mutations.ts`, which watches the mutation's database: each write to `nodes`,
`nodeAccess` or `nodeAccessState` is recorded, and when the handler returns, each object-mode workspace it touched
gets one outbox entry in the same transaction and a scheduled push (`functions/workspaceObjectPush.ts`). One drain
holds a workspace at a time (a lease), reads the named rows as they stand (paths built from parents), renders the
member and guest rules, and sends rows, removals and rules in one `ws.apply`, so a moved folder is never judged by
the old rules. The object keeps a row only from a newer clock and rules only from a newer access version; an entry
leaves the outbox only after the object took it. Actions that move, hide or narrow (app file operations, the
gateway's `setAccess`, removals, moves) wait for the push before answering (`objectSettled`). Public mutations the
app calls directly (`nodesAccess.setGrantees`) cannot wait, so the gap is closed on the read side: while any entry
waits, every binding the gateway opens carries `notesBehind`, and that request's lookups go to the control plane,
which already has the change. A share taken back is never served from the object's older rows
(`__tests__/workspaceObjectPush.test.ts`, "a share taken back by the app's own mutation…").

**What a simplification would cost.** Importing `mutation` from `_generated/server` again, or hooking writers one by
one, lets one missed writer narrow access in Convex while the object goes on showing the note.
`__tests__/rowWatchGuard.test.ts` refuses any file that builds a mutation around the wrapper;
`__tests__/workspaceObjectPush.test.ts` proves a narrowing and a one-row folder move reach a real object through the
real door, and that a failed push keeps its entries.
