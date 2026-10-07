import { historyActor } from "./convert";
import type { MapEvent } from "./types";

/**
 * What AI clients read in a stretch of time, for a replay: one workspace's
 * `GET /agent-activity?reads_from=&reads_to=`, which the gateway answers from
 * the reads it keeps in the workspace's own bucket, already filtered for the
 * viewer. Named the way `activity.md` names a hand (`by`, `via`), so a tool
 * that read and then wrote is one face on the replay.
 */

export type StoredRead = { at: number; path: string; tool: string; by: string | null; via: string | null };

/** The answer's reads, re-checked field by field; anything else is no reads. */
export function decodeStoredReads(body: unknown): StoredRead[] {
  const reads = (body as { reads?: unknown } | null)?.reads;
  if (!Array.isArray(reads)) return [];
  const out: StoredRead[] = [];
  for (const read of reads as Array<Record<string, unknown>>) {
    if (!read || typeof read.path !== "string" || !read.path || !Number.isFinite(read.at)) continue;
    out.push({
      at: read.at as number,
      path: read.path,
      tool: typeof read.tool === "string" ? read.tool : "read_note",
      by: typeof read.by === "string" ? read.by : null,
      via: typeof read.via === "string" ? read.via : null,
    });
  }
  return out;
}

/** Stored reads as replay events, notes only (the map draws nothing else). */
export function eventsFromStoredReads(reads: readonly StoredRead[], workspaceId: string): MapEvent[] {
  return reads
    .filter((read) => read.path.endsWith(".md"))
    .map((read) => ({
      kind: "read" as const,
      at: read.at,
      workspaceId,
      path: read.path,
      // A stored read is always a tool's: the console's own reads are never kept.
      actor: { ...historyActor({ by: read.by, via: read.via ?? "AI" }), kind: "agent" as const },
    }));
}

export type StoredReadsDeps = {
  origin: string;
  mint(workspaceId: string): Promise<{ accessToken: string }>;
  fetchJson(url: string, token: string): Promise<unknown | null>;
};

/** One workspace's reads in `[from, to]`, or none when it cannot answer. */
export async function fetchStoredReads(
  deps: StoredReadsDeps,
  workspaceId: string,
  from: number,
  to: number,
): Promise<MapEvent[]> {
  try {
    const grant = await deps.mint(workspaceId);
    const query = new URLSearchParams({ reads_from: String(Math.floor(from)), reads_to: String(Math.floor(to)) });
    const body = await deps.fetchJson(`${deps.origin}/agent-activity?${query}`, grant.accessToken);
    return eventsFromStoredReads(decodeStoredReads(body), workspaceId);
  } catch {
    return [];
  }
}
