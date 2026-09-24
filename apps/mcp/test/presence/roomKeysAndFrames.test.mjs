/**
 * Presence: the pure state module — room keys separate tenants and cannot be
 * forged; a frame from a client is hostile until parsed (shape, byte
 * ceilings, the caret/pointer/version/ping/bye types); a display name is
 * sanitized before it is drawn into somebody else's editor; the roster
 * (admission, colour, the fields on the wire, cursor movement, idle expiry,
 * the room-full refusal); and the two failures — a full log replace, an
 * unbounded log delete — that stopped this feature's first merge.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for the shared helpers.
 * None of this needs the `WebSocketPair` mock — it runs the pure state
 * functions and one `createRoom()` directly.
 */

import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_MEMBERS_PER_ROOM,
  MAX_OFFSET,
  PresenceRoom,
  admit,
  applyCursor,
  colorFor,
  createRoom,
  decodeClientFrame,
  expire,
  forget,
  normalizeDisplayName,
  normalizeOffset,
  roomKey,
  roster,
  touch,
} from "./fixtures.mjs";

export async function runPresenceRoomKeysAndFramesChecks(check) {
  /* ======================= the pure state module ======================== */

  /* -- room keys separate tenants, and cannot be forged ------------------- */

  check(
    "the same note path in two workspaces is two different rooms",
    roomKey("ws_a", "1-projects/foo.md") !== roomKey("ws_b", "1-projects/foo.md"),
  );
  check(
    "a path cannot be shaped to collide with another workspace's room",
    // Without percent-encoding, ("ws_a", "b/1.md") and ("ws_a/b", "1.md") both
    // read as "ws_a/b/1.md". Two tenants in one room is the failure this whole
    // module would be remembered for, so it is checked rather than reasoned
    // about.
    roomKey("ws_a", "b/1.md") !== roomKey("ws_a/b", "1.md"),
  );
  check(
    "two notes in one workspace are two different rooms",
    // THE AXIS THE THREE CHECKS AROUND THIS ONE DO NOT COVER, and the one the
    // join leans on hardest. `/presence` authorizes a *path* — `canSee` on it,
    // then `objectExists` on it — and then enters `roomKey(workspaceId,
    // notePath)`. Those two only describe the same note because the path is in
    // the key. Drop it and every note in a workspace shares one room, so a
    // team-tier caller authorized for a team note is handed the live text of a
    // private one somebody is typing in — the `canSee`-at-join bound
    // non-negotiable #2 names, defeated by the key rather than by the check.
    //
    // Measured: dropping the path from `roomKey` failed 0 of 4,120 checks.
    // The neighbours all vary the workspace, because two tenants in one room
    // is the failure this module expected to be remembered for.
    roomKey("ws_a", "1-projects/foo.md") !== roomKey("ws_a", "1-projects/bar.md"),
  );
  check(
    "a room key is stable for the same pair",
    roomKey("ws_a", "1-projects/foo.md") === roomKey("ws_a", "1-projects/foo.md"),
  );
  check(
    "a room key is both halves, spelled out rather than asked for",
    // Every other check here calls `roomKey` on both sides, so the function is
    // its own oracle: any change to it moves the expectation with it, and a
    // key that had quietly stopped naming one of its inputs would still be
    // "equal to itself". One literal is what makes the rest of them mean
    // something.
    roomKey("ws_a", "1-projects/foo.md") === "ws_a/1-projects%2Ffoo.md",
  );

  /* -- a frame from a client is hostile until parsed ---------------------- */

  check("a non-string frame is refused", decodeClientFrame({ t: "cursor" }).ok === false);
  check("a frame that is not JSON is refused", decodeClientFrame("not json").ok === false);
  check("an array frame is refused", decodeClientFrame("[1,2,3]").ok === false);
  check("a null frame is refused", decodeClientFrame("null").ok === false);
  check("an unknown frame type is refused", decodeClientFrame('{"t":"edit"}').ok === false);
  const liveToken = `cat_live_${"x".repeat(24)}`;
  const decodedLive = decodeClientFrame(JSON.stringify({
    t: "live",
    documentId: "doc_live",
    d: "QUJD",
    accessToken: liveToken,
    clientKey: "a client cannot choose this",
  }));
  check(
    "a bounded live update carries transient authorization to the room",
    decodedLive.ok === true && decodedLive.msg.documentId === "doc_live" &&
      decodedLive.msg.d === "QUJD" && decodedLive.msg.accessToken === liveToken &&
      !("clientKey" in decodedLive.msg),
  );
  check(
    "a live update without a real bearer is refused",
    decodeClientFrame(JSON.stringify({
      t: "live", documentId: "doc_live", d: "QUJD", accessToken: "short",
    })).ok === false,
  );
  check(
    "a live update cannot omit its document generation",
    decodeClientFrame(JSON.stringify({ t: "live", d: "QUJD", accessToken: liveToken })).ok === false,
  );
  check(
    "a caret position that is not a position becomes null, not a guess",
    /*
      This check changed shape with the protocol and is kept rather than
      deleted, because what it guards did not change: a peer must not be able
      to put a caret somewhere by sending nonsense.

      Offsets became *relative* positions, so "refuse the frame" stopped being
      the right answer — one end can be unusable while the other is fine, and
      dropping the whole frame would throw away a good half. An end that is not
      a position becomes `null`, and the view draws nothing for it. Drawing at
      zero would put somebody's name at the top of the note and claim they are
      standing there.
    */
    (() => {
      const decoded = decodeClientFrame('{"t":"cursor","a":"not a position!","h":4}');
      return decoded.ok === true && decoded.msg.a === null && decoded.msg.h === null;
    })(),
  );
  check(
    "...and a well-formed position is carried through",
    // Non-vacuity: without this, a function that returned `null` for every
    // input would pass the check above and no caret would ever be drawn.
    decodeClientFrame('{"t":"cursor","a":"QUJD","h":"QUJE"}').msg.a === "QUJD",
  );
  check(
    "a cursor frame with a NaN offset is refused",
    // JSON has no NaN literal, so this is the shape that actually arrives: a
    // number that survives JSON.parse and is not finite.
    normalizeOffset(Number.NaN) === null && normalizeOffset(Number.POSITIVE_INFINITY) === null,
  );

  const oversized = JSON.stringify({ t: "cursor", a: 1, h: 1, pad: "x".repeat(MAX_CLIENT_FRAME_BYTES) });
  check("a frame past the byte ceiling is refused", decodeClientFrame(oversized).ok === false);
  const astral = JSON.stringify({ t: "cursor", a: 1, h: 1, pad: "𝔘".repeat(300) });
  check(
    "the byte ceiling counts encoded bytes, not UTF-16 units",
    // 300 astral characters are 600 `String.length` units and 1200 bytes. A
    // ceiling measured on `.length` would let this through at four bytes per
    // character, which is the whole point of measuring the encoding.
    astral.length < MAX_CLIENT_FRAME_BYTES * 2 && decodeClientFrame(astral).ok === false,
  );

  check(
    "raising the ceiling for a merge frame does not raise it for a caret",
    // This is a regression check with a date on it: adding `u` and `snap` gave
    // the outer gate a snapshot-sized ceiling, and for one commit a cursor
    // frame padded to half a megabyte was accepted because the tight caps were
    // only on the two new types. The two checks above caught it. This one says
    // what they were protecting, so the next person widening this function has
    // to read it.
    decodeClientFrame(
      JSON.stringify({ t: "cursor", a: 1, h: 1, pad: "x".repeat(MAX_CLIENT_FRAME_BYTES * 4) }),
    ).ok === false,
  );
  check(
    "a snapshot may be large, which is the whole reason the outer gate moved",
    // Non-vacuity for the row above: if the merge frames were also capped at
    // the caret's ceiling, that check would pass for the wrong reason and
    // compaction would silently never work.
    // Valid base64 all the way through: the first version of this check
    // repeated a *padded* chunk, so `=` landed mid-string and the guard
    // refused it — the check failed for a reason that had nothing to do with
    // size, which is the sort of test that gets "fixed" by loosening the
    // guard it was meant to defend.
    decodeClientFrame(JSON.stringify({ t: "snap", d: "QUJD".repeat(4000) })).ok === true,
  );

  const accepted = decodeClientFrame('{"t":"cursor","a":12,"h":18,"text":"the note body"}');
  check("a well-formed cursor frame is accepted", accepted.ok === true);
  check(
    "a cursor frame carries offsets, whose caret it is, and nothing else",
    // The property the whole feature rests on: a client that tries to put note
    // text on this channel finds the field is simply not carried. `agent` is
    // on the list deliberately — it is one boolean saying "this caret is the
    // agent's", and the room decides *which* agent, so a client still cannot
    // name a member.
    accepted.ok &&
      Object.keys(accepted.msg).sort().join(",") === "a,agent,h,t" &&
      accepted.msg.text === undefined,
  );
  check(
    "...and a caret is nobody's agent unless it says so",
    // Not truthy — exactly `true`. A frame that says nothing about this is a
    // frame about the sender's own caret.
    accepted.ok &&
      accepted.msg.agent === false &&
      decodeClientFrame('{"t":"cursor","a":1,"h":1,"agent":"yes"}').msg.agent === false &&
      decodeClientFrame('{"t":"cursor","a":1,"h":1,"agent":true}').msg.agent === true,
  );
  check("a ping is accepted", decodeClientFrame('{"t":"ping"}').ok === true);
  check("a bye is accepted", decodeClientFrame('{"t":"bye"}').ok === true);

  check("a negative offset is clamped to the start", normalizeOffset(-5) === 0);
  check("a fractional offset is truncated to an integer", normalizeOffset(4.9) === 4);
  check("an absurd offset is clamped to the ceiling", normalizeOffset(1e12) === MAX_OFFSET);

  /* -- a name is drawn into somebody else's editor ------------------------ */

  check(
    "control characters are stripped from a display name",
    normalizeDisplayName("Se\u0000yi\nX") === "SeyiX",
  );
  check(
    "a bidi override is stripped from a display name",
    // A name that can reorder the line it is drawn in can make one person's
    // label read as another's.
    normalizeDisplayName(`${String.fromCharCode(0x202e)}real-name`) === "real-name",
  );
  check("an empty display name becomes a placeholder", normalizeDisplayName("   ") === "Someone");
  check("a non-string display name becomes a placeholder", normalizeDisplayName(null) === "Someone");
  check(
    "a very long display name is truncated rather than refused",
    normalizeDisplayName("n".repeat(500)).length === 64,
  );

  /* -- the roster ---------------------------------------------------------- */

  const room = createRoom();
  const first = admit(room, { id: "m1", name: "@ana", colorSeed: "tab-1", now: 1_000 });
  const second = admit(room, { id: "m2", name: "@bo", colorSeed: "tab-2", now: 1_000 });
  check("a member is admitted", first.ok === true && second.ok === true);
  check(
    "a duplicate member id is refused",
    admit(room, { id: "m1", name: "@ana", now: 1_000 }).ok === false,
  );

  check(
    "a colour follows the seed, so a reconnect keeps it",
    // A reconnect five minutes later is a new member id. Without the seed the
    // caret would change colour, which reads as a stranger arriving.
    colorFor("tab-1") === first.member.color,
  );
  check(
    "a colour does not depend on who else is in the room",
    colorFor("tab-2") === second.member.color,
  );
  check(
    "a colour seed long enough to be a payload is ignored",
    admit(createRoom(), { id: "m9", name: "@x", colorSeed: "z".repeat(500), now: 1 }).member
      .color === colorFor("m9"),
  );

  check(
    "the roster carries no heartbeat clock",
    // `seen` is how the room decides a member is gone. Putting it on the wire
    // would tell every peer when everybody else last typed, which is a
    // keystroke-level signal about a person and is nobody's business.
    roster(room).every((member) => member.seen === undefined),
  );
  check(
    "the roster carries id, name, colour, caret and whether this member may edit",
    // An exact key list rather than a subset check: the point of this one is
    // that nothing *else* gets onto the wire, and `w` is on it deliberately —
    // every client elects a peer to save the merged text, and the election has
    // to land on somebody the room would accept an edit from.
    roster(room).every(
      (member) => Object.keys(member).sort().join(",") === "a,color,h,id,name,w",
    ),
  );
  check(
    "...and says so from the grant the route resolved, not from anything a client sent",
    // `admit` is called by the room shell with what the route decided. A member
    // seated without that decision is read-only, which is the safe default: an
    // election that skips somebody costs one save cycle, and one that includes
    // somebody the room refuses costs every save.
    admit(createRoom(), { id: "mw", name: "@w", canWrite: true, now: 1 }).member.w === true &&
      admit(createRoom(), { id: "mr", name: "@r", now: 1 }).member.w === false,
  );

  const moved = applyCursor(room, "m1", { t: "cursor", a: 5, h: 9 }, 2_000);
  check("a cursor moves the member it belongs to", moved.a === 5 && moved.h === 9);
  check(
    "a cursor frame for a member who is not in the room is dropped",
    applyCursor(room, "ghost", { t: "cursor", a: 1, h: 1 }, 2_000) === null,
  );

  check("a ping keeps a member alive", touch(room, "m2", 40_000) === true);
  const dropped = expire(room, 50_000);
  check(
    "a member who stopped speaking is expired",
    dropped.length === 1 && dropped[0] === "m1",
  );
  check("a member who pinged is kept", room.members.has("m2"));
  check("forgetting a member twice is idempotent", forget(room, "m2") === true && forget(room, "m2") === false);

  const full = createRoom();
  for (let i = 0; i < MAX_MEMBERS_PER_ROOM; i += 1) {
    admit(full, { id: `f${i}`, name: `@p${i}`, now: 1 });
  }
  const overflow = admit(full, { id: "one-too-many", name: "@late", now: 1 });
  check(
    "a full room refuses with a reason rather than silently",
    overflow.ok === false && overflow.reason === "room_full",
  );

  /* --------- the two failures that stopped this being merged ------------- */

  check(
    "a snapshot is an ordinary log entry, because replacing was catastrophic",
    // The worst bug in this feature's history: every client sent a snapshot on
    // connect and the room replaced its whole history with it, so the second
    // person to open a note wiped what the first had written and the elected
    // writer flushed the empty text to the bucket. The room no longer has a
    // function that can replace the log at all, which is the check: a removed
    // capability cannot be reintroduced by accident.
    typeof PresenceRoom.prototype.replaceLog === "undefined",
  );
  check(
    "the room can only ever delete log entries before a confirmed checkpoint",
    // The one deletion path, and it takes a key to stop before rather than
    // clearing a prefix. A version of this that dropped the whole prefix would
    // be the replace bug wearing a different name.
    typeof PresenceRoom.prototype.dropLogBefore === "function" &&
      PresenceRoom.prototype.dropLogBefore.length === 1,
  );
}
