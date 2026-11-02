/**
 * Presence: v2 speculative live updates are authorized before they are
 * relayed — an authorized update reaches only the authorized recipient and
 * never carries the bearer it was authorized with, a wrong document is
 * refused before authorization, overlapping keystrokes share one
 * authorization, one yes covers the same people for LIVE_RECHECK_MS and no
 * longer, a refusal is never reused, and a recipient closed while
 * authorization is in flight receives no late plaintext.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for `fakeRoomRuntime`,
 * `fakeSocket` and `withFakeWebSocketPair`.
 */

import { PresenceRoom, fakeRoomRuntime, fakeSocket, withFakeWebSocketPair } from "./fixtures.mjs";
import { LIVE_RECHECK_MS } from "../../src/presenceRoom/liveRelay.js";

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

    const aloneRuntime = fakeRoomRuntime();
    const aloneRoom = new RelayRoom(aloneRuntime.state, async () => ({ sender: true, recipients: new Set() }));
    const aloneSender = fakeSocket();
    aloneSender.serializeAttachment(relayAttachment("alone-sender", "grant-alone", "client-alone"));
    aloneRuntime.open.push(aloneSender);
    for (const d of ["QUJD", "REVG", "R0hJ"]) {
      await aloneRoom.webSocketMessage(aloneSender, JSON.stringify({
        t: "live", documentId: "doc-live", d, accessToken: liveToken,
      }));
    }
    check(
      "keystrokes with nobody else in the note are authorized once, not once each",
      aloneRoom.authorizations.length === 1 && aloneRoom.authorizations[0].recipients.length === 0 &&
        aloneSender.closed.length === 0 && (await aloneRoom.readLog()).length === 0,
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
      "overlapping keystrokes are all relayed on one shared authorization",
      burstRecipient.frames().filter((frame) => frame.t === "live").length === 10 &&
        burstRoom.authorizations.length === 1 && maximumAuthorizations === 1,
    );

    /* ---------------- one yes covers the same people for a while ------- */

    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      const windowRuntime = fakeRoomRuntime();
      let refuseRecipient = false;
      const windowRoom = new RelayRoom(windowRuntime.state, async () => ({
        sender: true,
        recipients: new Set(refuseRecipient ? [] : ["window-recipient", "window-joiner"]),
      }));
      const windowSender = fakeSocket();
      const windowRecipient = fakeSocket();
      windowSender.serializeAttachment(relayAttachment("window-sender", "grant-window", "client-window"));
      windowRecipient.serializeAttachment(relayAttachment("window-recipient", "grant-peer", "client-peer"));
      windowRuntime.open.push(windowSender, windowRecipient);
      const type = (d, accessToken = liveToken) => windowRoom.webSocketMessage(windowSender, JSON.stringify({
        t: "live", documentId: "doc-live", d, accessToken,
      }));
      const delivered = () => windowRecipient.frames().filter((frame) => frame.t === "live").length;

      await type("QQ==");
      clock += LIVE_RECHECK_MS - 1;
      await type("Qg==");
      check(
        "keystrokes to the same people within the recheck window reuse one authorization",
        windowRoom.authorizations.length === 1 && delivered() === 2,
      );

      clock += 1;
      await type("Qw==");
      check(
        "a keystroke once the recheck window has passed is authorized again",
        windowRoom.authorizations.length === 2 && delivered() === 3,
      );

      await type("RA==", `cat_live_${"y".repeat(24)}`);
      check(
        "a keystroke under a different token is authorized again at once",
        windowRoom.authorizations.length === 3 && delivered() === 4,
      );

      const joiner = fakeSocket();
      joiner.serializeAttachment(relayAttachment("window-joiner", "grant-joiner", "client-joiner"));
      windowRuntime.open.push(joiner);
      await type("RQ==");
      check(
        "someone joining the note is authorized before the next keystroke reaches them",
        windowRoom.authorizations.length === 4 &&
          windowRoom.authorizations[3].recipients.some(({ id }) => id === "window-joiner") &&
          joiner.frames().some((frame) => frame.t === "live"),
      );

      refuseRecipient = true;
      clock += LIVE_RECHECK_MS;
      await type("Rg==");
      check(
        "a recipient refused once the window has passed is closed and sent nothing",
        windowRecipient.closed.length === 1 && joiner.closed.length === 1 &&
          windowRecipient.frames().every((frame) => frame.d !== "Rg=="),
      );

      const refusedRuntime = fakeRoomRuntime();
      let refusals = 1;
      const refusedRoom = new RelayRoom(refusedRuntime.state, async () => {
        if (refusals > 0) {
          refusals -= 1;
          return { sender: true, recipients: new Set() };
        }
        return { sender: true, recipients: new Set(["refused-peer"]) };
      });
      const refusedSender = fakeSocket();
      const refusedPeer = fakeSocket();
      refusedSender.serializeAttachment(relayAttachment("refused-sender", "grant-sender", "client-sender"));
      refusedPeer.serializeAttachment(relayAttachment("refused-peer", "grant-peer", "client-peer"));
      refusedRuntime.open.push(refusedSender, refusedPeer);
      await refusedRoom.webSocketMessage(refusedSender, JSON.stringify({
        t: "live", documentId: "doc-live", d: "QQ==", accessToken: liveToken,
      }));
      // The same member comes back on a new socket at once: the same people as before.
      const returnedPeer = fakeSocket();
      returnedPeer.serializeAttachment(relayAttachment("refused-peer", "grant-peer", "client-peer"));
      refusedRuntime.open.push(returnedPeer);
      await refusedRoom.webSocketMessage(refusedSender, JSON.stringify({
        t: "live", documentId: "doc-live", d: "Qg==", accessToken: liveToken,
      }));
      check(
        "a refusal is never reused: the next keystroke asks again",
        refusedPeer.closed.length === 1 && refusedPeer.frames().every((frame) => frame.t !== "live") &&
          refusedRoom.authorizations.length === 2 &&
          returnedPeer.frames().some((frame) => frame.d === "Qg=="),
      );
    } finally {
      Date.now = realNow;
    }

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
    while (finishAuthorization === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
    closingRoom.dropSocket(closingRecipient, 4401, "reauthorize");
    finishAuthorization({ sender: true, recipients: new Set(["closing-recipient"]) });
    await pendingRelay;
    check(
      "a recipient closed while authorization is in flight receives no late plaintext",
      closingRecipient.frames().every((frame) => frame.t !== "live"),
    );
  });
}
