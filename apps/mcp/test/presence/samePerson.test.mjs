/**
 * Presence: your own other windows are you, not a colleague.
 *
 * The same person with a note open in the Mac app and a browser tab is two
 * members of its room, and each drew the other as a peer's caret: their own
 * name, in a colour they never chose, parked where they last typed. The room
 * now tells each socket which of its peers are the same person (`me: true`),
 * on the welcome roster and on every join, and never says who anybody else is.
 */

import { PresenceRoom, fakeRoomRuntime, withFakeWebSocketPair } from "./fixtures.mjs";

export async function runPresenceSamePersonChecks(check) {
  await withFakeWebSocketPair(async () => {
    const runtime = fakeRoomRuntime();
    const room = new PresenceRoom(runtime.state, {});
    const join = async (name, accountKey) => {
      try {
        await room.fetch(
          new Request("https://gateway.invalid/presence", {
            headers: {
              Upgrade: "websocket",
              "x-presence-member": JSON.stringify({ name, colorSeed: null, canWrite: true, accountKey }),
            },
          }),
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
      return runtime.open.at(-1);
    };

    const browser = await join("@seyi", "acct-seyi");
    const colleague = await join("@priya", "acct-priya");
    const mac = await join("@seyi", "acct-seyi");
    const nobody = await join("@tool", null);
    const nobodyElse = await join("@other tool", null);

    const browserId = browser.deserializeAttachment().id;
    const colleagueId = colleague.deserializeAttachment().id;
    const macId = mac.deserializeAttachment().id;

    const macWelcome = mac.frames().find((frame) => frame.t === "welcome");
    const byId = (frame, id) => frame?.members.find((one) => one.id === id);
    check(
      "a welcome marks the person's own other window as theirs",
      byId(macWelcome, browserId)?.me === true,
    );
    check(
      "...and never a colleague",
      byId(macWelcome, colleagueId) !== undefined && byId(macWelcome, colleagueId).me === undefined,
    );

    const joinOf = (socket, id) => socket.frames().find((frame) => frame.t === "join" && frame.member.id === id);
    check(
      "a join is marked as theirs for the person's own other window",
      joinOf(browser, macId)?.member.me === true,
    );
    check(
      "...and plain for everybody else in the room",
      joinOf(colleague, macId) !== undefined && joinOf(colleague, macId).member.me === undefined,
    );

    const nobodyWelcome = nobody.frames().find((frame) => frame.t === "welcome");
    check(
      "a socket with no person behind it is nobody's other window",
      // Two absent keys are not the same person: null must never match null.
      nobodyWelcome.members.every((one) => one.me === undefined) &&
        joinOf(nobody, nobodyElse.deserializeAttachment().id)?.member.me === undefined &&
        nobodyElse.frames().find((frame) => frame.t === "welcome").members.every((one) => one.me === undefined),
    );
    check(
      "the key itself never goes on the wire",
      ![browser, colleague, mac, nobody, nobodyElse].some((socket) => socket.sent.some((text) => text.includes("acct-"))),
    );
  });
}
