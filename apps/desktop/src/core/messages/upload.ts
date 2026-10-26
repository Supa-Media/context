/**
 * Sending backup records to the gateway.
 *
 * Records are split into batches the contract allows (`LIMITS` in
 * `@context/communications/backup`) and posted one after another; the first
 * batch that is not kept ends the upload, and the pass keeps its cursor where
 * it was. A batch the gateway kept twice is folded to one copy there, so
 * sending again after a half-finished upload costs bytes and nothing else.
 *
 * The rules `core/sync/client.ts` keeps for meetings hold here too: the
 * credential goes in a header and nowhere else, no message text ever reaches
 * a log or an error, and an answer that is not the contract's JSON (a captive
 * portal's page) is retried rather than read as success.
 */

import { BACKUP_VERSION, LIMITS, MESSAGES_BACKUP_ROUTE } from "@context/communications/backup";
import type { UploadResult } from "./pass.ts";
import type { BackupRecord } from "./records.ts";

export interface BackupUploadConfig {
  /** The gateway origin this machine is connected to, no trailing slash. */
  baseUrl: string;
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Below the contract's body limit, for the envelope and for a client that counts differently. */
const BATCH_BYTES = Math.floor(LIMITS.bodyBytes * 0.85);

/** Records cut into batches no larger than the contract allows. */
export function batchesOf(records: readonly BackupRecord[]): BackupRecord[][] {
  const batches: BackupRecord[][] = [];
  let current: BackupRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = new TextEncoder().encode(JSON.stringify(record)).length + 1;
    if (current.length > 0 && (current.length >= LIMITS.records || bytes + size > BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** What a refusal means for the next attempt. Only these codes are ever reported; nothing the server wrote is passed on. */
export function classifyStatus(status: number): { retry: boolean; code: string } {
  if (status === 401) return { retry: false, code: "reconnect" };
  if (status === 403) return { retry: false, code: "not_allowed" };
  if (status === 404) return { retry: false, code: "not_available" };
  if (status === 413 || status === 400 || status === 422) return { retry: false, code: "refused" };
  if (status === 429) return { retry: true, code: "busy" };
  return { retry: true, code: "unavailable" };
}

export async function uploadBackupRecords(config: BackupUploadConfig, records: readonly BackupRecord[]): Promise<UploadResult> {
  const doFetch = config.fetch ?? fetch;
  for (const batch of batchesOf(records)) {
    const token = await config.token();
    if (token === null) return { ok: false, retry: false, code: "reconnect" };
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 60_000);
    const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(`${config.baseUrl}${MESSAGES_BACKUP_ROUTE}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ v: BACKUP_VERSION, records: batch }),
        signal,
      });
    } catch {
      return { ok: false, retry: true, code: "offline" };
    }
    if (!response.ok) return { ok: false, ...classifyStatus(response.status) };
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      return { ok: false, retry: true, code: "unavailable" };
    }
    if ((answer as { ok?: unknown })?.ok !== true) return { ok: false, retry: true, code: "unavailable" };
  }
  return { ok: true };
}
