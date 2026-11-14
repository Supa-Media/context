/**
 * One step of the delivery loop: take the container's oldest unacked event,
 * hand it to the agent over RPC, and only then ack it and store the line's
 * frontier.
 *
 * Contract A: the agent's {status} 200 means queued, so the checkpoint may pass
 * the event; a 4xx means refused, which is logged and passed; a 5xx or a thrown
 * call means "try again", and the checkpoint does not move. The retry waits
 * here, so the queue behind a failing event waits too, which keeps the order.
 * The container pulls and never pushes, so the retry is this object's, not the
 * container's.
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

export type Log = (record: Record<string, unknown>) => void;
export type Sleep = (ms: number) => Promise<void>;

/** What the container hands over: the event and the line and sequence it came from. */
export interface QueuedEvent {
  id: string;
  line: string;
  seq: number;
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

/**
 * Delivers one event, retrying until the agent takes it or refuses it. Returns
 * "dropped" for a refusal; never returns for a failure that retrying can fix.
 */
export async function deliver(
  agent: AgentEvents,
  item: QueuedEvent,
  { sleep, log }: { sleep: Sleep; log: Log },
): Promise<"delivered" | "dropped"> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number | undefined;
    try {
      const result = await agent.event(item.event);
      status = result.status;
      if (status >= 200 && status < 300) return "delivered";
      if (!shouldRetry(status)) {
        log({ event: "deliver.refused", line: last4(item.line), seq: item.seq, status });
        return "dropped";
      }
    } catch {
      status = undefined;
    }
    const delay = retryDelayMs(attempt);
    log({ event: "deliver.retry", line: last4(item.line), seq: item.seq, status, attempt, delay_ms: delay });
    await sleep(delay);
  }
}

/**
 * One pass: long-poll the container, deliver what it returns, ack it, store
 * the frontier. Returns "idle" when the poll times out with nothing queued.
 */
export async function pumpOnce({
  port,
  agent,
  store,
  sleep,
  log,
}: {
  port: Fetchish;
  agent: AgentEvents;
  store: CheckpointStore;
  sleep: Sleep;
  log: Log;
}): Promise<"idle" | "acked"> {
  const next = await port.fetch(`${CONTAINER_ORIGIN}/next?wait=${LONG_POLL_MS}`);
  if (next.status === 204) return "idle";
  if (!next.ok) throw new Error(`next ${next.status}`);
  const item = (await next.json()) as QueuedEvent;

  await deliver(agent, item, { sleep, log });

  const ack = await port.fetch(`${CONTAINER_ORIGIN}/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: item.id }),
  });
  // 404: the container restarted and no longer holds the event. Catch-up
  // replays it from the stored frontier, and the agent deduplicates by eventId.
  if (ack.status === 404) return "acked";
  if (!ack.ok) throw new Error(`ack ${ack.status}`);
  const { line, frontier } = (await ack.json()) as { line: string; frontier: number };
  await store.put(`${CHECKPOINT_PREFIX}${line}`, frontier);
  return "acked";
}
