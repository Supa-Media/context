/**
 * A keyed rename tells the room that held the old name (`live/presence.js`,
 * `announceMovedToPresence`): every socket on that room hears `moved` with the
 * new name, and is closed to reconnect, so nothing keeps editing the old name
 * silently. A reconnect at the old name finds no note there, as after a byte move.
 *
 * Sabotage, confirmed to fail a case here:
 *  - drop the `broadcast` and the members never learn the destination;
 *  - close with another code and the reconnect contract (4001) is broken;
 *  - accept any `to` and a room can be told to point people anywhere.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PresenceRoom } from "../../src/presenceRoom.js";
import { CLOSE_REAUTHORIZE } from "../../src/presenceRoom/wire.js";
import { fakeRuntime } from "../agentActivityFixtures.mjs";

function socketFor(id) {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    attachment: { id, clientKey: id.padEnd(16, "0"), collaborationVersion: 2 },
    send(text) {
      this.sent.push(JSON.parse(text));
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function movedRequest(body) {
  return new Request("https://presence.invalid/moved", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("a moved notice reaches every member of the old room and closes each to reconnect", async () => {
  const runtime = fakeRuntime();
  const first = socketFor("m1");
  const second = socketFor("m2");
  runtime.state.getWebSockets = () => [first, second];
  const room = new PresenceRoom(runtime.state, {});

  const answer = await room.fetch(movedRequest({ to: "2-areas/a.md" }));

  assert.equal(answer.status, 200);
  for (const socket of [first, second]) {
    // Releasing each member broadcasts `leave` to the rest, so the notice is one frame among them.
    assert.ok(socket.sent.some((frame) => frame.t === "moved" && frame.to === "2-areas/a.md"), "the member heard the notice");
    assert.equal(socket.closed.code, CLOSE_REAUTHORIZE);
  }
});

test("a moved notice names a note path, and nothing else is accepted", async () => {
  const runtime = fakeRuntime();
  const socket = socketFor("m1");
  runtime.state.getWebSockets = () => [socket];
  const room = new PresenceRoom(runtime.state, {});

  assert.equal((await room.fetch(movedRequest({ to: "2-areas/a.txt" }))).status, 400);
  assert.equal((await room.fetch(movedRequest({ to: "" }))).status, 400);
  assert.equal((await room.fetch(movedRequest({ to: 7 }))).status, 400);
  assert.equal((await room.fetch(movedRequest("{not json"))).status, 400);
  assert.equal((await room.fetch(new Request("https://presence.invalid/moved", { method: "GET" }))).status, 405);
  assert.deepEqual(socket.sent, [], "a refused notice tells nobody anything");
  assert.equal(socket.closed, null);
});
