/**
 * What Tex has spent on Browser Use, and the block log.
 *
 * One Durable Object holds both (`browserUseObject.ts`). Spend is what the
 * cap reads before a session starts, so two jobs cannot both pass it. The
 * log is the block rate: it outlives Cloudflare's sampled logs, and it keeps
 * hosts, outcomes and costs, never a path, a page, or a CDP url.
 */

import { browserUseLedgerStub } from "./idle";
import { browseLogRow, nyPeriod, summarizeBrowseLog, type BrowseLogRow, type BrowseLogSummary } from "./browserUsePolicy";

export interface LedgerKv {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface SpendRecord {
  day: string;
  dayUsd: number;
  month: string;
  monthUsd: number;
}

export interface OwnedSession {
  id: string;
  cdpUrl: string;
  host: string;
  started: number;
  outcome: BrowseLogRow["outcome"];
  reason?: BrowseLogRow["reason"];
  proxy?: BrowseLogRow["proxy"];
  charged: boolean;
}

const MAX_LOGS = 500;

export class BrowseLedger {
  constructor(
    private kv: LedgerKv,
    private now: () => number = Date.now,
  ) {}

  private async spendRecord(): Promise<SpendRecord> {
    const saved = await this.kv.get<SpendRecord>("spend");
    const period = nyPeriod(new Date(this.now()));
    if (!saved || typeof saved.dayUsd !== "number" || typeof saved.monthUsd !== "number") {
      return { day: period.day, dayUsd: 0, month: period.month, monthUsd: 0 };
    }
    return {
      day: period.day,
      dayUsd: saved.day === period.day ? saved.dayUsd : 0,
      month: period.month,
      monthUsd: saved.month === period.month ? saved.monthUsd : 0,
    };
  }

  async spent(): Promise<{ dayUsd: number; monthUsd: number }> {
    const spend = await this.spendRecord();
    return { dayUsd: spend.dayUsd, monthUsd: spend.monthUsd };
  }

  /** Add a stopped session's cost. A day or month that has rolled over starts again first. */
  async addSpend(usd: number): Promise<{ dayUsd: number; monthUsd: number }> {
    if (!Number.isFinite(usd) || usd < 0) throw new Error("browser-use cost");
    const spend = await this.spendRecord();
    const next = { ...spend, dayUsd: spend.dayUsd + usd, monthUsd: spend.monthUsd + usd };
    await this.kv.put("spend", next);
    return { dayUsd: next.dayUsd, monthUsd: next.monthUsd };
  }

  async record(raw: unknown): Promise<boolean> {
    const row = browseLogRow(raw, this.now());
    if (row === null) return false;
    const logs = (await this.kv.get<BrowseLogRow[]>("logs")) ?? [];
    logs.push(row);
    await this.kv.put("logs", logs.slice(-MAX_LOGS));
    return true;
  }

  async summary(): Promise<BrowseLogSummary & { dayUsd: number; monthUsd: number }> {
    const logs = (await this.kv.get<BrowseLogRow[]>("logs")) ?? [];
    const spend = await this.spent();
    return { ...summarizeBrowseLog(logs), ...spend };
  }

  async remember(owner: string, session: OwnedSession): Promise<void> {
    const sessions = (await this.kv.get<Record<string, OwnedSession>>("sessions")) ?? {};
    sessions[owner] = session;
    await this.kv.put("sessions", sessions);
  }

  async recall(owner: string): Promise<OwnedSession | null> {
    const sessions = (await this.kv.get<Record<string, OwnedSession>>("sessions")) ?? {};
    return sessions[owner] ?? null;
  }

  async forget(owner: string): Promise<void> {
    const sessions = (await this.kv.get<Record<string, OwnedSession>>("sessions")) ?? {};
    if (!sessions[owner]) return;
    delete sessions[owner];
    await this.kv.put("sessions", sessions);
  }
}

export interface LedgerNamespace {
  idFromName: (name: string) => DurableObjectId;
  get: (id: DurableObjectId, options?: { locationHint?: "enam" }) => LedgerStub;
}

/** The methods the object exposes. A test passes a plain object with the same shape. */
export interface LedgerStub {
  spent(): Promise<{ dayUsd: number; monthUsd: number }>;
  addSpend(usd: number): Promise<{ dayUsd: number; monthUsd: number }>;
  record(row: unknown): Promise<boolean>;
  summary(): Promise<BrowseLogSummary & { dayUsd: number; monthUsd: number }>;
  remember(owner: string, session: OwnedSession): Promise<void>;
  recall(owner: string): Promise<OwnedSession | null>;
  forget(owner: string): Promise<void>;
}

export interface LedgerEnv {
  BROWSER_USE_LEDGER?: LedgerNamespace;
}

/** The one ledger, or null when this Worker has no binding (a test, a self-hoster). */
export function ledgerStub(env: LedgerEnv): LedgerStub | null {
  return browserUseLedgerStub(env.BROWSER_USE_LEDGER);
}

/** Writes a row. A failure is logged and swallowed: the browse itself still answers. */
export async function safeRecord(env: object, row: unknown): Promise<void> {
  const stub = ledgerStub(env as LedgerEnv);
  if (!stub) return;
  try {
    await stub.record(row);
  } catch {
    console.log(JSON.stringify({ event: "site_shots_browse_log_failed" }));
  }
}

export async function blockSummary(env: LedgerEnv): Promise<BrowseLogSummary & { dayUsd: number; monthUsd: number }> {
  const stub = ledgerStub(env);
  if (!stub) return { ...summarizeBrowseLog([]), dayUsd: 0, monthUsd: 0 };
  return await stub.summary();
}

/** A gateway job row. Invalid rows are dropped. */
export async function acceptBrowseLog(env: LedgerEnv, body: unknown): Promise<{ ok: boolean }> {
  const row = browseLogRow(body);
  if (row === null || row.kind !== "job") return { ok: false };
  await safeRecord(env, row);
  return { ok: true };
}
