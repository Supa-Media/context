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
  MEMBER_IDLE_MS,
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
    let alarm = null;
    return {
      open,
      alarmAt: () => alarm,
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
          async list({ prefix = "", end, limit } = {}) {
            const hits = [...stored.entries()]
              .filter(([key]) => key.startsWith(prefix) && (end === undefined || key < end))
              .sort(([a], [b]) => a.localeCompare(b));
            // `limit` is honoured because `ensureAlarm` passes one, and a fake
            // that ignored it would be testing a call the runtime does not make.
            return new Map(typeof limit === "number" ? hits.slice(0, limit) : hits);
          },
          async delete(keys) {
            for (const key of keys) stored.delete(key);
          },
          async deleteAll() {
            stored.clear();
          },
          async setAlarm(at) {
            alarm = at;
          },
          async getAlarm() {
            return alarm;
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

    /* ------------------ asking peers what you are missing ---------------- */

    /** One notice from the gateway, as `announceWriteToPresence` sends it. */
    const external = async (room, body) =>
      room.fetch(
        new Request("https://presence.invalid/external", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );

    const askingRuntime = fakeRoomRuntime();
    const askingRoom = new PresenceRoom(askingRuntime.state, {});
    const seatAt = (index) => askingRuntime.open[index];
    const joinTo = async (room, name, canWrite, clientKey = null) => {
      try {
        await room.fetch(
          new Request("https://gateway.invalid/presence", {
            headers: {
              Upgrade: "websocket",
              "x-presence-member": JSON.stringify({ name, colorSeed: null, canWrite, clientKey }),
            },
          }),
        );
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    };

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
      relayed.some((frame) => frame.t === "ask" && frame.d === "QUJD"),
    );
    check(
      "...and it arrives as an ask, never as an edit",
      /*
        **This check replaces one that pinned the bug.**

        It used to assert the relay arrived as `t: "y"`, one line above "an
        edit from the same read-only member still reaches nobody" — and the
        first defeated the second. A peer reads a `y` with the protocol's own
        reader, which chooses between answering and *applying* on a type byte
        inside the payload that the sender supplies. So an `ask` carrying an
        ordinary update was an edit by the member the write gate had refused
        one line earlier, applied by every peer and flushed to the bucket.

        This room cannot tell a state vector from an update and must not learn
        how: it holds no Yjs and the bytes are opaque by design. Keeping the
        type is what lets the client tell them apart.
      */
      relayed.every((frame) => frame.t !== "y"),
    );
    check(
      "...and the question is never written to the room's log",
      // A state vector describes one client's ignorance at one instant. Logged,
      // it conveys no text to anybody replaying the room later and still counts
      // towards the compaction threshold.
      (await askingRoom.readLog()).length === 0,
    );

    /* --------------- the tool that wrote it is in the room --------------- */

    const agentBefore = readerSocket.sent.length;
    const agentWriterBefore = writerSocket.sent.length;
    await external(askingRoom, {
      text: "# From an agent\n",
      etag: "e9",
      actor: { id: "0123456789abcdef", name: "Somebody's Claude" },
    });
    const seated = readerSocket.frames().slice(agentBefore).find((frame) => frame.t === "join");
    check(
      "a tool that writes a note joins the room as a member",
      /*
        Somebody watching a note change should see *who* is changing it. A tool
        holds no socket and never will, but a caret needs a roster entry and
        the join frame already builds one — so it is announced as a member
        rather than given a parallel concept the client would have to learn.
      */
      seated?.member?.name === "Somebody's Claude" && seated.member.g === true,
    );
    check(
      "...with an id the room built, never the control plane's own",
      // A digest arrives from the gateway; the room prefixes it so an agent id
      // cannot collide with the uuid of a seated member.
      typeof seated?.member?.id === "string" &&
        seated.member.id.startsWith("a:") &&
        seated.member.id.includes("0123456789abcdef"),
    );
    check(
      "...and is never elected to save, because it has no socket to save from",
      seated?.member?.w === false,
    );
    check(
      "...and everybody in the room is told, not only the one that merges",
      writerSocket.frames().slice(agentWriterBefore).some((frame) => frame.t === "join"),
    );

    const caretBefore = readerSocket.sent.length;
    await askingRoom.webSocketMessage(
      writerSocket,
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    const stamped = readerSocket.frames().slice(caretBefore).find((frame) => frame.t === "cursor");
    check(
      "the agent's caret is reported by the client that merged its write",
      // The tool cannot report its own: it has no socket. The one member the
      // room asked to merge knows where the change landed and says so.
      stamped?.id === seated?.member?.id,
    );
    check(
      "...and a client saying 'this is the agent's' cannot say which member",
      /*
        The spoof `admit` exists to prevent, arriving through the back door. A
        client sends one boolean; the room supplies the id from the write it
        just relayed, so there is no frame a peer can send that moves somebody
        else's caret.
      */
      (() => {
        const decoded = decodeClientFrame(
          JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true, id: "a:pick-me" }),
        );
        return decoded.ok && decoded.msg.id === undefined;
      })(),
    );

    /*
      AND ONLY THE CLIENT THE ROOM HANDED THE WRITE TO MAY REPORT IT.

      The boolean says *that* a caret is the agent's and the room supplies
      *which* agent — so no peer can move a named member's caret. That closes
      the spoof at the id and leaves the other half open: the frame carries no
      id, so any socket may send it, and the room drew whatever arrived.

      Within the idle window after a tool's write, that let **any** member
      place the agent's caret anywhere in the document, in everybody's window.
      A read-only one included: `cursor` is deliberately ungated, because
      watching somebody edit is a read — so the one member the room refuses
      every edit from could still point a named agent at text it never wrote.

      The room already knows who it gave the write to. That is the party whose
      report means anything, and it is now the only one accepted.
    */
    const notMergerBefore = writerSocket.sent.length;
    await askingRoom.webSocketMessage(
      readerSocket,
      JSON.stringify({ t: "cursor", a: "c3Bvb2Y", h: "c3Bvb2Y", agent: true }),
    );
    check(
      "a member the room did not hand the write to cannot report the agent's caret",
      writerSocket
        .frames()
        .slice(notMergerBefore)
        .every((frame) => !(frame.t === "cursor" && frame.id === seated?.member?.id)),
    );
    check(
      "...and a read-only member cannot either, though its own caret still moves",
      /*
        The pair that makes the rule the right one rather than merely strict:
        a reader is still present, still draws a caret, and still cannot speak
        for the agent. Refusing every cursor from a reader would pass the check
        above and delete presence for the people it is most for.
      */
      await (async () => {
        const before = writerSocket.sent.length;
        await askingRoom.webSocketMessage(
          readerSocket,
          JSON.stringify({ t: "cursor", a: "b3du", h: "b3du" }),
        );
        return writerSocket
          .frames()
          .slice(before)
          .some((frame) => frame.t === "cursor" && frame.id !== seated?.member?.id);
      })(),
    );

    /*
      AND THE CANVAS HALF OF THE SAME RULE, WHICH HAD NO CHECK AT ALL.

      Measured: reverting the pointer path alone, and leaving the caret path
      fixed, reddened **0**. The agent's pointer is the same claim in the other
      shape — a boolean, no id, the room supplying the name — and a canvas is
      the half this feature calls a real hole, so it gets the same pair.
    */
    const pointerBefore = writerSocket.sent.length;
    await askingRoom.webSocketMessage(
      readerSocket,
      JSON.stringify({ t: "pointer", x: 10, y: 20, s: [], agent: true }),
    );
    check(
      "a member the room did not hand the write to cannot report the agent's pointer",
      writerSocket
        .frames()
        .slice(pointerBefore)
        .every((frame) => !(frame.t === "pointer" && frame.id === seated?.member?.id)),
    );
    check(
      "...while its own pointer still reaches the room",
      // The control, for the same reason as the caret's: refusing every
      // pointer from a reader would pass the check above and delete the thing
      // presence is for.
      await (async () => {
        const before = writerSocket.sent.length;
        await askingRoom.webSocketMessage(
          readerSocket,
          JSON.stringify({ t: "pointer", x: 11, y: 21, s: [] }),
        );
        return writerSocket
          .frames()
          .slice(before)
          .some((frame) => frame.t === "pointer" && frame.id !== seated?.member?.id);
      })(),
    );

    const noAgent = fakeRoomRuntime();
    const noAgentRoom = new PresenceRoom(noAgent.state, {});
    await joinTo(noAgentRoom, "@alone", true);
    await joinTo(noAgentRoom, "@watcher", true);
    const watcherBefore = noAgent.open[1].sent.length;
    await noAgentRoom.webSocketMessage(
      noAgent.open[0],
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    check(
      "a room no tool has written to draws no agent caret at all",
      // Non-vacuity, and the honest failure mode: a room that hibernated
      // between the write and the caret has forgotten whose it was, and draws
      // nothing rather than guessing.
      noAgent.open[1].frames().slice(watcherBefore).every((frame) => frame.t !== "cursor"),
    );

    /*
      AND THE CARET IS ONLY EVER ABOUT THE WRITE THAT JUST LANDED.

      An agent caret is reported by a *client*, with a boolean and no id — the
      room supplies the id from the write it last relayed. Unbounded, that is a
      frame a client can send at any later moment to move a tool's caret
      anywhere it likes, hours after the tool finished: not a member it can
      impersonate, but a name in the roster it can point at text the tool never
      wrote. The honest claim was only ever about the write that had just
      landed, so the room keeps it exactly that long.
    */
    const staleRuntime = fakeRoomRuntime();
    const staleRoom = new PresenceRoom(staleRuntime.state, {});
    await joinTo(staleRoom, "@ana", true);
    await joinTo(staleRoom, "@bo", true);
    await external(staleRoom, {
      text: "# A tool wrote\n",
      etag: "t1",
      actor: { id: "fedcba9876543210", name: "A Coding Agent" },
    });
    /*
      **Reported from the socket the room handed the write to, not from
      whichever one is first in the list.**

      Only that client may report an agent caret, so a test that picks a socket
      arbitrarily is asserting this property on a coin flip: the election runs
      over the lowest of two server-minted ids, which flips between runs. The
      browser harness in this pull request was corrected for exactly that; the
      unit tests are corrected here for the same reason, so each one proves the
      thing it names — staleness, clearing, suppression — rather than the
      reporter rule by accident.
    */
    const freshBefore = staleRuntime.open.map((ws) => ws.sent.length);
    await staleRoom.webSocketMessage(
      staleRoom.mergerSocket(),
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    check(
      "a caret reported while the write is fresh is drawn",
      // Non-vacuity for the check below: without this, moving the clock proves
      // nothing, because nothing was being drawn in the first place.
      staleRuntime.open
        .map((ws, i) => ws.frames().slice(freshBefore[i]))
        .flat()
        .some((frame) => frame.t === "cursor"),
    );

    staleRoom.agent.at -= MEMBER_IDLE_MS + 1;
    const staleBefore = staleRuntime.open.map((ws) => ws.sent.length);
    await staleRoom.webSocketMessage(
      staleRoom.mergerSocket(),
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    check(
      "...and one reported after the tool has gone quiet is not",
      staleRuntime.open
        .map((ws, i) => ws.frames().slice(staleBefore[i]))
        .flat()
        .every((frame) => frame.t !== "cursor"),
    );
    check(
      "...with the tool forgotten rather than merely ignored",
      // Read back, because "ignored this time" and "gone" differ the moment
      // anything else consults it.
      staleRoom.agent === null,
    );

    /*
      A WRITE FROM A CLIENT ALREADY IN THE ROOM IS SOMEBODY SAVING.

      The console has no private save path: it writes through `write_note` like
      any agent, because that is the only shape there is. So the rule above,
      left alone, puts a robot wearing your own name in the room the moment you
      press save — and another for every client that ever saved, since nothing
      takes one down but time.

      Matched on the *client*, not the member: two tabs are two members of one
      client, and either of them saving is still the same person.
    */
    const savingRuntime = fakeRoomRuntime();
    const savingRoom = new PresenceRoom(savingRuntime.state, {});
    await joinTo(savingRoom, "@ana", true, "cafe0123cafe0123");
    await joinTo(savingRoom, "@bo", true, "cafe0123cafe0123");
    const savingBefore = savingRuntime.open.map((ws) => ws.sent.length);
    await external(savingRoom, {
      text: "# Ana pressed save\n",
      etag: "s1",
      actor: { id: "cafe0123cafe0123", name: "@ana's agent" },
    });
    const sinceSave = () => savingRuntime.open.map((ws, i) => ws.frames().slice(savingBefore[i])).flat();
    check(
      "a console save does not announce a tool, because its client is seated",
      // Every socket, not one of them: a join is a broadcast, so checking the
      // wrong end of a two-member room would pass on a room full of robots.
      sinceSave().every((frame) => frame.t !== "join"),
    );
    check(
      "...and the write still reaches the room, which is the part that matters",
      // Non-vacuity: the rule above must not be "nothing happened at all".
      sinceSave().some((frame) => frame.t === "external" && frame.etag === "s1"),
    );

    const spoofBefore = savingRuntime.open.map((ws) => ws.sent.length);
    await savingRoom.webSocketMessage(
      savingRoom.mergerSocket(),
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    check(
      "...and no caret can be drawn for the tool the room did not admit",
      savingRuntime.open
        .map((ws, i) => ws.frames().slice(spoofBefore[i]))
        .flat()
        .every((frame) => frame.t !== "cursor"),
    );

    /*
      And the clearing half, which is the subtle one: a room that already holds
      a tool, then takes a save from somebody seated, must forget the tool. Its
      caret would otherwise be stamped onto the position of the *save* — a
      tool's name pointing at text a person wrote.
    */
    const mixedRuntime = fakeRoomRuntime();
    const mixedRoom = new PresenceRoom(mixedRuntime.state, {});
    await joinTo(mixedRoom, "@ana", true, "cafe0123cafe0123");
    await joinTo(mixedRoom, "@bo", true, "cafe0123cafe0123");
    await external(mixedRoom, {
      text: "# A tool wrote\n",
      etag: "m1",
      actor: { id: "fedcba9876543210", name: "A Coding Agent" },
    });
    const toolSeated = mixedRuntime.open
      .map((ws) => ws.frames())
      .flat()
      .some((frame) => frame.t === "join" && frame.member?.g === true);
    await external(mixedRoom, {
      text: "# then ana saved\n",
      etag: "m2",
      actor: { id: "cafe0123cafe0123", name: "@ana's agent" },
    });
    const afterSave = mixedRuntime.open.map((ws) => ws.sent.length);
    await mixedRoom.webSocketMessage(
      mixedRoom.mergerSocket(),
      JSON.stringify({ t: "cursor", a: "cG9z", h: "cG9z", agent: true }),
    );
    check(
      "a save after a tool's write clears the tool, rather than moving its caret",
      // Non-vacuous in both directions: the tool really was admitted first.
      toolSeated &&
        mixedRuntime.open
          .map((ws, i) => ws.frames().slice(afterSave[i]))
          .flat()
          .every((frame) => frame.t !== "cursor"),
    );

    /* ------------- the bucket moved, and everybody has to know ----------- */

    const savedBefore = readerSocket.sent.length;
    const savedLogBefore = (await askingRoom.readLog()).length;
    await askingRoom.webSocketMessage(writerSocket, JSON.stringify({ t: "saved", v: "abc123" }));
    check(
      "a save is relayed to the room as the version it produced",
      /*
        The console saves through the control plane, not through the gateway's
        `write_note`, so this frame is the room's only way to learn the bucket
        moved. Without it every other member keeps the etag their editor opened
        with, and the moment the person who was saving leaves, the next one
        elected writes against a version two edits old — the conflict box this
        whole feature exists to delete, arriving at the one moment presence is
        supposed to handle smoothly.
      */
      readerSocket.frames().slice(savedBefore).some(
        (frame) => frame.t === "etag" && frame.v === "abc123",
      ),
    );
    check(
      "...and never written to the log, because a version replays as nothing",
      (await askingRoom.readLog()).length === savedLogBefore,
    );

    const forgedBefore = writerSocket.sent.length;
    await askingRoom.webSocketMessage(readerSocket, JSON.stringify({ t: "saved", v: "deadbeef" }));
    check(
      "a member who cannot write cannot announce a version either",
      // They cannot have saved, and a peer that could name an arbitrary etag
      // could make everybody else's next save overwrite a version they never
      // saw — which is the same authority the write gate refuses, reached
      // through the bookkeeping instead of through the text.
      writerSocket.sent.length === forgedBefore,
    );

    check(
      "a version that is not one is refused rather than relayed",
      // Short, opaque, and never note text: the shape check is what keeps this
      // from becoming a channel for anything larger.
      decodeClientFrame(JSON.stringify({ t: "saved", v: "" })).ok === false &&
        decodeClientFrame(JSON.stringify({ t: "saved", v: "a".repeat(200) })).ok === false &&
        decodeClientFrame(JSON.stringify({ t: "saved", v: "not an etag" })).ok === false &&
        decodeClientFrame(JSON.stringify({ t: "saved", v: "abc123" })).ok === true,
    );

    /* ----------------- two people on one canvas -------------------------- */

    const drawBefore = writerSocket.sent.length;
    await askingRoom.webSocketMessage(readerSocket, JSON.stringify({ t: "draw", d: "QUJD" }));
    check(
      "a read-only member's shape never reaches anybody else",
      // The same rule as an edit to a note, on the frame that carries a
      // drawing: opening the canvas needs read, changing it needs write, and
      // non-negotiable #4 says the second is never implied by the first.
      writerSocket.sent.length === drawBefore && (await askingRoom.readLog()).length === 0,
    );

    const readerPointerBefore = writerSocket.sent.length;
    await askingRoom.webSocketMessage(
      readerSocket,
      JSON.stringify({ t: "pointer", x: 12.5, y: -3, s: ["el1"] }),
    );
    const pointerFrames = writerSocket.frames().slice(readerPointerBefore);
    check(
      "...but their pointer does, because watching somebody draw is a read",
      pointerFrames.some(
        (frame) => frame.t === "pointer" && frame.x === 12.5 && frame.y === -3,
      ),
    );
    check(
      "...stamped with the id the room gave them, never one they chose",
      pointerFrames.every((frame) => frame.t !== "pointer" || typeof frame.id === "string"),
    );
    check(
      "...and never written to the log, because a mouse position replays as nothing",
      (await askingRoom.readLog()).length === 0,
    );

    const drawnBefore = readerSocket.sent.length;
    await askingRoom.webSocketMessage(writerSocket, JSON.stringify({ t: "draw", d: "ZGVmZw==" }));
    check(
      "an element change from somebody who may edit is relayed and kept",
      // Kept, because somebody joining mid-drag has to arrive at the canvas the
      // others can see, and the log is the only thing here that knows what
      // that is. Reconciliation is by element version, so replaying the same
      // element twice is the same drawing.
      readerSocket.frames().slice(drawnBefore).some(
        (frame) => frame.t === "draw" && frame.d === "ZGVmZw==",
      ) && (await askingRoom.readLog()).includes("ZGVmZw=="),
    );

    check(
      "a pointer frame carries two numbers and some ids, and nothing else",
      // The ceiling that stops this becoming a second channel for scene data,
      // and a shape check so a payload cannot ride along beside the numbers.
      (() => {
        const decoded = decodeClientFrame(
          JSON.stringify({ t: "pointer", x: 1, y: 2, s: ["a"], elements: [{ big: "payload" }] }),
        );
        return (
          decoded.ok &&
          // `agent` for the same reason as the caret above: one boolean, and
          // the room decides whose pointer it is.
          Object.keys(decoded.msg).sort().join(",") === "agent,s,t,x,y" &&
          decodeClientFrame(JSON.stringify({ t: "pointer", x: "left", y: 2 })).ok === false
        );
      })(),
    );

    /* ------------ a tool wrote the note somebody has open ---------------- */

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
        readerSocket.frames().slice(readerBeforeNotice).every((frame) => frame.t !== "external"),
    );
    /*
      ...AND THE VERSION GOES WITH THE TEXT, TO NOBODY ELSE.

      This check is RESTATED rather than relaxed. It used to assert the
      opposite — that the etag reached the whole room, because every client's
      next save is a conditional write and the bucket had just moved. True, and
      the wrong half of the truth: that refusal is the only thing between a
      stale draft and a silent overwrite, and moving a client's etag is what
      spends it.

      A member given the version of a write they were not given passes their
      next conditional write and puts their own older content over the tool's,
      with nobody shown a conflict. On a canvas it is not even a race — the
      merger records the reconciled elements as already-sent so it does not
      echo them back, so the agent's drawing reaches one screen and every other
      member holds its version without it.

      Conflicting once and being asked is the honest outcome. The case this
      broadcast was built for is the `saved` frame, where the content really
      has reached everybody.
    */
    check(
      "...and the version goes with it, never to a member who was not given the text",
      readerSocket.frames().slice(readerBeforeNotice).every(
        (frame) => !(frame.t === "etag" && frame.v === "e2"),
      ),
    );
    check(
      "...while a peer's own save still tells the whole room its version",
      // The non-vacuity half, and the distinction the rule rests on: a `saved`
      // frame announces a write whose content the room has already carried, so
      // every member may adopt it. Without this check the rule above passes by
      // the room never reporting a version at all, which is the feature gone.
      await (async () => {
        const before = readerSocket.sent.length;
        await askingRoom.webSocketMessage(writerSocket, JSON.stringify({ t: "saved", v: "e2b" }));
        return readerSocket.frames().slice(before).some(
          (frame) => frame.t === "etag" && frame.v === "e2b",
        );
      })(),
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
    const logBeforeEdit = (await askingRoom.readLog()).length;
    await askingRoom.webSocketMessage(readerSocket, JSON.stringify({ t: "y", d: "ZGVm" }));
    check(
      "...while an edit from the same read-only member still reaches nobody",
      // The distinction the whole `ask` type rests on: the reader may ask, and
      // may not answer. Non-vacuous — the writer's socket received the ask a
      // moment ago, so "no new frame" is a fact about this frame. The log is
      // compared against what it held rather than against empty, because the
      // drawing checks above deliberately put an entry in it.
      writerSocket.sent.length === writerFramesBeforeEdit &&
        (await askingRoom.readLog()).length === logBeforeEdit,
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
    // Plumbing that really is in the bucket. Seeded rather than assumed absent,
    // because the question this answers is whether the route refuses a
    // plumbing key *that exists* — a refusal that only happens because nothing
    // is there is not the guard.
    bucket.seed(".context/search/shard-0.md", "PLUMBINGSECRET derived, not a note");
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
    /*
      PLUMBING IS NOT A NOTE, AND THIS ROUTE HAS TO SAY SO TOO.

      The route delegates to `canSee`, which opens with the two clauses that
      hold `privacy.md` and every dot-prefixed segment back — so the guard is
      correct, and until now nothing checked that the route still asks. Teaching
      `handlePresence` to treat a plumbing path as visible failed **0** checks
      in this suite, which is what a guard nobody has checked looks like.

      What a regression would cost is an existence oracle rather than content:
      the route reads no note, but it does call `objectExists` once a path is
      visible, so a caller could tell a `.context/` key that is there from one
      that is not by the status alone. The manifest is the sharper half —
      `read_note` refuses it to every tier, and a team connection that could
      read it would learn the exact path of every note held back by name.
    */
    const plumbingRoom = await presenceRequest(
      env,
      OWNER_TOKEN,
      "?note=.context/search/shard-0.md",
    );
    check(
      "a plumbing key that exists in the bucket opens no room, even for the owner",
      plumbingRoom.status === 404,
    );
    check(
      "...and refuses identically to a note that is not there",
      plumbingRoom.status === missingNote.status && plumbingRoom.text === missingNote.text,
    );
    const manifestRoom = await presenceRequest(env, TEAM_TOKEN, "?note=privacy.md");
    check(
      "a team connection opens no room on the privacy manifest",
      manifestRoom.status === 404 && manifestRoom.text === missingNote.text,
    );
    const callsBeforePlumbing = rooms.calls.length;
    await presenceRequest(env, OWNER_TOKEN, "?note=.context/search/shard-0.md");
    check(
      "...and no room is addressed at all, so the refusal is before the room",
      rooms.calls.length === callsBeforePlumbing,
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
