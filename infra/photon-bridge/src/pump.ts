/**
 * The delivery loop: take the container's oldest unacked event, hand it to the agent over RPC, and only then ack it
 * and store the line's frontier.
 *
 * Contract A: the agent's {status} 200 means queued, so the checkpoint may pass the event; a 4xx means refused, which
 * is logged and passed; a 5xx or a thrown call means "try again". Order is kept per chat, not per line (2026-11-25): a
 * chat whose event failed is retried with backoff while its later events wait behind it (the container skips that
 * chat), and every other chat keeps moving. Until then one members change the agent answered 503 held every text on
 * the line for as long as it failed. An event still failing after PARK_AFTER_MS is parked: kept in this object's
 * storage, acked so its chat moves on, logged as an alert, and offered again every PARK_RETRY_MS for PARK_KEEP_MS.
 * The container pulls and never pushes, so the retry is this object's, not the container's.
 */
import type { PhotonEvent } from "./contract";

export const CONTAINER_ORIGIN = "http://container";
export const LONG_POLL_MS = 25000;

/** The agent's PhotonEvents entrypoint, as the service binding exposes it. */
export interface AgentEvents {
  event(body: PhotonEvent): Promise<{ status: number }>;
}

export interface Fetchish {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface CheckpointStore {
  put(key: string, value: number): Promise<void>;
}

/** Where a parked event is kept: this object's storage (`index.ts`). */
export interface ParkStore {
  put(key: string, value: Parked): Promise<void>;
  list(prefix: string): Promise<Map<string, Parked>>;
  delete(key: string): Promise<unknown>;
}

/** An event that kept failing, kept so it can be offered again. */
export type Parked = { item: QueuedEvent; parkedAt: number; triedAt: number };

export type Log = (record: Record<string, unknown>) => void;
export type Sleep = (ms: number) => Promise<void>;

/** What the container hands over: the event and the line and sequence it came from. */
export interface QueuedEvent {
  id: string;
  line: string;
  /** Photon's sequence; null for an event the bridge made itself (a send's delivery check), which moves no frontier. */
  seq: number | null;
  event: PhotonEvent;
}

export const CHECKPOINT_PREFIX = "checkpoint:";

export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.min(attempt, 6), 60_000);
}

/** Only a 5xx retries; a 4xx is the agent refusing the event. */
export function shouldRetry(status: number): boolean {
  return status >= 500;
}

function last4(line: string): string {
  return line.replace(/\D/g, "").slice(-4);
}

/** A chat's failing event, retried with backoff while the rest of its chat waits behind it. */
type Retrying = { item: QueuedEvent; attempt: number; since: number; nextAt: number; alerted?: true };

/** A chat held this long behind a failing event is an alert (`scripts/tex-alert.mjs` raises it), before it parks. */
export const HELD_ALERT_MS = 2 * 60_000;

/** An event still failing this long is parked, so its own chat moves on too. */
export const PARK_AFTER_MS = 5 * 60_000;
/** A parked event is offered to the agent again this often, ... */
export const PARK_RETRY_MS = 60 * 60_000;
/** ... for this long, then dropped with an alert. */
export const PARK_KEEP_MS = 24 * 60 * 60_000;
export const PARKED_PREFIX = "parked:";

/** One delivery attempt: "delivered", "dropped" (the agent refused it, a 4xx) or "retry" (a 5xx or a throw). */
export async function deliverOnce(agent: AgentEvents, item: QueuedEvent, log: Log): Promise<"delivered" | "dropped" | "retry"> {
  let status: number | undefined;
  try {
    status = (await agent.event(item.event)).status;
  } catch {
    status = undefined;
  }
  if (status !== undefined && status >= 200 && status < 300) return "delivered";
  if (status !== undefined && !shouldRetry(status)) {
    log({ event: "deliver.refused", line: last4(item.line), seq: item.seq, status });
    return "dropped";
  }
  return "retry";
}

/** The chat an event belongs to: its order is kept within it. */
export function chatOf(item: QueuedEvent): string {
  return item.event?.chat?.guid ?? "";
}

/**
 * The delivery loop's state: the chats being retried. `step` is one pass; the object runs it in a loop
 * (`index.ts`), so the retries live as long as the object does (a restart starts them again from the container,
 * which still holds every event it was not told to ack).
 */
export class Pump {
  private readonly retrying = new Map<string, Retrying>();
  private lastParkSweep = 0;

