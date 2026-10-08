# One active worker per logical move

Decided 2026-10-08. Large folder moves keep their state in the bucket move
marker. The control plane holds only a ticket, workspace identity, move ID,
status, and counts. Creating a second ticket while one is queued or leased
runs two materializers against the same marker and can report conflicting
progress.

The control plane coalesces live tickets by workspace and move ID. A stale
queued ticket may be replaced after five minutes, or a running one after its
lease; the replaced row is retired so a delayed message cannot start it.
When the durable queue accepts a new move, the request does not also launch
its own deferred materializer. A deferred pass remains the fallback when
queueing is unavailable. This changes scheduling only; the bucket marker
remains the source of truth for bytes, privacy, and reference rewriting.
