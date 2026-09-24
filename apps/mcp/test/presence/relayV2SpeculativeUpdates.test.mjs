/**
 * Presence: v2 speculative live updates are freshly authorized on every
 * relay — a freshly authorized update reaches only the authorized recipient
 * and never carries the bearer it was authorized with, a wrong document is
 * refused before authorization, overlapping keystrokes stay within the
 * per-socket concurrency bound, and a recipient closed while authorization
 * is in flight receives no late plaintext.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for `fakeRoomRuntime`,
 * `fakeSocket` and `withFakeWebSocketPair`.
 */

import { PresenceRoom, fakeRoomRuntime, fakeSocket, withFakeWebSocketPair } from "./fixtures.mjs";

export async function runPresenceRelayV2SpeculativeUpdateChecks(check) {
  await withFakeWebSocketPair(async () => {
    const liveToken = `cat_live_${"x".repeat(24)}`;

    /* ---------------- v2 speculative updates are freshly authorized ------ */

    class RelayRoom extends PresenceRoom {
      constructor(state, authorize) {
        super(state, {});
        this.authorize = authorize;
        this.authorizations = [];
      }
      async authorizeLiveRelay(input) {
        this.authorizations.push(input);
        return this.authorize(input);
      }
    }
    const relayRuntime = fakeRoomRuntime();
    const relayRoom = new RelayRoom(relayRuntime.state, async () => ({
      sender: true,
      recipients: new Set(["recipient-live"]),
    }));
    const relayAttachment = (id, grantId, clientKey, documentId = "doc-live") => ({
      id,
      grantId,
      clientKey,
      workspaceId: "ws-live",
      workspaceSlug: "live",
      path: "1-projects/live.md",
      documentId,
      collaborationVersion: 2,
      canWrite: true,
      deadline: Date.now() + 60_000,
      seen: Date.now(),
    });
    const liveSender = fakeSocket();
    const liveRecipient = fakeSocket();
    const revokedRecipient = fakeSocket();
    liveSender.serializeAttachment(relayAttachment("sender-live", "grant-sender", "client-sender"));
    liveRecipient.serializeAttachment(relayAttachment("recipient-live", "grant-recipient", "client-recipient"));
    revokedRecipient.serializeAttachment(relayAttachment("recipient-revoked", "grant-revoked", "client-revoked"));
    relayRuntime.open.push(liveSender, liveRecipient, revokedRecipient);
    await relayRoom.webSocketMessage(liveSender, JSON.stringify({
      t: "live", documentId: "doc-live", d: "QUJD", accessToken: liveToken,
    }));
    const deliveredLive = liveRecipient.frames().find((frame) => frame.t === "live");
    check(
      "a freshly authorized live update reaches only the authorized recipient",
      deliveredLive?.t === "live" && deliveredLive.documentId === "doc-live" &&
        deliveredLive.d === "QUJD" && deliveredLive.clientKey === "client-sender" &&
        revokedRecipient.frames().every((frame) => frame.t !== "live") &&
        revokedRecipient.closed.length === 1,
    );
    check(
      "the relay bearer is consumed by authorization and never sent or attached",
      relayRoom.authorizations[0]?.accessToken === liveToken &&
        !JSON.stringify(deliveredLive).includes(liveToken) &&
        !JSON.stringify(liveSender.deserializeAttachment()).includes(liveToken) &&
        (await relayRoom.readLog()).length === 0,
    );
    const authorizationsBeforeWrongDocument = relayRoom.authorizations.length;
    await relayRoom.webSocketMessage(liveSender, JSON.stringify({
      t: "live", documentId: "doc-other", d: "REVG", accessToken: liveToken,
    }));
    check(
      "a live update for another document is refused before authorization",
      relayRoom.authorizations.length === authorizationsBeforeWrongDocument &&
        liveRecipient.frames().every((frame) => frame.d !== "REVG"),
    );

    const burstRuntime = fakeRoomRuntime();
    let activeAuthorizations = 0;
    let maximumAuthorizations = 0;
    const burstRoom = new RelayRoom(burstRuntime.state, async () => {
      activeAuthorizations += 1;
      maximumAuthorizations = Math.max(maximumAuthorizations, activeAuthorizations);
      await new Promise((resolve) => setTimeout(resolve, 3));
      activeAuthorizations -= 1;
      return { sender: true, recipients: new Set(["burst-recipient"]) };
    });
    const burstSender = fakeSocket();
    const burstRecipient = fakeSocket();
    burstSender.serializeAttachment(relayAttachment("burst-sender", "grant-burst", "client-burst"));
    burstRecipient.serializeAttachment(relayAttachment("burst-recipient", "grant-peer", "client-peer"));
    burstRuntime.open.push(burstSender, burstRecipient);
    await Promise.all(
      Array.from({ length: 10 }, (_, index) => burstRoom.webSocketMessage(
        burstSender,
        JSON.stringify({
          t: "live",
          documentId: "doc-live",
          d: btoa(`key-${index}`),
          accessToken: liveToken,
        }),
      )),
    );
    check(
      "overlapping keystrokes are all relayed within the per-socket concurrency bound",
      burstRecipient.frames().filter((frame) => frame.t === "live").length === 10 &&
        maximumAuthorizations > 1 && maximumAuthorizations <= 8,
    );

    const closingRuntime = fakeRoomRuntime();
    let finishAuthorization;
    const closingRoom = new RelayRoom(closingRuntime.state, () => new Promise((resolve) => {
      finishAuthorization = resolve;
    }));
    const closingSender = fakeSocket();
    const closingRecipient = fakeSocket();
    closingSender.serializeAttachment(relayAttachment("closing-sender", "grant-sender", "client-sender"));
    closingRecipient.serializeAttachment(relayAttachment("closing-recipient", "grant-peer", "client-peer"));
    closingRuntime.open.push(closingSender, closingRecipient);
    const pendingRelay = closingRoom.webSocketMessage(closingSender, JSON.stringify({
      t: "live", documentId: "doc-live", d: "R0hJ", accessToken: liveToken,
    }));
    await Promise.resolve();
    closingRoom.dropSocket(closingRecipient, 4401, "reauthorize");
    finishAuthorization({ sender: true, recipients: new Set(["closing-recipient"]) });
    await pendingRelay;
    check(
      "a recipient closed while authorization is in flight receives no late plaintext",
      closingRecipient.frames().every((frame) => frame.t !== "live"),
    );
  });
}