  constructor(
    private readonly deps: { port: Fetchish; agent: AgentEvents; store: CheckpointStore; parked?: ParkStore; log: Log; now?: () => number },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The chats whose head is still failing. */
  busy(): string[] {
    return [...this.retrying.keys()];
  }

  /**
   * One pass: retry each chat whose wait is over, offer parked events again when due, then long-poll the container
   * for the oldest event of any other chat and deliver it. Returns "idle" when the poll times out with nothing queued.
   */
  async step(): Promise<"idle" | "acked" | "retrying" | "blocked"> {
    await this.retryDue();
    await this.offerParked();
    const wait = this.waitMs();
    const skip = this.busy().filter((chat) => chat !== "");
    const query = new URLSearchParams({ wait: String(wait) });
    for (const chat of skip) query.append("skip", chat);
    const { port } = this.deps;
    const next = await port.fetch(`${CONTAINER_ORIGIN}/next?${query}`);
    if (next.status === 204) return this.retrying.size > 0 ? "retrying" : "idle";
    if (!next.ok) throw new Error(`next ${next.status}`);
    const item = (await next.json()) as QueuedEvent;
    // A container that does not know `skip` yet (or a chat with no id) may hand back a chat being retried: it waits for
    // its head, and the caller sleeps until the next retry is due rather than polling the same event again.
    if (this.retrying.has(chatOf(item))) return "blocked";
    const outcome = await deliverOnce(this.deps.agent, item, this.deps.log);
    if (outcome === "retry") {
      this.hold(item);
      return "retrying";
    }
    await this.ack(item);
    return "acked";
  }

  /** How long the next poll may wait: until the soonest retry is due, at most the long poll. */
  waitMs(): number {
    let wait = LONG_POLL_MS;
    for (const r of this.retrying.values()) wait = Math.min(wait, Math.max(0, r.nextAt - this.now()));
    return wait;
  }

  private hold(item: QueuedEvent): void {
    const now = this.now();
    this.retrying.set(chatOf(item), { item, attempt: 0, since: now, nextAt: now + retryDelayMs(0) });
    this.deps.log({ event: "deliver.retry", line: last4(item.line), seq: item.seq, attempt: 0, delay_ms: retryDelayMs(0) });
  }

  private async retryDue(): Promise<void> {
    for (const [chat, r] of [...this.retrying]) {
      const now = this.now();
      if (r.nextAt > now) continue;
      const outcome = await deliverOnce(this.deps.agent, r.item, this.deps.log);
      if (outcome !== "retry") {
        this.retrying.delete(chat);
        await this.ack(r.item);
        continue;
      }
      if (now - r.since >= HELD_ALERT_MS && !r.alerted) {
        r.alerted = true;
        this.deps.log({ event: "bridge.alert", outcome: "chat_held", line: last4(r.item.line), seq: r.item.seq, type: r.item.event?.type, held_ms: now - r.since });
      }
      if (now - r.since >= PARK_AFTER_MS) {
        this.retrying.delete(chat);
        await this.park(r.item, now);
        continue;
      }
      r.attempt += 1;
      r.nextAt = now + retryDelayMs(r.attempt);
      this.deps.log({ event: "deliver.retry", line: last4(r.item.line), seq: r.item.seq, attempt: r.attempt, delay_ms: retryDelayMs(r.attempt) });
    }
  }

  /** Keeps a failing event aside and acks it, so its chat moves on; logged as an alert (`scripts/tex-alert.mjs`). */
  private async park(item: QueuedEvent, now: number): Promise<void> {
    const { parked, log } = this.deps;
    if (parked) await parked.put(`${PARKED_PREFIX}${item.id}`, { item, parkedAt: now, triedAt: now });
    log({ event: "bridge.alert", outcome: "event_parked", line: last4(item.line), seq: item.seq, type: item.event?.type, kept: parked !== undefined });
    await this.ack(item);
  }

  /** Offers each parked event to the agent again once its wait is over; drops one kept past PARK_KEEP_MS. */
  private async offerParked(): Promise<void> {
    const { parked, log } = this.deps;
    const now = this.now();
    if (!parked || now - this.lastParkSweep < 60_000) return;
    this.lastParkSweep = now;
    for (const [key, p] of await parked.list(PARKED_PREFIX)) {
      if (now - p.triedAt < PARK_RETRY_MS) continue;
      const outcome = await deliverOnce(this.deps.agent, p.item, log);
      if (outcome !== "retry") {
        await parked.delete(key);
        log({ event: "deliver.unparked", line: last4(p.item.line), seq: p.item.seq, outcome });
      } else if (now - p.parkedAt >= PARK_KEEP_MS) {
        await parked.delete(key);
        log({ event: "bridge.alert", outcome: "parked_dropped", line: last4(p.item.line), seq: p.item.seq, type: p.item.event?.type });
      } else {
        await parked.put(key, { ...p, triedAt: now });
      }
    }
  }

  private async ack(item: QueuedEvent): Promise<void> {
    const ack = await this.deps.port.fetch(`${CONTAINER_ORIGIN}/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: item.id }),
    });
    // 404: the container restarted and no longer holds the event. Catch-up
    // replays it from the stored frontier, and the agent deduplicates by eventId.
    if (ack.status === 404) return;
    if (!ack.ok) throw new Error(`ack ${ack.status}`);
    const { line, frontier } = (await ack.json()) as { line: string; frontier: number | null };
    if (item.seq !== null && Number.isSafeInteger(frontier)) await this.deps.store.put(`${CHECKPOINT_PREFIX}${line}`, frontier as number);
  }
}
