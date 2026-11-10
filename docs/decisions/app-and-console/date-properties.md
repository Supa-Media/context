# Date properties

## Context fills a note's date created and date modified itself (2026-11-10)

Dev2 asked (2026-11-10) that a note's `date created` and `date modified` fill
themselves. They used to fill only when the note was edited in Obsidian with
the Linter plugin; notes written in Context kept them empty.

**Opt-in, one key at a time.** Only a key the note's front matter already has is
filled, and a missing key is never added. The usual spellings count, in any
case: `date created`, `created`, `date_created`, `created_at` and `date
modified`, `modified`, `updated`, `date_modified`, `updated_at`. A key whose
value is a list, or words that are not a date ("by hand"), is left alone. Tex's
own folder (`tex/`) is left out: its skills keep an `updated:` Tex sets by its
own rule, and marking a skill used is not rewriting it.

**What each gets.** `created` is filled only while it is empty, from the note's
first save (its tree row's `created` clock), and never overwritten; with no
first-save time it waits rather than guessing. `modified` is set on every
content save, a person's or an agent's. A save that changes nothing but date
values is not content (`contentChanged`), so the stamp cannot set itself off.

**Format.** The note's own date values are copied first, then the format most of
the workspace's notes use (asked of its object by name only, never a value),
else ISO 8601 with the offset. Linter's `dddd, MMMM Do YYYY, h:mm:ss a` is
read and written exactly. Always the workspace owner's zone
(`/gateway/time-zone`, the account zone the app keeps in step with their
device), else the routines' default; never UTC, so a copied `Z` value is
written with its offset.

**When, on the server.** An agent's `write_note` is stamped in the same save,
so the etag it gets back covers the dates (no CONFLICT on its next write) and
the change log has one entry. A person typing saves about once a second, so
their saves are never stamped one by one: each content save waits three
seconds (`DATE_QUIET_MS`) behind its answer, and only the save still current
then stamps, as one collaboration edit that merges into open editors like an
agent's (the cursor does not move). That edit records no activity line and
sets off no wait of its own. A conflict means somebody else saved first; their
save stamps after its own pause.

**Backfill.** `manage` action `fill_dates` (owner only) is the one pass over
notes written before: the object names the notes with an empty date key
(`dateGaps`), and each is filled from its row's clocks, with `modified` from
its last save, not now. It reports how many it filled. Only a workspace whose
notes live in its object can be read this way.

Where it lives: `apps/mcp/src/notes/dateProperties.js` (the rules, pure text),
`notes/dateStamp.js` (when), `workspaceStore/dateFacts.js` (what the object
answers), `controlPlane/timeZone.js` and the Convex route in
`functions/lib/gatewayRoutes/routines.ts`.

**What a simplification would cost.** Stamping every collaboration save rewrites
front matter on every keystroke and doubles the change log; stamping an agent's
write afterwards hands it a stale etag; adding missing keys writes into notes
that never asked. `test/dateProperties.test.mjs`,
`test/datePropertiesWrite.test.mjs`, `test/objectDateFacts.test.mjs` and
`test/dateStamp.test.mjs` fail if any of these is reversed.
