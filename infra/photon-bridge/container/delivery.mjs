/**
 * Whether each of Tex's sends reached the person. Photon's event log has no delivery event: Apple's echo of a send
 * (`message.received`, fromMe) means only that the Mac took it. The message itself carries what Sendblue's status
 * callback did: `sendErrorCode` (non-zero when the send failed) and `isDelivered`. So each send is read back
 * (`messages.get`) a little after it went, and once more later:
 *
 * - an error code at any read: a `message.status` event, state "failed", which the agent's send step marks and, for
 *   a threaded text, sends again plain, as Sendblue's ERROR was;
 * - not delivered at the last read: state "undelivered", shown on the send step and nothing more (a phone that is
 *   off or out of signal gets it later).
 *
 * Best effort and in memory: a container restart loses the checks still waiting. Never the words, only the guid, the
 * chat and the code.
 */

/** When each send is read back, after it went. */
export const CHECK_AFTER_MS = Object.freeze([30_000, 180_000]);
/** Sends watched at once; past this the oldest waiting check is dropped. */
export const MAX_WATCHED = 500;

function errorOf(message) {
  const code = message?.sendErrorCode;
  return Number.isSafeInteger(code) && code !== 0 ? code : null;
}

function chatKind(guid) {
  return typeof guid === "string" && guid.includes(";+;") ? "group" : "dm";
}

/** The agent's event for one send's state (plan.md Contract A, EXTENSION `message.status`). */
export function statusEvent(line, chat, guid, state, code, at = new Date()) {
  return {
    seq: null,
    eventId: `photon:message.status:${guid}:${state}`,
    type: "message.status",
    line,
    chat: { guid: chat, kind: chatKind(chat) },
    fromMe: true,
    at: at.toISOString(),
    status: { targetGuid: guid, state, ...(code !== null && code !== undefined ? { code } : {}) },
  };
}

/**
 * `get(line, guid)` reads a message back; `push(line, event)` queues an event for the agent (the ledger's).
 * `setTimer` and `now` are the clock, for tests.
 */
export function createDeliveryWatch({ get, push, log = () => {}, setTimer = setTimeout, after = CHECK_AFTER_MS }) {
  const watched = new Map();

  function finish(guid) {
    const entry = watched.get(guid);
    if (!entry) return;
    for (const timer of entry.timers) clearTimeout(timer);
    watched.delete(guid);
  }

  function report(line, chat, guid, state, code) {
    push(line, statusEvent(line, chat, guid, state, code));
    log({ event: "delivery.check", outcome: state, status: code ?? undefined });
    finish(guid);
  }

  async function check(line, chat, guid, last) {
    if (!watched.has(guid)) return;
    let message;
    try {
      message = await get(line, guid);
    } catch {
      log({ event: "delivery.check", outcome: "unread" });
      if (last) finish(guid);
      return;
    }
    const code = errorOf(message);
    if (code !== null) return report(line, chat, guid, "failed", code);
    if (message?.isDelivered === true) {
      finish(guid);
      return;
    }
    if (last) report(line, chat, guid, "undelivered", null);
  }

  return {
    /** Watches one send: `sent` is the message the send answered with, already read for an error code. */
    watch(line, chat, sent) {
      const guid = sent?.guid;
      if (typeof guid !== "string" || guid === "" || typeof chat !== "string") return;
      const code = errorOf(sent);
      if (code !== null) {
        watched.set(guid, { timers: [] });
        return report(line, chat, guid, "failed", code);
      }
      if (watched.size >= MAX_WATCHED) finish(watched.keys().next().value);
      const timers = after.map((ms, index) => setTimer(() => void check(line, chat, guid, index === after.length - 1), ms));
      for (const timer of timers) timer?.unref?.();
      watched.set(guid, { timers });
    },

    /** Sends still waiting on a check, for health. */
    size() {
      return watched.size;
    },
  };
}
