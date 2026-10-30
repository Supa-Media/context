/**
 * Durable v2 text, relayed live: frames are authorized for their sender and
 * for each recipient, at most eight in flight per socket, and nothing here is
 * ever written to the room log. One authorization covers a socket's frames for
 * LIVE_RECHECK_MS while the token and the people in the note stay the same.
 */

import { COLLABORATION_PROTOCOL_VERSION } from "../presence.js";
import { CLOSE_REAUTHORIZE } from "./wire.js";

export async function enqueueLiveRelay(ws, message) {
  const attachment = ws.deserializeAttachment();
  if (
    attachment?.collaborationVersion !== COLLABORATION_PROTOCOL_VERSION ||
    !attachment.canWrite || !attachment.documentId ||
    message.documentId !== attachment.documentId ||
    typeof this.authorizeLiveRelay !== "function"
  ) {
    return;
  }

  let state = this.liveRelayQueues.get(ws);
  if (!state) {
    state = { active: 0, bytes: 0, queue: [] };
    this.liveRelayQueues.set(ws, state);
  }
  const bytes = message.d.length + message.accessToken.length;
  if (state.active + state.queue.length >= 64 || state.bytes + bytes > 256 * 1024) {
    state.closed = true;
    for (const queued of state.queue.splice(0)) queued.resolve();
    this.dropSocket(ws, CLOSE_REAUTHORIZE, "relay overflow");
    this.liveRelayQueues.delete(ws);
    return;
  }
  state.bytes += bytes;

  await new Promise((resolve) => {
    state.queue.push({ message, bytes, resolve });
    this.pumpLiveRelay(ws, state);
  });
}

export function pumpLiveRelay(ws, state) {
  while (!state.closed && state.active < 8 && state.queue.length > 0) {
    const item = state.queue.shift();
    state.active += 1;
    void this.relayLiveUpdate(ws, item.message)
      .catch(() => {})
      .finally(() => {
        state.active -= 1;
        state.bytes -= item.bytes;
        item.resolve();
        if (state.closed || (state.active === 0 && state.queue.length === 0)) {
          this.liveRelayQueues.delete(ws);
        } else {
          this.pumpLiveRelay(ws, state);
        }
      });
  }
}

/** How long a sender alone in a note goes between authorizations of its live frames. */
export const ALONE_RECHECK_MS = 30_000;

/** When each socket's live frames were last authorized while it was alone. */
const aloneCheckedAt = new WeakMap();

/**
 * How long one authorization covers a socket's live frames to the same people.
 *
 * Every keystroke used to cost a control-plane session, a grant lookup and the
 * workspace's privacy state, from each typist with a peer in the note: a large
 * share of the Convex reads billed for Oct 12-30. The owner chose ten seconds
 * (2026-10-30): someone whose access is taken away may go on receiving another
 * person's keystrokes in a note they already had open for at most that long.
 * Joining, leaving, a new grant on either side or a new token asks again at
 * once, and a refusal is never reused.
 */
export const LIVE_RECHECK_MS = 10_000;

/** Each socket's last authorization with company: its key, when it was asked, and its answer. */
const liveAuthorizations = new WeakMap();

// The bearer is never kept, even in memory: the key holds its digest.
async function liveAuthorizationKey(sender, accessToken, documentId, candidates) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return JSON.stringify([
    btoa(String.fromCharCode(...new Uint8Array(digest))), sender.id, sender.grantId, sender.workspaceId, sender.path, documentId,
    candidates.map(({ id, grantId }) => `${id}\u0000${grantId}`).sort(),
  ]);
}

function coversEveryone(authorization, candidates) {
  if (!authorization?.sender) return false;
  const allowed = authorization.recipients instanceof Set
    ? authorization.recipients
    : new Set(authorization.recipients || []);
  return candidates.every(({ id }) => allowed.has(id));
}

