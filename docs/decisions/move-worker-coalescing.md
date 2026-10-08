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

Within that one worker, cleanup may retire up to three independent source
objects concurrently. A pass waits for all started retirements, then saves
their settled results together in the marker; a failed item does not discard
the successful items or leave a write running after the checkpoint. Once all
captured sources are retired, verification reads them in checkpointed slices
of forty, rather than trying to re-read a multi-thousand-note folder in one
gateway request. A source found again re-enters cleanup. This changes worker
throughput and recovery bounds, not the logical cutover or its privacy rules.
