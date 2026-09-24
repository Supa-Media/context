/**
 * Presence: a read-only member asking peers what they are missing (never as
 * an edit, never logged); the tool that wrote a note joins the room as a
 * member (an agent caret reported only by the client the room handed the
 * write to, and only while that write is fresh); a console save clearing
 * that tool rather than moving its caret; the bucket moving and everybody
 * learning the new version (never a member the text was not given); two
 * people on one canvas (drawing needs write, watching needs only read); and
 * a tool's write handed to exactly the one member who can merge it.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for `fakeRoomRuntime` and
 * `withFakeWebSocketPair` — these room-object `.fetch()` calls need the fake
 * `WebSocketPair` global installed.
 */

import { MEMBER_IDLE_MS, PresenceRoom, decodeClientFrame, fakeRoomRuntime, withFakeWebSocketPair } from "./fixtures.mjs";

export async function runPresencePeerSyncAndAgentWriteChecks(check) {
  await withFakeWebSocketPair(async () => {
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
  });
}
