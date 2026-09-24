/**
 * Durable v2 text, relayed live: every frame is authorized afresh for its
 * sender and for each recipient, at most eight authorizations in flight per
 * socket, and nothing here is ever written to the room log.
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

  let authorization;
  try {
    authorization = await this.authorizeLiveRelay({
      sender,
      accessToken: message.accessToken,
      documentId: message.documentId,
      recipients: candidates.map(({ id, grantId }) => ({ id, grantId })),
    });
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
  const state = this.liveRelayQueues.get(ws);
  if (!state) return;
  state.closed = true;
  for (const queued of state.queue.splice(0)) queued.resolve();
  this.liveRelayQueues.delete(ws);
}
