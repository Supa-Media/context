/**
 * The app's side of the data sync object (`apps/mcp/src/data/sync/route.js`): arming a Fetch from a URL source,
 * and asking how each one's last run went, through the gateway's `POST /@slug/files/data-sync` with the console's
 * own grant (as `gatewayNoteWrite.ts` saves a note).
 *
 * The gateway decides everything: who may arm (an owner or editor), which sources the reader may ask about (only the
 * ones whose about.md they can read), and whether the address is one it will fetch. This file only sends and reads.
 * Pure apart from `fetch`; fields are read by name, never spread.
 */

import type { SyncState } from "./words";

export const DATA_SYNC_PATH = "/files/data-sync";
const TIMEOUT_MS = 30_000;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** One run, as the sync object keeps it: when, how it went, and the plain sentence when it did not. */
export interface SyncRun {
  readonly at: number;
  readonly outcome: "ok" | "failed" | "stopped";
  readonly said?: string;
  readonly rows?: number;
}

export interface SourceSync {
  /** The source's about.md path. */
  readonly about: string;
  /** Whether it runs every hour now. */
  readonly armed: boolean;
  readonly last: SyncRun | null;
}

/** `POST /@slug/files/data-sync` on the gateway that serves `mcpEndpoint`, or `null`. */
export function dataSyncUrl(mcpEndpoint: string, slug: string | null | undefined): string | null {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/@${slug}${DATA_SYNC_PATH}`;
}

function runOf(value: unknown): SyncRun | null {
  if (!value || typeof value !== "object") return null;
  const { at, outcome, said, rows } = value as Record<string, unknown>;
  if (typeof at !== "number" || !Number.isFinite(at) || (outcome !== "ok" && outcome !== "failed" && outcome !== "stopped")) return null;
  return { at, outcome, ...(typeof said === "string" ? { said: said.slice(0, 500) } : {}), ...(typeof rows === "number" && Number.isFinite(rows) ? { rows } : {}) };
}

/** One source's answer, or null for one this build cannot read. */
export function readSourceSync(value: unknown): SourceSync | null {
  if (!value || typeof value !== "object") return null;
  const { about, armed, last } = value as Record<string, unknown>;
  if (typeof about !== "string" || about === "") return null;
  return { about, armed: armed === true, last: runOf(last) };
}

/** What a source's status line reads (`words.ts` `sourceStatus`) from its sync's last run. */
export function syncStateOf(sync: SourceSync | undefined): SyncState {
  const last = sync?.last ?? null;
  if (last === null) return { known: sync !== undefined };
  return {
    known: true,
    ...(last.outcome === "ok" ? { syncedAt: last.at } : { failedAt: last.at }),
    ...(last.outcome === "stopped" || sync?.armed === false ? { stopped: true } : {}),
    ...(last.said === undefined ? {} : { said: last.said }),
    ...(last.rows === undefined ? {} : { rows: last.rows }),
  };
}

export type DataSyncAnswer = { ok: true; sources: SourceSync[] } | { ok: false; said: string };

/**
 * One call with the console grant: refused once, re-minted once. `body` is `{op: "arm", about}` or
 * `{op: "status", about: [paths]}`; the workspace is named beside it.
 */
export async function callDataSync(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  workspaceId: string;
  body: { op: "arm"; about: string } | { op: "status"; about: readonly string[] };
  fetchImpl?: typeof fetch;
}): Promise<DataSyncAnswer> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const unreachable: DataSyncAnswer = { ok: false, said: "Context couldn't reach the sync just now. Try again." };
  if (typeof doFetch !== "function") return unreachable;
  const payload = JSON.stringify({ workspaceId: options.workspaceId, op: options.body.op, about: options.body.about });
  const send = async (token: string) => {
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    const deadline = setTimeout(() => abort?.abort(), TIMEOUT_MS);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: payload,
        ...(abort === null ? {} : { signal: abort.signal }),
      });
      return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, unknown> | null };
    } finally {
      clearTimeout(deadline);
    }
  };
  let answer: { status: number; body: Record<string, unknown> | null };
  try {
    let token = await options.token(false);
    answer = await send(token);
    if (answer.status === 401) {
      token = await options.token({ rejected: token });
      answer = await send(token);
    }
  } catch {
    return unreachable;
  }
  const body = answer.body ?? {};
  if (answer.status === 200) {
    if (options.body.op === "arm") {
      const one = readSourceSync(body);
      return one === null ? unreachable : { ok: true, sources: [one] };
    }
    const list = Array.isArray(body.sources) ? body.sources.map(readSourceSync).filter((one): one is SourceSync => one !== null) : [];
    return { ok: true, sources: list };
  }
  if (typeof body.message === "string" && body.message !== "") return { ok: false, said: body.message.slice(0, 500) };
  if (answer.status === 403) return { ok: false, said: "Only this workspace's owners and editors can sync a source." };
  if (answer.status === 501) return { ok: false, said: "This deployment doesn't sync sources." };
  return unreachable;
}
