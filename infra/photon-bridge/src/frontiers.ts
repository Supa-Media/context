/**
 * Which stored checkpoints a container's reported frontiers should move. The
 * container's frontier can pass a sequence the object never acked (an unmapped
 * event, a skipped gap, a dropped old replay), so the object takes them too,
 * or a restart would replay that history. A checkpoint only moves forward.
 */

/** `reported` is the container's `/frontiers` body's `checkpoints`; anything malformed moves nothing. */
export function checkpointWrites(
  stored: Record<string, number>,
  reported: unknown,
): Record<string, number> {
  if (reported === null || typeof reported !== "object" || Array.isArray(reported)) return {};
  const writes: Record<string, number> = {};
  for (const [line, seq] of Object.entries(reported)) {
    if (typeof seq !== "number" || !Number.isSafeInteger(seq)) continue;
    const current = stored[line];
    if (current !== undefined && seq <= current) continue;
    writes[line] = seq;
  }
  return writes;
}
