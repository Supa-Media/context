import { eventsFromHistory, type HistoryEntry } from "./convert";
import { decodeStoredReads, eventsFromStoredReads, type StoredRead } from "./storedReads";
import type { MapEvent } from "./types";

/**
 * One workspace's history for a replay, in one ask of its gateway:
 * `GET /agent-activity?history_since=&history_until=`, which answers the lines
 * of `activity.md`, the change records older than it and what AI clients read,
 * already filtered for the viewer, from the workspace's own index.
 *
 * The same request carries `reads_since`/`reads_until`, so a gateway from
 * before the history parameters answers with the reads it always gave; the
 * answer then has no `history`, and the lines come from the control plane
 * (`files.listActivity`) as they did before.
 */

export type ReplayHistoryDeps = {
  /** The gateway's origin, or null where there is none to ask. */
  origin: string | null;
  mint(workspaceId: string): Promise<{ accessToken: string }>;
  fetchJson(url: string, token: string): Promise<unknown | null>;
  /** The control plane's `activity.md` lines since `since`: the older gateway's path. */
  listActivity(workspaceId: string, since: number): Promise<readonly HistoryEntry[]>;
};

export type DecodedHistory = { entries: HistoryEntry[]; reads: StoredRead[]; complete: boolean };

/** The answer's `history`, re-checked field by field; `null` when there is none (an older gateway). */
export function decodeHistory(body: unknown): DecodedHistory | null {
  const history = (body as { history?: unknown } | null)?.history as Record<string, unknown> | undefined;
  if (!history || typeof history !== "object" || !Array.isArray(history.entries) || !Array.isArray(history.reads)) {
    return null;
  }
  const entries: HistoryEntry[] = [];
  for (const raw of history.entries as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.at !== "string" || typeof raw.kind !== "string" || !Array.isArray(raw.paths)) continue;
    const paths = (raw.paths as unknown[]).filter((path): path is string => typeof path === "string" && path !== "");
    if (paths.length === 0) continue;
    const moves = Array.isArray(raw.moves)
      ? (raw.moves as unknown[]).filter(
          (pair): pair is [string, string] =>
            Array.isArray(pair) && pair.length === 2 && pair.every((path) => typeof path === "string"),
        )
      : undefined;
    entries.push({
      at: raw.at,
      kind: raw.kind,
      paths,
      by: typeof raw.by === "string" ? raw.by : null,
      via: typeof raw.via === "string" ? raw.via : null,
      ...(moves && moves.length ? { moves } : {}),
      ...(raw.agent === true ? { agent: true } : {}),
    });
  }
  return { entries, reads: decodeStoredReads({ reads: history.reads }), complete: history.complete === true };
}

/** `[from, to]` for one workspace, or what could be had: a failure adds nothing rather than failing the replay. */
export async function workspaceHistory(
  deps: ReplayHistoryDeps,
  workspaceId: string,
  from: number,
  to: number,
): Promise<MapEvent[]> {
  const fromControlPlane = async () => {
    try {
      return eventsFromHistory(await deps.listActivity(workspaceId, from), workspaceId);
    } catch {
      return [] as MapEvent[];
    }
  };
  if (deps.origin === null) return await fromControlPlane();
  let body: unknown | null;
  try {
    const grant = await deps.mint(workspaceId);
    const window = { since: String(Math.floor(from)), until: String(Math.floor(to)) };
    const query = new URLSearchParams({
      history_since: window.since,
      history_until: window.until,
      reads_since: window.since,
      reads_until: window.until,
    });
    body = await deps.fetchJson(`${deps.origin}/agent-activity?${query}`, grant.accessToken);
  } catch {
    body = null;
  }
  const history = decodeHistory(body);
  if (history !== null) {
    return [...eventsFromHistory(history.entries, workspaceId), ...eventsFromStoredReads(history.reads, workspaceId)];
  }
  // An older gateway: its reads came back in this same answer.
  return [...(await fromControlPlane()), ...eventsFromStoredReads(decodeStoredReads(body), workspaceId)];
}

/** One local day of a workspace's history: its local midnight, and how many lines and reads it holds. */
export type HistoryDay = { at: number; count: number };

export type HistoryDays = { days: HistoryDay[]; startsAt: number | null };

/** `YYYY-MM-DD` as that day's local midnight, or NaN. */
function localMidnight(day: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return NaN;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

/** The answer's per-day summary, re-checked; `null` when there is none (an older gateway). */
export function decodeHistoryDays(body: unknown): HistoryDays | null {
  const answer = body as { historyDays?: unknown; historyStartsAt?: unknown } | null;
  if (!answer || !Array.isArray(answer.historyDays)) return null;
  const days: HistoryDay[] = [];
  for (const raw of answer.historyDays as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.day !== "string" || typeof raw.count !== "number" || !(raw.count > 0)) continue;
    const at = localMidnight(raw.day);
    if (Number.isFinite(at)) days.push({ at, count: Math.floor(raw.count) });
  }
  const startsAt = typeof answer.historyStartsAt === "number" && Number.isFinite(answer.historyStartsAt) ? answer.historyStartsAt : null;
  return { days: days.sort((a, b) => a.at - b.at), startsAt };
}

/**
 * One workspace's per-day summary since its history began
 * (`GET /agent-activity?history_days=1&tz_offset_min=`), counted in this
 * device's own days; `null` when the gateway does not answer it.
 */
export async function workspaceHistoryDays(
  deps: Pick<ReplayHistoryDeps, "origin" | "mint" | "fetchJson">,
  workspaceId: string,
  tzOffsetMin: number = -new Date().getTimezoneOffset(),
): Promise<HistoryDays | null> {
  if (deps.origin === null) return null;
  try {
    const grant = await deps.mint(workspaceId);
    const query = new URLSearchParams({ history_days: "1", tz_offset_min: String(Math.round(tzOffsetMin)) });
    return decodeHistoryDays(await deps.fetchJson(`${deps.origin}/agent-activity?${query}`, grant.accessToken));
  } catch {
    return null;
  }
}

/** Several workspaces' summaries as one: counts added per day, the earliest start. */
export function mergeHistoryDays(answers: ReadonlyArray<HistoryDays | null>): HistoryDays {
  const counts = new Map<number, number>();
  let startsAt: number | null = null;
  for (const answer of answers) {
    if (answer === null) continue;
    for (const day of answer.days) counts.set(day.at, (counts.get(day.at) ?? 0) + day.count);
    if (answer.startsAt !== null && (startsAt === null || answer.startsAt < startsAt)) startsAt = answer.startsAt;
  }
  const days = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at, count }));
  return { days, startsAt };
}
