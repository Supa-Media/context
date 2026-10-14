# App and console — notes' links and front matter move into the control plane

### Each note's links, front matter and chaos history live in Convex beside its row

*Decided by the owner, 2026-10-13* ("let's move the front matter, keep it on
the same row, but update the readme about this, no need to surface in the app
as it doesn't change anyone's experience"), after the sweep of what still read
the workspace's own database once the tree moved into Convex
([convex-tree](./convex-tree.md)).

**Why.** With the tree in Convex, the per-workspace database (D1) still kept
three things the app read on every map, List and chaos figure: which note
links to which (`tree_links`), each note's front matter (`tree_props`), and
the chaos score's daily history (`chaos_daily`). Each was filled by a chain
that walked the database's *own* copy of the tree to find what had changed,
so the database's tree could not be retired, and a change reached the map or
a List only after that copy had caught up. Convex already logs every row
change (`nodeLog`), so the facts can follow that log instead, and one read of
a note fills both its links and its front matter.

**What moves, and what that changes about the rules.**

- **Into the control plane, as disposable derivatives of each note:**
  - its links, one row each in `nodeLinks` (`source`, `kind` path or bare
    name, `target`), parsed by the same `linkRowsOf` a move's rewrite runs;
  - on its own `nodes` row, `props`: the front matter, the first heading, the
    first paragraph, inline tags and the line count, exactly what
    `propsOf` gave the D1 table and what a List or Board card shows; `parsed`,
    the version it was read at; `sealed` for a note whose text could not be
    read, which keeps neither props nor links; `chaosNote` on the few notes
    the chaos score needs more than a key for;
  - the chaos score's closing number per day (`nodeChaosDays`, 35 days, both
    audiences).

  This **amends non-negotiable #1**: the control plane now holds, beside
  names, these few derived fields of each note. It still never holds a note's
  body, an attachment, collaboration history, or anything that is the only
  copy: every field is rebuilt from the bucket by the fill, and deleting them
  all loses nothing. A row larger than 32 KB of props keeps none and is read
  from the bucket by its List, as before.
- **Unchanged:** the bucket is canonical; the exit (download, hand-off, own
  bucket) never reads any of this; who may see a link or a prop is decided at
  read time by `canSee` and never stored. The facts leave with the
  workspace's rows (`nodesPurge`).
- **Managed encryption** seals bodies in the bucket. Like the D1 table
  before it, the props are plain where they are kept, in a store encrypted
  at rest by its provider; that is the trade the owner accepted for Lists
  that open without a bucket read.

**How the facts follow the tree** (`apps/convex/functions/lib/nodes/facts.ts`,
`factFill.ts`, `functions/nodeFacts.ts`). A first fill walks every note once,
noting where the change log stood when it began. After that each pass reads
the log past its cursor (re-reading the last minute, for appends that
committed late) and reads again only the notes whose row's version differs
from the one their facts were read at. A pass runs inside the credential
barrier (`nodesFactFill`), right after the re-check a change triggers, after
every finished sweep, and from the 15-minute cron wherever the facts are
behind. One pass holds the fill at a time; a read that fails is retried and
counted as unparsed meanwhile; a log too old to reach starts a fresh walk.

**Who reads them.**

- **The map** reads `nodeLinks` once the facts are whole
  (`lib/nodes/linkTable.ts`), notes changed since counted as "catching up".
- **Lists and Boards** read each note's props from its row
  (`factPropSource`); a stale row is read again from the bucket, never served.
- **The chaos score** in the app and in `orient` reads the long notes and
  contact reviews by index, and "a week ago" from `nodeChaosDays`; the first
  read carries the database's days over once.
- **A move's link rewrite** in the gateway asks `/gateway/tree/facts` for the
  notes pointing at what moved (`tree/facts.js`), filtered by `canSee` at the
  grant's clearance.

Each fell back to the D1 table, then to the bucket, while the facts were not
whole. Since phase 7 of the tree migration (2026-10-13) the D1 tables are
gone, and a reader the facts cannot answer yet does what a workspace with no
search database always did: a List reads its folder from the bucket, the map
draws from the search index, and the chaos score says nothing until the
facts are whole. A write's chaos report is counted from the tree's keys and
the facts (`apps/mcp/src/chaos/change.js`).

**What a "simplification" would cost.** Keeping the facts in D1 keeps the D1
tree alive only to tell the fills what changed. Storing who may see a link or
a prop would let a rules change leave a stale answer behind. Serving a prop
read at another version than the row's would show a List an edit late.

**Tests.** `apps/convex/__tests__/nodes/nodeFacts.test.ts` (the fill: first
walk, only the changed note re-read, a gone note's links dropped, a read the
note outran not recorded, a failed read retried, one pass at a time, a move's
candidates, isolation); `servedReaders.test.ts` (a List and the map from the
facts answer what the bucket's answer, at every clearance, a moving folder
too); `servedChaos.test.ts` (the chaos score from the
facts); `gatewayFacts.test.ts` (the
gateway route answers at the grant's clearance, and every refusal is the same
bytes); `nodesPurge.test.ts`, `nodesMigration.test.ts`; and
`apps/mcp/test/treeFacts.test.mjs` (the gateway's rewrite and orient read the
facts and fall back when they cannot).
