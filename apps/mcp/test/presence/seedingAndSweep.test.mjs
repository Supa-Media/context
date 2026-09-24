/**
 * Presence: who puts the note into the shared document (§ the seeding
 * decision, moved to the room because it is the only party that knows both
 * halves of it), closing sockets are not members after hibernation, and the
 * room's own copy of the note is dropped when the room empties, with its
 * sweep still scheduled while anything remains.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for `fakeSocket`,
 * `fakeRoomRuntime`, and `withFakeWebSocketPair` — the room object's
 * `.fetch()` calls `new WebSocketPair()` the way the Workers runtime never
 * does in node, so every check here runs inside that installed fake.
 */

import { PresenceRoom, fakeRoomRuntime, fakeSocket, roster, withFakeWebSocketPair } from "./fixtures.mjs";

export async function runPresenceSeedingAndSweepChecks(check) {
  /* ------------- who puts the note into the shared document -------------- */

  /*
    **The seeding decision, tested against a real `welcome` frame.**

    A note starts as text in a bucket and exactly one client has to put it into
    the shared document; two clients doing it means the note contains itself
    twice, and none doing it means the shared document starts empty and the
    elected writer saves that emptiness over the customer's note.

    The client used to decide this by asking whether the roster in its own
    welcome was empty — and the roster *includes the member it was just sent
    to*, so the answer was "no" for the first person as well as the last. Every
    unit test agreed with the client because every unit test built the welcome
    frame the way the client expected it, and two browsers on a real socket
    disagreed within a second: nobody seeded, and the note's text never reached
    the room.

    So the decision moved to the room, which is the only party that knows both
    halves of it, and these checks run the object's own `fetch` against a fake
    of the Durable Object runtime rather than a fixture of what it might send.
  */
  await withFakeWebSocketPair(async (pairs) => {
    const runtime = fakeRoomRuntime();
    const roomObject = new PresenceRoom(runtime.state, {});
    // The object answers 101, which node's `Response` refuses to construct —
    // a fact about undici, not about the room. Everything under test has
    // already been sent to the socket by then, so the throw is swallowed and
    // the frames are read off the fake.
    const join = async (name) => {
      try {
        await roomObject.fetch(
          new Request("https://gateway.invalid/presence", {
            headers: {
              Upgrade: "websocket",
              "x-presence-member": JSON.stringify({ name, colorSeed: null, canWrite: true }),
            },
          }),
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    };

    await join("@first");
    const firstWelcome = pairs[0].server.frames().find((frame) => frame.t === "welcome");
    check(
      "the room tells the first client to seed the document",
      firstWelcome?.seed === true,
    );
    check(
      "...and its roster contains the client it was sent to, which is why the client could not decide this itself",
      firstWelcome?.members.length === 1 && firstWelcome.members[0].id === firstWelcome.you,
    );

    await join("@second");
    const secondWelcome = pairs[1].server.frames().find((frame) => frame.t === "welcome");
    check(
      "the room tells a client joining an occupied room not to seed",
      secondWelcome?.seed === false,
    );

    /* -------- closing sockets are not members after hibernation ---------- */

    const reconnecting = fakeRoomRuntime();
    const oldSocket = fakeSocket();
    const firstTab = fakeSocket();
    const secondTab = fakeSocket();
    const attachedMember = (id) => ({
      id,
      name: "@bo",
      color: "#123456",
      canWrite: true,
      seen: Date.now(),
      deadline: Number.MAX_SAFE_INTEGER,
    });
    oldSocket.serializeAttachment(attachedMember("old-connection"));
    firstTab.serializeAttachment(attachedMember("first-tab"));
    secondTab.serializeAttachment(attachedMember("second-tab"));
    // Cloudflare may retain this socket in getWebSockets() while completing
    // the close handshake. Constructing the room object afterwards models a
    // hibernation wake, when no in-memory closed-socket set survives.
    oldSocket.setReadyState(2);
    reconnecting.open.push(oldSocket, firstTab, secondTab);
    const wokeRoom = new PresenceRoom(reconnecting.state, {});
    const wokeRoster = roster(wokeRoom.roomFromSockets());
    check(
      "a closing socket retained across hibernation is absent from the rebuilt roster",
      wokeRoster.length === 2 && wokeRoster.every((member) => member.id !== "old-connection"),
    );
    check(
      "two open tabs belonging to the same person remain two legitimate members",
      wokeRoster.map((member) => member.name).every((name) => name === "@bo") &&
        new Set(wokeRoster.map((member) => member.id)).size === 2,
    );
    wokeRoom.broadcast({ t: "leave", id: "somebody-else" });
    check(
      "a closing socket retained by the runtime receives no later room frames",
      oldSocket.sent.length === 0 && firstTab.sent.length === 1 && secondTab.sent.length === 1,
    );
    await wokeRoom.webSocketClose(oldSocket, 1000, "bye");
    check(
      "the close callback completes the closing handshake while the runtime still retains the socket",
      oldSocket.closed.length === 1 && oldSocket.closed[0].code === 1000 &&
        oldSocket.closed[0].reason === "bye" && reconnecting.open.includes(oldSocket) &&
        !wokeRoom.roomFromSockets().members.has("old-connection"),
    );

    const erroredSocket = fakeSocket();
    erroredSocket.serializeAttachment(attachedMember("errored-open-socket"));
    reconnecting.open.push(erroredSocket);
    await wokeRoom.webSocketError(erroredSocket);
    check(
      "a logically released socket is excluded even before readyState changes",
      erroredSocket.readyState === 1 &&
        !wokeRoom.roomFromSockets().members.has("errored-open-socket"),
    );

    // A room whose members have all gone but whose log has not yet been swept:
    // the next person to arrive is alone, and must still not seed, because the
    // replay is about to hand them the document.
    await roomObject.appendUpdate("QUJD");
    runtime.open.length = 0;
    await join("@afterwards");
    const thirdWelcome = pairs[2].server.frames().find((frame) => frame.t === "welcome");
    check(
      "a client alone in a room that still holds a log is not told to seed",
      thirdWelcome?.seed === false,
    );

    /* --------------- the room's copy of the note goes away --------------- */

    /*
      **The only bound on the second durable copy, and it had no test.**

      The two checks above pin that `replaceLog` is gone and that
      `dropLogBefore` takes a key — and a `dropLogBefore` that took one
      argument and cleared the whole prefix passes both. Neither says anything
      about the sentence this feature's cost rests on: the log is dropped when
      the room empties. A retention policy nobody checked is not a policy.

      Driven against the fake runtime, so neither method needs a
      `WebSocketPair` and the three behaviours are separable.
    */
    const retiring = fakeRoomRuntime();
    const retiringRoom = new PresenceRoom(retiring.state, {});
    await retiringRoom.appendUpdate("QUJD");
    await retiringRoom.appendUpdate("ZGVm");

    // Non-vacuity: there is something to drop, and somebody is still here.
    retiring.open.push(fakeSocket());
    check(
      "a room somebody is still in keeps its copy of the note",
      // The half that matters most: dropping while a socket is open would
      // delete the document out from under the people editing it, and the
      // elected writer's next flush would carry the loss to the bucket.
      (await retiringRoom.dropLogIfEmpty()) === false &&
        (await retiringRoom.readLog()).length === 2,
    );

    retiring.open.length = 0;
    check(
      "...and drops it once the last person leaves",
      (await retiringRoom.dropLogIfEmpty()) === true &&
        (await retiringRoom.readLog()).length === 0,
    );
    check(
      "...and says it did nothing when there was nothing to drop",
      // The answer the sweep reads to decide whether to keep its alarm: a room
      // that reported "dropped" every time would stop sweeping a room that
      // still had members arriving.
      (await retiringRoom.dropLogIfEmpty()) === false,
    );

    /*
      **And the sweep that performs the deletion stays scheduled.**

      `dropLogIfEmpty` is only ever called from `alarm()`, so a guard that
      deletes correctly and is never invoked bounds nothing. `ensureAlarm`'s
      own comment says the storage check is not redundant — without it the last
      socket closing cancels the sweep, and the note's content sits in Durable
      Object storage with nothing scheduled to remove it.
    */
    const emptying = fakeRoomRuntime();
    const emptyingRoom = new PresenceRoom(emptying.state, {});
    await emptyingRoom.appendUpdate("QUJD");
    await emptyingRoom.ensureAlarm();
    check(
      "an empty room that still holds a note keeps its sweep scheduled",
      typeof emptying.alarmAt() === "number",
    );

    const nothingLeft = fakeRoomRuntime();
    const nothingLeftRoom = new PresenceRoom(nothingLeft.state, {});
    await nothingLeftRoom.ensureAlarm();
    check(
      "...and a room with nobody in it and nothing stored schedules nothing",
      // Non-vacuity for the check above, and the reason the storage check is a
      // branch rather than an unconditional arm: a room nobody opened must be
      // evicted rather than woken forever.
      nothingLeft.alarmAt() === null,
    );
  });
}
