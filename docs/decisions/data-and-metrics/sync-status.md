# Every source says when it last synced, how many rows, and why it stopped

*2026-11-28, after GitHub's data source stopped silently for about 11 hours
on 2026-11-27. `apps/mcp/src/data/sync/object.js` (`syncLine`),
`apps/mcp/src/data/sync/aboutStatus.js`, and in the app `dataSync.ts` and
`SourcePage.tsx` under `apps/mobile/features/console/files/data/`.*

- **The last good sync is kept beside the last run.** The sync object keeps
  `synced: {at, rows}` from every run that came back ok, where rows are the
  rows the source's sheets hold after that run. A failed or stopped run keeps
  it, so a failure no longer erases when the source last synced.
- **One line per source**, from the object's `status` op: "Last synced:
  <time> · N rows", "Failed: <reason> (<time>)", "Stopped: <reason> (needs
  reconnecting)" for an app (or "needs starting again"), or "Not synced yet:
  started <time>". A re-arm or reconnect clears the stop. The line has words,
  times and counts only, never a key, an installation or a repository name.
- **Shown, never written.** An MCP read of a source's `about.md` carries the
  line as a `sync:` header line, asked of the workspace's own sync object for
  a note the reader was already let to read, and given up after 2 seconds. The
  Data page reads the same fields. The object does not rewrite `about.md`:
  it is a person-edited note with collaboration history, and a run's only
  write path is a conditional put of its sheets. An hourly rewrite would race
  editors and add an audit entry per source per hour.

**What a simplification would cost.** Keeping only the last run hides how
long a failing source has been failing. Writing the status into `about.md`
puts a non-person writer into a note people edit. Dropping the header line
leaves every agent that reads a source unable to see that it stopped, which
is how the 2026-11-27 stop went unnoticed. Test:
`apps/mcp/test/dataSyncStatusLine.test.mjs`.
