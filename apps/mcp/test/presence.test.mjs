/**
 * WHO ELSE IS IN THIS NOTE — `src/presence.js`, `src/presenceRoom.js`, and the
 * `GET /presence` route.
 *
 * Presence is a *read* that happens to be a socket, and every check below is
 * written from that sentence. A caller who could not read the note cannot join
 * its room; a caller who can gets a roster of names and carets and nothing
 * else. Two properties are load-bearing enough to be worth saying before the
 * checks that prove them:
 *
 *  1. **No note text crosses this channel.** A client sends two integers and
 *     the server relays two integers. The checks assert the *shape* of a
 *     relayed frame rather than trusting the comment: a cursor frame carrying
 *     a `text` field arrives with that field gone.
 *  2. **A client cannot name itself, or pick its room.** The display name comes
 *     off the resolved session and the room key off the workspace that session
 *     resolved to, so a client that sends its own `x-presence-member` header or
 *     names another workspace in the URL gets neither. "Off the session" is not
 *     the end of that sentence, though, and the checks say which part of it:
 *     the session carries every context the connection may address, and the
 *     one that names the *person* is the personal one they own. A guest in
 *     somebody else's personal context has the host's at the head of that set.
 *
 * The room itself is a Durable Object and there is no `WebSocketPair` in node,
 * so what runs here is the pure state module in full plus the route up to the
 * point of dispatch — which is exactly where every refusal lives. The frames
 * the room sends are `presence.js` functions and are checked directly.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole gateway suite.
 *
 *   `presence` removed from RESERVED_FIRST_SEGMENTS (the route becomes a slug) 16
 *   `canSee` dropped from the route (any readable token joins any room)         2
 *   control characters left in a display name                                   2
 *   `x-presence-member` copied from the client instead of overwritten           1
 *   the byte ceiling measured with `String.length` rather than encoded bytes     1
 *   `normalizeOffset` accepting a non-integer unchanged                          1
 *   `expire` never dropping an idle member                                       1
 *   `/presence` removed from `isTransportPath` (no origin check on the socket)   1
 *   room key built from a workspace named in the URL rather than the session's   0
 *   `role === "owner"` dropped from `personalNameFor` (a guest is the host)     2
 *   the client's registered name consulted before the verified handle           2
 *   `kind === "personal"` dropped (a workspace slug labels a person)             2
 *   the slug clause dropped (an absent handle becomes `@null`)                   1
 *
 * The first two of those four share a fixture and therefore share their failures: the
 * team connection's client is registered as `@presencetest`, the host's own
 * handle, so a name that reaches the room from either the wrong context or the
 * wrong field is the same string. That is the hostile case rather than a tidy
 * one, and it is kept deliberately — a client that registers itself under the
 * handle of the person whose note it is about to sit in is the thing being
 * refused, and the two routes to it should both be red.
 *
 * The last two rows were **0** when first measured, because every fixture here
 * was a caller in one context. `kind` is now covered by a caller who owns a
 * *shared* context and a personal one, and the slug clause by a covered context
 * the control plane returned no name for. Both were closed rather than recorded
 * at zero: usernames and workspace slugs are one namespace, so `@sharedteam`
 * and `@null` are both well-formed handles for people who do not exist.
 *
 * **The room-key row, still at 0, is why this discipline is worth the time.**
 * Teaching the route
 * to read a workspace out of the query string reddened NOTHING: every tenancy
 * check here varied the *token*, so all of them passed while the URL quietly
 * picked the room. "Another workspace's token addresses its own room" is true
 * and was never the whole question. The two checks that now cover it — a
 * workspace named in the query string, and a slug for a context the grant does
 * not cover — exist because of that zero and not because anybody thought of
 * them while writing the route. The row is kept at 0 rather than restated at
 * its post-fix count, because what it records is the hole, not the patch.
 *
 * The first row is the opposite shape and worth its own sentence: sixteen
 * checks across this suite already depended on `/presence` naming a route
 * rather than a workspace, which is what it looks like when a name is load
 * bearing before anybody writes a test for it by that name.
 */

import worker from "../src/index.js";
import { PresenceRoom } from "../src/presenceRoom.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  MAX_CLIENT_FRAME_BYTES,
  MAX_MEMBERS_PER_ROOM,
  MAX_OFFSET,
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
} from "../src/presence.js";

