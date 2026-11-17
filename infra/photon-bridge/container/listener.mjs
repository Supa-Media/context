/**
 * Keeps one Photon line's streams open, following the events doc's Recovery
 * Flow: open the live message, chat and group streams and run events.catchUp
 * from the frontier at the same time. Every event goes into the ledger; the
 * ledger keeps the checkpoint contiguous.
 *
 * Reconnects with backoff. Each attempt resumes from the ledger's frontier,
 * so nothing is re-sent that the object already acked contiguously.
 */

export const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 15000, 30000, 60000]);

/** A first start with no frontier takes the log head, so no history is replayed. */
export async function probeHead(client) {
  for await (const event of client.events.catchUp(Number.MAX_SAFE_INTEGER)) {
    if (event.type === "catchup.complete") return event.headSequence;
  }
  throw new Error("catch-up ended without catchup.complete");
}

/** Apple's stamp on a raw event, when it has one. Used for replay lag only. */
export function eventInstant(event) {
  const candidates = [event?.occurredAt, event?.message?.dateCreated, event?.editedAt, event?.readAt, event?.retractedAt];
  for (const value of candidates) {
    const ms = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * One Photon read that proves the channel still answers. The head probe
 * replays nothing (see `probeHead`). A read that does not finish inside
 * `timeoutMs` rejects with code `readTimeout` and does not count.
 */
export async function proveRead(client, timeoutMs, signal) {
  if (signal?.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
  const stream = client.events.catchUp(Number.MAX_SAFE_INTEGER);
  let timer;
  const reading = (async () => {
    for await (const event of stream) {
      if (event.type === "catchup.complete") return event.headSequence;
    }
    throw new Error("catch-up ended without catchup.complete");
  })();
  // A timeout settles the race and leaves this read running until `close`.
  reading.catch(() => {});
  try {
    return await Promise.race([
      reading,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "readTimeout" })), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await stream.close?.();
  }
}

/**
 * One connection's life: the live streams and catch-up run together until a
 * stream fails, the line is cut off, or the signal aborts. Throws on failure.
 */
export async function streamOnce({ client, line, ledger, onQueued, signal, enrich = async () => ({}), onCatchup, now = Date.now }) {
  const live = [
    client.messages.subscribeEvents(),
    client.chats.subscribeEvents(),
    client.groups.subscribeEvents(),
  ];
  // Attached before anything is opened: a signal that fired first must still
  // end this attempt, not leave it waiting on streams that never end.
  const abort = new Promise((_, reject) => {
    if (signal?.aborted) reject(new Error("aborted"));
    else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  abort.catch(() => {});
  const catchup = client.events.catchUp(ledger.frontier(line));

  // Enrichment is best effort and bounded by its own timeout, so it can slow
  // an event but never stall the stream behind it.
  const offer = async (event) => {
    const extras = await enrich(event);
    if (ledger.offer(line, event, extras) === "queued") onQueued();
  };

  const pumps = live.map(async (stream) => {
    for await (const event of stream) {
      await offer(event);
    }
    throw new Error("live stream ended");
  });
  // A pump can fail while catch-up is still running; Promise.race below
  // reports it, and this keeps Node from treating it as unhandled meanwhile.
  for (const pump of pumps) pump.catch(() => {});

  try {
    let replayed = 0;
    let oldest = null;
    for await (const event of catchup) {
      if (event.type === "catchup.complete") {
        onCatchup?.({ replayed, lagMs: oldest == null ? 0 : Math.max(0, now() - oldest) });
        break;
      }
      replayed += 1;
      const at = eventInstant(event);
      if (at != null && (oldest == null || at < oldest)) oldest = at;
      await offer(event);
    }
    await Promise.race([...pumps, abort]);
  } finally {
    await Promise.allSettled([...live.map((stream) => stream.close()), catchup.close?.()]);
  }
}

/**
 * Runs a line until the signal aborts. `log` receives event names and codes
 * only (see log.mjs).
 */
export async function runLine({
  client,
  line,
  ledger,
  onQueued,
  signal,
  log,
  enrich,
  backoff = BACKOFF_MS,
  sleep = defaultSleep,
  onCatchup,
  onPoll,
  onPollFailed,
  pollMs = 0,
  pollTimeoutMs = 20_000,
  now,
}) {
  const polling = pollMs > 0
    ? (async () => {
      while (!signal.aborted) {
        await sleep(pollMs, signal);
        if (signal.aborted) return;
        try {
          await proveRead(client, pollTimeoutMs, signal);
          onPoll?.();
        } catch (error) {
          if (signal.aborted) return;
          onPollFailed?.(errorCode(error));
        }
      }
    })()
    : null;
  let attempt = 0;
  try {
    while (!signal.aborted) {
      try {
        if (ledger.frontier(line) === undefined) {
          ledger.initialize(line, await probeHead(client));
        }
        await streamOnce({ client, line, ledger, onQueued, signal, enrich, onCatchup, now });
        log({ event: "line.stream_ended", line, attempt });
      } catch (error) {
        if (signal.aborted) return;
        log({ event: "line.stream_failed", line, attempt, error: errorCode(error) });
      }
      if (signal.aborted) return;
      const delay = backoff[Math.min(attempt, backoff.length - 1)];
      attempt += 1;
      log({ event: "line.reconnect", line, attempt, delay_ms: delay });
      await sleep(delay, signal);
    }
  } finally {
    await polling;
  }
}

/** The SDK's code when there is one; never the message. */
export function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "unknown";
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