export async function relayLiveUpdate(ws, message) {
  // Re-read on every frame. Cursor and heartbeat traffic may have updated the
  // attachment while this frame waited behind another authorization.
  const sender = ws.deserializeAttachment();
  if (
    this.closedLiveSockets.has(ws) ||
    sender?.collaborationVersion !== COLLABORATION_PROTOCOL_VERSION ||
    !sender.canWrite || !sender.documentId || message.documentId !== sender.documentId
  ) {
    return;
  }
  const candidates = [];
  for (const peer of this.openSockets()) {
    if (peer === ws) continue;
    const held = peer.deserializeAttachment();
    if (
      held?.collaborationVersion !== COLLABORATION_PROTOCOL_VERSION ||
      held.workspaceId !== sender.workspaceId || held.path !== sender.path ||
      held.documentId !== sender.documentId ||
      typeof held.grantId !== "string" || typeof held.id !== "string"
    ) {
      continue;
    }
    candidates.push({ socket: peer, id: held.id, grantId: held.grantId });
  }
  // Nobody to relay to: nothing is sent, so the only thing authorizing buys is noticing that the
  // sender lost the note. That is asked at most every ALONE_RECHECK_MS per socket rather than on
  // every keystroke, which cost a control-plane session per key from everyone typing alone.
  if (candidates.length === 0) {
    const now = Date.now();
    const checked = aloneCheckedAt.get(ws);
    if (checked !== undefined && now - checked < ALONE_RECHECK_MS) return;
    aloneCheckedAt.set(ws, now);
  }

  const ask = () => this.authorizeLiveRelay({
    sender,
    accessToken: message.accessToken,
    documentId: message.documentId,
    recipients: candidates.map(({ id, grantId }) => ({ id, grantId })),
  });
  let authorization;
  try {
    if (candidates.length === 0) {
      authorization = await ask();
    } else {
      // Frames typed while an answer is on its way wait for that answer rather than asking again.
      const key = await liveAuthorizationKey(sender, message.accessToken, message.documentId, candidates);
      const now = Date.now();
      let held = liveAuthorizations.get(ws);
      if (held === undefined || held.key !== key || now - held.at >= LIVE_RECHECK_MS) {
        held = { key, at: now, answer: ask() };
        liveAuthorizations.set(ws, held);
      }
      try {
        authorization = await held.answer;
      } catch (error) {
        if (liveAuthorizations.get(ws) === held) liveAuthorizations.delete(ws);
        throw error;
      }
      // Only a yes for everyone is reused: a refusal, or anyone left out, is asked about afresh.
      if (!coversEveryone(authorization, candidates) && liveAuthorizations.get(ws) === held) {
        liveAuthorizations.delete(ws);
      }
    }
  } catch {
    return;
  }
  if (!authorization?.sender) {
    this.dropSocket(ws, CLOSE_REAUTHORIZE, "reauthorize");
    return;
  }
  const seated = new Set(this.openSockets());
  const currentSender = ws.deserializeAttachment();
  if (
    this.closedLiveSockets.has(ws) || !seated.has(ws) || !currentSender ||
    Date.now() > currentSender.deadline ||
    currentSender.id !== sender.id || currentSender.grantId !== sender.grantId ||
    currentSender.workspaceId !== sender.workspaceId || currentSender.path !== sender.path ||
    currentSender.documentId !== sender.documentId
  ) {
    return;
  }
  const allowed = authorization.recipients instanceof Set
    ? authorization.recipients
    : new Set(authorization.recipients || []);
  const payload = JSON.stringify({
    t: "live",
    documentId: message.documentId,
    d: message.d,
    clientKey: sender.clientKey,
  });
  for (const candidate of candidates) {
    // The batch authorized this exact seated member. A socket can update its
    // cursor meanwhile, but it cannot change grant, path, or generation and
    // still receive bytes under the earlier decision.
    const current = candidate.socket.deserializeAttachment();
    const stillSame = !this.closedLiveSockets.has(candidate.socket) &&
      seated.has(candidate.socket) && Date.now() <= current?.deadline &&
      current?.id === candidate.id && current.grantId === candidate.grantId &&
      current.workspaceId === sender.workspaceId && current.path === sender.path &&
      current.documentId === sender.documentId;
    if (!allowed.has(candidate.id) || !stillSame) {
      this.dropSocket(candidate.socket, CLOSE_REAUTHORIZE, "reauthorize");
      continue;
    }
    try {
      candidate.socket.send(payload);
    } catch {
      // Its close callback removes it. One dead recipient cannot turn a
      // successfully authorized update into a retry from the sender.
    }
  }
}

export function cancelLiveRelay(ws) {
  this.closedLiveSockets.add(ws);
  liveAuthorizations.delete(ws);
  const state = this.liveRelayQueues.get(ws);
  if (!state) return;
  state.closed = true;
  for (const queued of state.queue.splice(0)) queued.resolve();
  this.liveRelayQueues.delete(ws);
}