const OWNER_TOKEN = `cat_presence_owner_${"0".repeat(14)}`;
const TEAM_TOKEN = `cat_presence_team_${"0".repeat(15)}`;
const OTHER_TOKEN = `cat_presence_other_${"0".repeat(14)}`;
const SHARED_TOKEN = `cat_presence_shared_${"0".repeat(13)}`;
const NOHANDLE_TOKEN = `cat_presence_nohandle_${"0".repeat(11)}`;

/** One team folder and one private note inside it, so a refusal is the rule. */
const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  "note_overrides:\n  1-projects/rates.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

/**
 * A Durable Object namespace that records rather than connects.
 *
 * The route's job ends at "address this room, with this member" — the socket
 * itself is the runtime's. So the stub keeps the name the route derived and the
 * header it set, which between them are the two things a client must not be
 * able to influence.
 */
function createRoomNamespaceStub() {
  const calls = [];
  return {
    calls,
    idFromName(name) {
      return { name, toString: () => name };
    },
    get(id) {
      return {
        async fetch(request, init) {
          // A notice from a tool arrives as a POST with a body rather than as
          // an upgrade, so the stub records the body where there is one.
          const asRequest = request instanceof Request ? request : new Request(request, init);
          calls.push({
            name: id.name,
            member: asRequest.headers.get("x-presence-member"),
            url: asRequest.url,
            body: asRequest.method === "POST" ? await asRequest.text() : null,
          });
          return new Response("joined", { status: 200 });
        },
      };
    },
  };
}

/** One MCP tool call, so the write path can be checked against the room. */
async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

