# App and console — folder icons, emoji names and forwarding move into the control plane

### Folder icons, a workspace's emoji names and the forwarding ledger live in Convex, and the bucket keeps the files

*Decided by the owner, 2026-10-14*: only opening or editing a note reads the
bucket, with no fallbacks. Three small records were still read from it on
request paths that do neither: `.context/folder-icons.json` on every listing
that draws icons, the image store's `emoji-*` objects on every emoji list and
every published page, and `.context/forwarding.json` on every `read_note`
miss, every search hit that had moved, every activity line and every share
read. They follow the tree and the privacy rules into Convex
([convex-tree](./convex-tree.md), [convex-facts](./convex-facts.md)).
Activity and proposals are out of scope and still read their files.

**What moves** (`apps/convex/functions/lib/schema/smallData.ts`, all keyed by
`workspaceId`):

- `folderIcons`: one row per folder or note with an icon. A `null` icon is a
  removal made before the import, kept so the import does not bring it back.
- `customEmoji`: one row per emoji, its name and the leaf its picture is
  stored under. **The pictures stay in the bucket's image store**; only the
  names move.
- `forwardingEntries`: the ledger, oldest first (`seq`), recorded, collapsed
  and capped by the same `addForwarding` (`apps/mcp/src/forwarding.js`).
- `smallDataState`: whether the import ran, a version and an exported version
  for each file, and the sync lease.

**The files are write-only mirrors.** Every change writes Convex first and
owes the file a write (`markChanged`); one sync at a time
(`lib/smallData/sync.ts`, lease `SMALL_DATA_SYNC_LEASE_MS`) writes
`.context/forwarding.json` and `.context/folder-icons.json` from the rows in
the same format as before, and nothing reads them back. A change made while a
sync runs moves the version, and the sync goes round again. The cron
(`nodesMigration.keepCurrent`) asks for a sync for every bound workspace, so
an export a failure left owed is retried. So the exit is unchanged: the bucket
still holds the ledger, the icons and every emoji picture, in the formats a
self-hosted gateway reads. There is no emoji list file; the pictures are the
record a self-hosted gateway or an export uses, as before. The one thing that
can be briefly only in Convex is a change whose file write is still owed,
which is the same window `privacy.md` has as an export.

**The one-time import.** The first sync of a workspace reads the three
records from its bucket once (`readBucketSmallData`) and merges them into what
Convex already holds, **never over a newer value**
(`lib/smallData/importing.ts`): the file's ledger with every move Convex
recorded replayed after it, so a chain the file began collapses; a file icon
only where Convex has no row, carried through the moves Convex recorded first;
an emoji only for a name with no row. It is idempotent (a workspace already
imported is left alone) and resumable (a failed sync releases its lease and
the next change, list or cron tries again). It is started by the first change,
the first `folderIcons.list` or `emoji.list`, the first forwarding ask, or the
cron.

**Until a workspace's import finishes, reads answer from what Convex holds.**
There is no bucket fallback: a workspace that has not been imported yet lists
no icons and no emoji of its own, and forwards no stale path, until the sync
has run (seconds after the first read asks for it). That is the deliberate
price of "no fallbacks".

**Who reads what.**

- The console's icons (`folderIcons.list`/`set`) and emoji (`emoji.list`,
  `read`, `add`, `rename`, `remove`, Slackmojis import) answer from the rows;
  the rules come from the Convex tree, a folder's existence from the tree.
  An emoji picture is read from the bucket by the leaf its row names, checked
  against the name (`leafOf`), so a row can never reach another picture.
- A published website's emoji take their leaves from the rows.
- A share read forwards through `smallData.forward` (unfiltered, as the file
  was; the share re-reads the answer at `team` scope).
- The console's file operations (a move, archive, delete) record moves and
  carry icons through hooks the credential barrier attaches to the store
  (`lib/smallData/attach.ts`); the shared engines (`forwarding.js`,
  `folderIcons.cjs`) use the hook when present and the file when not.
- The gateway reads the ledger through `/gateway/tree/facts` with
  `ask: "forwarding"`, filtered at the grant's clearance: an entry from a path
  the reader may not see is absent, and one to such a path says `to: null`,
  which `forwardPath` treats as "moved out of sight" and every caller as not
  found. A folder entry is judged by the folder rule a listing uses. A queued
  move asks with its job ticket while it holds the lease and gets the whole
  ledger (it runs at `private`). Every refusal is `{ served: false }`, the same
  bytes as a tree that does not serve. Moves and icon moves are recorded
  through `/gateway/tree/touch` (`forwarding`, `icons`, 100 a request),
  awaited so the next read follows the move.
- A gateway with no control plane (self-hosted, the gateway's test stub) has
  no hooks, and the files stay its record exactly as before.

**Storage moves and deletion.** Deleting a workspace's tree purges every row,
in batches (`purgeSmallDataBatch`). Moving its storage to another bucket keeps
the icons and the ledger (they are the workspace's decisions, not a
description of the old bucket), drops the emoji rows (they name the old
bucket's pictures), and imports the new bucket's records, then writes the
merged files there.

**What this reverses.** [Custom emoji](./custom-emoji.md) chose "no list
file, no table, so one copied in by hand appears". The names are now a table;
a picture copied into the image store by hand appears only through the
import, which runs once per bucket. The bucket still describes itself for an
export and a handover.

**What a simplification of this costs.** Reading the file when Convex has no
answer yet puts the bucket back on every request path this removed. Answering
the gateway the whole ledger names private paths to a team reader. Letting
the import overwrite a row brings back an icon somebody removed, or undoes a
move. Dropping the file writes breaks the exit.

**The checks.** `apps/convex/__tests__/files/smallData.test.ts` (end to end:
no file read on list or set, the files written behind, the import's merge
rules, a stranger answered as a missing workspace, purge and storage move),
`__tests__/folderIcons.test.ts` (the rows carried by moves without reading
the file; a member never sees a private folder's icon),
`__tests__/nodes/gatewayFacts.test.ts` (the filtered ledger, the ticket, every
refusal the same bytes), `__tests__/customEmoji.test.ts` (a row's leaf never
reaches another picture), and the gateway's `test/smallDataHooks.test.mjs` (no
file read with the hooks, a hidden trail not found, an activity line about it
absent). Each names the sabotage it was checked against.