async function presenceRequest(env, token, query, init = {}) {
  const { ctx, settle } = createWorkerCtx();
  const headers = { Upgrade: "websocket", ...(init.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  // `path` overrides the route entirely, for the one check that has to address
  // `/@slug/presence` rather than `/presence`.
  const target = init.path || `/presence${query}`;
  const response = await worker.fetch(
    new Request(`https://mcp.context.test${target}`, {
      method: init.method || "GET",
      headers,
    }),
    env,
    ctx,
  );
  const text = await response.text();
  await settle();
  return { status: response.status, text };
}

export async function runPresenceChecks(check) {
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
    "a room key is stable for the same pair",
    roomKey("ws_a", "1-projects/foo.md") === roomKey("ws_a", "1-projects/foo.md"),
  );

  /* -- a frame from a client is hostile until parsed ---------------------- */

  check("a non-string frame is refused", decodeClientFrame({ t: "cursor" }).ok === false);
  check("a frame that is not JSON is refused", decodeClientFrame("not json").ok === false);
  check("an array frame is refused", decodeClientFrame("[1,2,3]").ok === false);
  check("a null frame is refused", decodeClientFrame("null").ok === false);
  check("an unknown frame type is refused", decodeClientFrame('{"t":"edit"}').ok === false);
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
    "a cursor frame carries offsets and nothing else",
    // The property the whole feature rests on: a client that tries to put note
    // text on this channel finds the field is simply not carried.
    accepted.ok &&
      Object.keys(accepted.msg).sort().join(",") === "a,h,t" &&
      accepted.msg.text === undefined,
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
  const fakeSocket = () => {
    const sent = [];
    let attachment = null;
    return {
      sent,
      frames: () => sent.map((text) => JSON.parse(text)),
      send: (text) => sent.push(text),
      close: () => {},
      serializeAttachment: (value) => {
        attachment = value;
      },
      deserializeAttachment: () => attachment,
    };
  };

  const fakeRoomRuntime = () => {
    const open = [];
    const stored = new Map();
    return {
      open,
      state: {
        acceptWebSocket: (ws) => open.push(ws),
        getWebSockets: () => [...open],
        storage: {
          async get(key) {
            return stored.get(key);
          },
          async put(entries) {
            for (const [key, value] of Object.entries(entries)) stored.set(key, value);
          },
          async list({ prefix = "", end } = {}) {
            const hits = [...stored.entries()]
              .filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end))
              .sort(([a], [b]) => a.localeCompare(b));
            return new Map(hits);
          },
          async delete(keys) {
            for (const key of keys) stored.delete(key);
          },
          async deleteAll() {
            stored.clear();
          },
          async setAlarm() {},
          async getAlarm() {
            return null;
          },
        },
      },
    };
  };

  // `WebSocketPair` is a Workers global. The object under test only ever uses
  // it to get two ends; the fake gives it two ends it can inspect.
  const previousPair = globalThis.WebSocketPair;
  const pairs = [];
  globalThis.WebSocketPair = function FakePair() {
    const client = fakeSocket();
    const server = fakeSocket();
    pairs.push({ client, server });
    return [client, server];
  };
  try {
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

    /* ------------------ asking peers what you are missing ---------------- */

    const askingRuntime = fakeRoomRuntime();
    const askingRoom = new PresenceRoom(askingRuntime.state, {});
    const seatAt = (index) => askingRuntime.open[index];
    const joinAsking = async (name, canWrite) => {
      try {
        await askingRoom.fetch(
          new Request("https://gateway.invalid/presence", {
            headers: {
              Upgrade: "websocket",
              "x-presence-member": JSON.stringify({ name, colorSeed: null, canWrite }),
            },
          }),
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    };

    await joinAsking("@writer", true);
    await joinAsking("@reader", false);
    const writerSocket = seatAt(0);
    const readerSocket = seatAt(1);
    const before = writerSocket.sent.length;

    // The reader asks. It holds no write authority at all.
    await askingRoom.webSocketMessage(readerSocket, JSON.stringify({ t: "ask", d: "QUJD" }));
    const relayed = writerSocket.frames().slice(before);
    check(
      "a read-only member may ask its peers what the note says",
      // Asking is a read, and a member holds exactly that. Routing this through
      // the edit frame — which it was — left a reader unable to sync from
      // anybody, dependent on whatever the room's log happened to still hold.
      relayed.some((frame) => frame.t === "y" && frame.d === "QUJD"),
    );
    check(
      "...and the question is never written to the room's log",
      // A state vector describes one client's ignorance at one instant. Logged,
      // it conveys no text to anybody replaying the room later and still counts
      // towards the compaction threshold.
      (await askingRoom.readLog()).length === 0,
    );

    /* ------------ a tool wrote the note somebody has open ---------------- */

    const external = async (room, body) =>
      room.fetch(
        new Request("https://presence.invalid/external", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const writerBeforeNotice = writerSocket.sent.length;
    const readerBeforeNotice = readerSocket.sent.length;
    const delivered = await external(askingRoom, { text: "# From an agent\n", etag: "e2" });
    check(
      "a tool's write is handed to exactly one member, who may edit",
      // Not broadcast: every client merging the same text into its own copy of
      // the shared document would insert those characters once per client,
      // because each copy generates its own operations for them. And not to
      // the reader, whose merge the room would refuse — which would hand the
      // note's new text to the one member guaranteed not to be able to share
      // it.
      (await delivered.json()).delivered === true &&
        writerSocket.frames().slice(writerBeforeNotice).some(
          (frame) => frame.t === "external" && frame.text === "# From an agent\n" && frame.etag === "e2",
        ) &&
        readerSocket.sent.length === readerBeforeNotice,
    );

    const readersOnly = fakeRoomRuntime();
    const readersOnlyRoom = new PresenceRoom(readersOnly.state, {});
    try {
      await readersOnlyRoom.fetch(
        new Request("https://presence.invalid/presence", {
          headers: {
            Upgrade: "websocket",
            "x-presence-member": JSON.stringify({ name: "@r", colorSeed: null, canWrite: false }),
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    const nobody = await external(readersOnlyRoom, { text: "# From an agent\n", etag: "e3" });
    check(
      "a room in which nobody may edit is told, and drops the notice",
      // A real state rather than an error: those clients see the write at
      // their next reconnect, and the canonical copy was in the bucket before
      // this room heard about it at all.
      (await nobody.json()).delivered === false &&
        readersOnly.open[0].frames().every((frame) => frame.t !== "external"),
    );

    const malformed = await external(askingRoom, { etag: "e4" });
    check(
      "a notice with no text is refused rather than merged as an empty note",
      // `mergeExternalText` against "" deletes everything. A frame this room
      // does not understand must never be able to mean that.
      malformed.status === 400,
    );

    const writerFramesBeforeEdit = writerSocket.sent.length;
    await askingRoom.webSocketMessage(readerSocket, JSON.stringify({ t: "y", d: "ZGVm" }));
    check(
      "...while an edit from the same read-only member still reaches nobody",
      // The distinction the whole `ask` type rests on: the reader may ask, and
      // may not answer. Non-vacuous — the writer's socket received the ask a
      // moment ago, so "no new frame" is a fact about this frame.
      writerSocket.sent.length === writerFramesBeforeEdit &&
        (await askingRoom.readLog()).length === 0,
    );
  } finally {
    if (previousPair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = previousPair;
  }

  /* ============================== the route ============================== */

  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const otherBucket = createBucket();
    controlPlane.addWorkspace("ws_presence", "presencetest", {
      provider: "r2-binding",
      bindingName: "PRESENCE_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    controlPlane.addWorkspace("ws_other", "othertest", {
      provider: "r2-binding",
      bindingName: "OTHER_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    // The team connection's *own* personal context. `ws_presence` is somebody
    // else's personal context that they were let into, which is the ordinary
    // shape of "a person granting you access" and the one that decides whose
    // handle a caret carries.
    controlPlane.addWorkspace("ws_teamhome", "teamhome", {
      provider: "r2-binding",
      bindingName: "OTHER_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    // A shared context this person owns, and their own personal one. Slugs and
    // usernames are one namespace, so `@sharedteam` in a caret label is not
    // distinguishable from a person of that name — a workspace slug must never
    // be what labels a person.
    controlPlane.addWorkspace(
      "ws_shared",
      "sharedteam",
      {
        provider: "r2-binding",
        bindingName: "OTHER_BUCKET",
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
        status: "active",
      },
      { kind: "shared" },
    );
    controlPlane.addWorkspace("ws_ownhome", "ownhome", {
      provider: "r2-binding",
      bindingName: "OTHER_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_presence",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_presence_owner",
      userId: "user_presence_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_presence",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_presence_team",
      userId: "user_presence_team",
      // Asserted at registration by whoever registered the client, and shaped
      // to be mistaken for the host's handle. It must lose to the verified one.
      clientName: "@presencetest",
      alsoMemberOf: [{ workspaceId: "ws_teamhome", role: "owner" }],
    });
    await controlPlane.addGrant({
      accessToken: OTHER_TOKEN,
      workspaceId: "ws_other",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_presence_other",
      userId: "user_presence_other",
    });
    // Approved against the shared context, so that is the head of the covered
    // set — the same position `ws_presence` occupies for the guest above.
    await controlPlane.addGrant({
      accessToken: SHARED_TOKEN,
      workspaceId: "ws_shared",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_presence_shared",
      userId: "user_presence_shared",
      alsoMemberOf: [{ workspaceId: "ws_ownhome", role: "owner" }],
    });
    // A control plane older than the slug field, or one that answered with a
    // context it has no name for. `ws_nameless` is deliberately never added, so
    // the stub reports it with a null slug exactly as `normalizeSession` would.
    await controlPlane.addGrant({
      accessToken: NOHANDLE_TOKEN,
      workspaceId: "ws_shared",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_presence_nohandle",
      userId: "user_presence_nohandle",
      clientName: "Someone's Claude",
      alsoMemberOf: [{ workspaceId: "ws_nameless", role: "owner" }],
    });

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/roadmap.md", "the roadmap, for everyone here");
    bucket.seed("1-projects/rates.md", "RATESECRET what we charge");
    otherBucket.seed("privacy.md", MANIFEST);
    otherBucket.seed("1-projects/roadmap.md", "a different workspace's roadmap");

    const rooms = createRoomNamespaceStub();
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "PRESENCE_BUCKET,OTHER_BUCKET",
      PRESENCE_BUCKET: bucket,
      OTHER_BUCKET: otherBucket,
      PRESENCE_ROOM: rooms,
    };

    /* -- non-vacuity: the happy path actually reaches a room --------------- */

    const joined = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md&seed=tab-a");
    check("a team connection joins a team note's room", joined.status === 200);
    check(
      "the room addressed is the one the session's workspace names",
      rooms.calls.at(-1)?.name === roomKey("ws_presence", "1-projects/roadmap.md"),
    );

    const member = JSON.parse(rooms.calls.at(-1)?.member || "null");
    check(
      "a guest's caret carries their own handle, not the host's",
      // `ws_presence` is somebody else's *personal* context that this person
      // was let into, so it is the first personal row in their covered set and
      // it carries the host's slug. A caret labelled with it puts the guest in
      // the room under the name of the person whose note it is — visible to
      // that person, in their own note. The handle has to come from the one
      // context in the set this caller actually owns.
      member?.name === "@teamhome",
    );
    check(
      "the client's registered name never stands in for a handle it does not have",
      // `clientName` is asserted at an unauthenticated registration endpoint
      // and decides nothing anywhere else. Shaped like a handle, it must still
      // lose to the verified one.
      member?.name !== "@presencetest",
    );

    const sharedJoin = await presenceRequest(env, SHARED_TOKEN, "?note=1-projects/roadmap.md");
    check(
      "a caret in a shared context is labelled with a person, never the context",
      // The grant was approved against the shared context, so it heads this
      // caller's covered set exactly as the host's personal one heads the
      // guest's. Owning it is not being named by it: a workspace slug and a
      // username come from one global namespace, so `@sharedteam` on a caret
      // reads as a person who does not exist.
      sharedJoin.status === 200 &&
        JSON.parse(rooms.calls.at(-1)?.member || "null")?.name === "@ownhome",
    );

    const noHandle = await presenceRequest(env, NOHANDLE_TOKEN, "?note=1-projects/roadmap.md");
    check(
      "a caller the control plane gave no handle for is named by their client, not by @null",
      // The slug is required by the schema, so this is what a control plane
      // older than the field looks like rather than something a caller can
      // arrange. What must not happen is a handle being *assembled* out of a
      // missing one: `@null` is a well-formed handle in a namespace where
      // usernames and workspace slugs are the same words.
      noHandle.status === 200 &&
        JSON.parse(rooms.calls.at(-1)?.member || "null")?.name === "Someone's Claude",
    );
    check("the colour seed is carried through", member?.colorSeed === "tab-a");

    /* -- read opens the socket; write is a separate question --------------- */

    const readerToken = `cat_presence_reader_${"0".repeat(13)}`;
    await controlPlane.addGrant({
      accessToken: readerToken,
      workspaceId: "ws_presence",
      role: "member",
      scopes: ["context:read"],
      clientId: "mcp_client_presence_reader",
      userId: "user_presence_reader",
    });

    const readerJoins = await presenceRequest(env, readerToken, "?note=1-projects/roadmap.md");
    check(
      "a read-only connection may still open the socket",
      // Watching somebody edit is a read. Refusing this would make presence a
      // write feature, which is not what it is.
      readerJoins.status === 200,
    );
    const readerMember = JSON.parse(rooms.calls.at(-1)?.member || "null");
    check(
      "...and is marked as unable to write, by the server",
      // Non-negotiable #4: write access to somebody else's context is never
      // implied by read. Without this the room applies a reader's edits and
      // the elected writer flushes them to the owner's bucket.
      readerMember?.canWrite === false,
    );

    await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md");
    const editorMember = JSON.parse(rooms.calls.at(-1)?.member || "null");
    check(
      "an editor connection is marked as able to write",
      // Non-vacuity: if `canWrite` were false for everybody the check above
      // would pass while the feature did nothing at all.
      editorMember?.canWrite === true,
    );

    /* -- a client cannot name itself --------------------------------------- */

    await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md", {
      headers: { "x-presence-member": JSON.stringify({ name: "@theowner", colorSeed: "x" }) },
    });
    const forged = JSON.parse(rooms.calls.at(-1)?.member || "null");
    check(
      "a client's own member header is overwritten, not honoured",
      forged?.name !== "@theowner",
    );

    /* -- presence is a read, and refuses exactly like one ------------------ */

    const privateNote = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/rates.md");
    check(
      "a team connection cannot join a private note's room",
      privateNote.status === 404,
    );
    const missingNote = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/nothing.md");
    check(
      "a private note and a missing note refuse identically",
      // The refusal must not be an oracle for "this note exists". Same status,
      // same body, or the socket answers a question the read path will not.
      missingNote.status === privateNote.status && missingNote.text === privateNote.text,
    );
    const ownerJoins = await presenceRequest(env, OWNER_TOKEN, "?note=1-projects/rates.md");
    check(
      "the owner joins the private note's room",
      // Non-vacuity for the two refusals above: the note is reachable by
      // somebody, so 404 is the rule and not a broken manifest.
      ownerJoins.status === 200,
    );
    check(
      "the owner of a personal context is the one caret that carries its handle",
      // The other half of the guest check, and the reason it cannot be passed
      // by a function that has stopped producing handles at all: exactly one
      // person in this workspace is `@presencetest`, and it is this one.
      JSON.parse(rooms.calls.at(-1)?.member || "null")?.name === "@presencetest",
    );

    /* -- one tenant cannot reach another's room ---------------------------- */

    const callsBefore = rooms.calls.length;
    await presenceRequest(env, OTHER_TOKEN, "?note=1-projects/roadmap.md");
    check(
      "another workspace's token addresses its own room, never the first's",
      rooms.calls.length === callsBefore + 1 &&
        rooms.calls.at(-1)?.name === roomKey("ws_other", "1-projects/roadmap.md"),
    );

    // ...and the URL cannot pick the room either. This pair is the half the
    // check above does not cover, and it is here because sabotage said so:
    // teaching the route to read a workspace out of the query string reddened
    // NOTHING, since every check until now varied the token and none varied the
    // URL. A room is addressed from the grant, so a query parameter naming
    // another workspace is ignored and a slug naming one the grant does not
    // cover is refused outright.
    const beforeParam = rooms.calls.length;
    await presenceRequest(
      env,
      TEAM_TOKEN,
      "?note=1-projects/roadmap.md&ws=ws_other&workspaceId=ws_other&workspace=othertest",
    );
    check(
      "a workspace named in the query string does not move the room",
      rooms.calls.length === beforeParam + 1 &&
        rooms.calls.at(-1)?.name === roomKey("ws_presence", "1-projects/roadmap.md"),
    );

    const beforeSlug = rooms.calls.length;
    const foreignSlug = await presenceRequest(
      env,
      TEAM_TOKEN,
      "",
      { path: "/@othertest/presence?note=1-projects/roadmap.md" },
    );
    check(
      "a slug naming a workspace this grant does not cover is refused",
      foreignSlug.status === 403 && rooms.calls.length === beforeSlug,
    );

    /* -- the refusals before any of that ----------------------------------- */

    const anonymous = await presenceRequest(env, null, "?note=1-projects/roadmap.md");
    check("an unauthenticated socket is refused", anonymous.status === 401);

    const wrongMethod = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md", {
      method: "POST",
    });
    check("a non-GET presence request is refused", wrongMethod.status === 405);

    const noUpgrade = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md", {
      headers: { Upgrade: "" },
    });
    check("a presence request without an upgrade is refused", noUpgrade.status === 426);

    const traversal = await presenceRequest(env, TEAM_TOKEN, "?note=../../etc/passwd");
    check("a traversing note path is refused", traversal.status === 400);
    const encodedTraversal = await presenceRequest(env, TEAM_TOKEN, "?note=%2e%2e%2ffoo.md");
    check("a percent-encoded traversal is refused too", encodedTraversal.status === 400);
    const newline = await presenceRequest(env, TEAM_TOKEN, "?note=a%0Ab.md");
    check("a note path with a newline is refused", newline.status === 400);
    const noNote = await presenceRequest(env, TEAM_TOKEN, "");
    check("a presence request naming no note is refused", noNote.status === 400);

    /* -- a browser origin is checked, because a socket has no CORS --------- */

    const badOrigin = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md", {
      headers: { Origin: "https://evil.test" },
    });
    check(
      "a socket from an unlisted browser origin is refused",
      // A WebSocket handshake is not subject to CORS, so a page on any origin
      // could otherwise open this and read every frame in the room.
      badOrigin.status === 403,
    );

    /* -- a tool's write reaches the room for that note --------------------- */

    const writesBefore = rooms.calls.length;
    const written = await callTool(env, TEAM_TOKEN, "write_note", {
      path: "1-projects/roadmap.md",
      content: "the roadmap, for everyone here\n\nand a line an agent added\n",
      summary: "an agent writing a note somebody has open",
    });
    const notice = rooms.calls.slice(writesBefore).find((call) => call.body !== null);
    check(
      "a tool's write tells the room for that note, in that workspace",
      // The room key is derived from the session's own workspace and the path
      // that was written — the same derivation the socket route uses, so a
      // notice can never land in another tenant's room.
      written.startsWith("written:") &&
        notice?.name === roomKey("ws_presence", "1-projects/roadmap.md"),
    );
    check(
      "...and carries the text it stored and the version it produced",
      // The etag is the half that makes this more than a redraw: whoever merges
      // it saves next against the version the tool left, rather than raising a
      // conflict about a change already in the text being saved.
      (() => {
        const body = JSON.parse(notice?.body ?? "null");
        return (
          body?.text === "the roadmap, for everyone here\n\nand a line an agent added\n" &&
          typeof body.etag === "string" &&
          body.etag.length > 0
        );
      })(),
    );

    /* -- a deployment without the binding degrades honestly ---------------- */

    const { PRESENCE_ROOM: _unbound, ...envWithoutRooms } = env;
    const unavailable = await presenceRequest(
      envWithoutRooms,
      TEAM_TOKEN,
      "?note=1-projects/roadmap.md",
    );
    check(
      "a deployment with no presence binding answers 501 rather than throwing",
      unavailable.status === 501,
    );
  } finally {
    restore();
  }
}
