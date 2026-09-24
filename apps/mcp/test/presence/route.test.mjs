/**
 * Presence: the `GET /presence` route, end to end against a real
 * control-plane stub and in-memory buckets — the production room performing
 * the whole live authorization path, a team connection joining a team
 * note's room with a caret carrying its own handle (never the host's, never
 * a client-registered name, never a workspace slug standing in for a
 * person), v2 socket generation pinning, read opening the socket while write
 * is a separate question, a client unable to name itself, presence refusing
 * exactly like the read it is (byte-identical AND cost-identical for a
 * private note and a missing one, plumbing keys included), one tenant unable
 * to reach another's room (by token or by URL), the refusals before any of
 * that (unauthenticated, wrong method, no upgrade, a traversing path), a
 * browser origin check, a tool's write notifying the room for that note, and
 * a deployment without the binding degrading honestly.
 *
 * Split out of presence.test.mjs; see fixtures.mjs for the shared bucket,
 * room-namespace stub, and request helpers.
 */

import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  GatewayPresenceRoom,
  MANIFEST,
  NOHANDLE_TOKEN,
  OTHER_TOKEN,
  OWNER_TOKEN,
  SHARED_TOKEN,
  TEAM_TOKEN,
  callTool,
  createBucket,
  createControlPlaneStub,
  createRoomNamespaceStub,
  fakeRoomRuntime,
  fakeSocket,
  presenceClientKey,
  presenceRequest,
  roomKey,
} from "./fixtures.mjs";

export async function runPresenceRouteChecks(check) {
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
    const ownerGrantId = await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_presence",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_presence_owner",
      userId: "user_presence_owner",
    });
    const teamGrantId = await controlPlane.addGrant({
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
    const consoleGroupToken = `cat_presence_console_group_${"0".repeat(10)}`;
    await controlPlane.addGrant({
      accessToken: consoleGroupToken,
      workspaceId: "ws_presence",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "context_console",
      userId: "user_presence_console_group",
      grantedNamesByWorkspace: { ws_presence: ["writers"] },
    });
    const oauthGroupToken = `cat_presence_oauth_group_${"0".repeat(12)}`;
    await controlPlane.addGrant({
      accessToken: oauthGroupToken,
      workspaceId: "ws_presence",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "ordinary_oauth_client",
      userId: "user_presence_oauth_group",
      grantedNamesByWorkspace: { ws_presence: ["writers"] },
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
    bucket.seed("1-projects/live.md", "the live collaboration note");
    bucket.seed("1-projects/group.md", "the writers group note");
    const livePathDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("1-projects/live.md"),
    );
    const livePathHash = [...new Uint8Array(livePathDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    bucket.seed(
      `.context/collaboration/v1/heads/${livePathHash}.json`,
      JSON.stringify({ status: "active", documentId: "doc-route-live" }),
    );
    bucket.seed("1-projects/rates.md", "RATESECRET what we charge");
    const ratesPathDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("1-projects/rates.md"),
    );
    const ratesPathHash = [...new Uint8Array(ratesPathDigest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    bucket.seed(
      `.context/collaboration/v1/heads/${ratesPathHash}.json`,
      JSON.stringify({ status: "active", documentId: "doc-private-live" }),
    );
    const markerBody = `context.logical-delete.v1.${"0".repeat(32)}.${"0".repeat(64)}`;
    bucket.seed("1-projects/marker-sized.md", "MARKERSIZESECRET".padEnd(markerBody.length, "x"));
    bucket.seed("1-projects/deleted.md", markerBody);
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

    /* -- the production room performs the whole live authorization path ---- */

    const productionRuntime = fakeRoomRuntime();
    const productionRoom = new GatewayPresenceRoom(productionRuntime.state, env);
    const productionSender = fakeSocket();
    const productionRecipient = fakeSocket();
    const productionDeadline = Date.now() + 60_000;
    productionSender.serializeAttachment({
      id: "production-sender",
      name: "@teamhome",
      color: "#3b82f6",
      canWrite: true,
      clientKey: await presenceClientKey("mcp_client_presence_team"),
      grantId: teamGrantId,
      workspaceId: "ws_presence",
      workspaceSlug: "presencetest",
      path: "1-projects/live.md",
      documentId: "doc-route-live",
      collaborationVersion: 2,
      deadline: productionDeadline,
      seen: Date.now(),
    });
    productionRecipient.serializeAttachment({
      id: "production-recipient",
      name: "@presencetest",
      color: "#ec4899",
      canWrite: true,
      clientKey: await presenceClientKey("mcp_client_presence_owner"),
      grantId: ownerGrantId,
      workspaceId: "ws_presence",
      workspaceSlug: "presencetest",
      path: "1-projects/live.md",
      documentId: "doc-route-live",
      collaborationVersion: 2,
      deadline: productionDeadline,
      seen: Date.now(),
    });
    productionRuntime.open.push(productionSender, productionRecipient);
    await productionRoom.webSocketMessage(productionSender, JSON.stringify({
      t: "live",
      documentId: "doc-route-live",
      d: "QUJD",
      accessToken: TEAM_TOKEN,
    }));
    check(
      "the production room authorizes and relays one current-generation update",
      productionRecipient.frames().some(
        (frame) => frame.t === "live" && frame.documentId === "doc-route-live" &&
          frame.d === "QUJD" && !JSON.stringify(frame).includes(TEAM_TOKEN),
      ),
    );
    const narrowedRuntime = fakeRoomRuntime();
    const narrowedRoom = new GatewayPresenceRoom(narrowedRuntime.state, env);
    const narrowedSender = fakeSocket();
    narrowedSender.serializeAttachment({
      ...productionSender.deserializeAttachment(),
      id: "narrowed-sender",
      path: "1-projects/rates.md",
      documentId: "doc-private-live",
    });
    narrowedRuntime.open.push(narrowedSender);
    bucket.fetched.length = 0;
    await narrowedRoom.webSocketMessage(narrowedSender, JSON.stringify({
      t: "live",
      documentId: "doc-private-live",
      d: "REVG",
      accessToken: TEAM_TOKEN,
    }));
    check(
      "fresh privacy revocation closes the sender without fetching hidden note bytes",
      narrowedSender.closed.length === 1 &&
        !bucket.fetched.includes("1-projects/rates.md"),
    );

    /* -- non-vacuity: the happy path actually reaches a room --------------- */

    const joined = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/roadmap.md&seed=tab-a");
    check("a team connection joins a team note's room", joined.status === 200);
    check(
      "the room addressed is the one the session's workspace names",
      rooms.calls.at(-1)?.name === roomKey("ws_presence", "1-projects/roadmap.md"),
    );
    check(
      "and it is the room for the note that was authorized, spelled out",
      // Written as a literal on purpose. The check above compares the room the
      // route entered against `roomKey` called with the same arguments, so it
      // holds however `roomKey` is spelled — including a spelling that drops
      // the note. This route authorizes one path and joins one room, and
      // nothing else in this file says those are the same path.
      rooms.calls.at(-1)?.name === "ws_presence/1-projects%2Froadmap.md",
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

    const oldV2 = await presenceRequest(
      env,
      TEAM_TOKEN,
      "?note=1-projects/live.md&collaboration=2",
      { headers: { Cookie: "browser-secret=must-not-cross" } },
    );
    const oldV2Call = rooms.calls.at(-1);
    const oldV2Member = JSON.parse(oldV2Call?.member || "null");
    check(
      "an older v2 socket without a document id keeps presence but cannot receive live text",
      oldV2.status === 200 && oldV2Member?.documentId === null &&
        oldV2Call?.url === "https://presence.invalid/presence?collaboration=2",
    );
    check(
      "the internal room handshake carries no public bearer or cookie",
      oldV2Call?.authorization === null && oldV2Call?.cookie === null &&
        !oldV2Call?.url.includes(TEAM_TOKEN) && !oldV2Call?.url.includes("1-projects"),
    );

    const currentV2 = await presenceRequest(
      env,
      TEAM_TOKEN,
      "?note=1-projects/live.md&collaboration=2&documentId=doc-route-live",
    );
    const currentV2Member = JSON.parse(rooms.calls.at(-1)?.member || "null");
    check(
      "a current v2 socket is pinned to server-derived room and generation metadata",
      currentV2.status === 200 && currentV2Member?.grantId &&
        currentV2Member.workspaceId === "ws_presence" &&
        currentV2Member.path === "1-projects/live.md" &&
        currentV2Member.documentId === "doc-route-live",
    );
    const beforeStaleV2 = rooms.calls.length;
    const staleV2 = await presenceRequest(
      env,
      TEAM_TOKEN,
      "?note=1-projects/live.md&collaboration=2&documentId=doc-stale",
    );
    check(
      "a stale document generation opens no room",
      staleV2.status === 409 && rooms.calls.length === beforeStaleV2,
    );
    const consoleGroupV2 = await presenceRequest(
      env,
      consoleGroupToken,
      "?note=1-projects/group.md&collaboration=2",
    );
    const ordinaryGroupV2 = await presenceRequest(
      env,
      oauthGroupToken,
      "?note=1-projects/group.md&collaboration=2",
    );
    const consoleGroupV1 = await presenceRequest(
      env,
      consoleGroupToken,
      "?note=1-projects/group.md",
    );
    check(
      "durable console presence honors live group clearance without widening OAuth grants",
      consoleGroupV2.status === 200 && ordinaryGroupV2.status === 404,
    );
    check(
      "legacy presence keeps its deliberate group under-share",
      consoleGroupV1.status === 404,
    );

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
    bucket.fetched.length = 0;
    const markerSizedPrivate = await presenceRequest(
      env,
      TEAM_TOKEN,
      "?note=1-projects/marker-sized.md",
    );
    check(
      "a hidden marker-sized note is refused without fetching its bytes",
      markerSizedPrivate.status === 404 && !bucket.fetched.includes("1-projects/marker-sized.md"),
    );
    const callsBeforeDeleted = rooms.calls.length;
    const deletedNote = await presenceRequest(env, OWNER_TOKEN, "?note=1-projects/deleted.md");
    check(
      "an authorized caller still opens no room for a logical tombstone",
      deletedNote.status === 404 && rooms.calls.length === callsBeforeDeleted,
    );
    const missingNote = await presenceRequest(env, TEAM_TOKEN, "?note=1-projects/nothing.md");
    check(
      "a private note and a missing note refuse identically",
      // The refusal must not be an oracle for "this note exists". Same status,
      // same body, or the socket answers a question the read path will not.
      missingNote.status === privateNote.status && missingNote.text === privateNote.text,
    );
    /*
      AND THEY MUST COST THE SAME, NOT ONLY READ THE SAME.

      The check above closes the channel a caller READS. It does not close the
      one a caller MEASURES. This route asked `canSee` first and only probed
      storage when the answer was yes, so a path held back by the manifest
      refused without a round trip and a path the caller could have seen went
      to the bucket and missed first. Byte-identical answers, different numbers
      of trips — and the refusal that costs nothing is the one where something
      is being held back.

      That is the oracle the route's own comment says it closed. It closed the
      value and left the clock: a team connection enumerating names inside a
      folder it CAN see learns, from the cost alone, which of them carry an
      exact-note override — and an override is written only when somebody
      deliberately made a note there private. Their own listing cannot tell
      them that, because a held-back note is absent from it either way.

      Counted rather than timed, so this is deterministic. The number is not
      the invariant; the equality is.
    */
    const tripsFor = async (query) => {
      const before = bucket.trips();
      await presenceRequest(env, TEAM_TOKEN, query);
      return bucket.trips() - before;
    };
    const heldBackTrips = await tripsFor("?note=1-projects/rates.md");
    const absentTrips = await tripsFor("?note=1-projects/nothing.md");
    check(
      `a private note and a missing note cost the same to refuse `
        + `(held back ${heldBackTrips}, absent ${absentTrips})`,
      heldBackTrips === absentTrips,
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
    const roadmapRead = await callTool(env, TEAM_TOKEN, "read_note", {
      path: "1-projects/roadmap.md",
    });
    const written = await callTool(env, TEAM_TOKEN, "write_note", {
      path: "1-projects/roadmap.md",
      content: "the roadmap, for everyone here\n\nand a line an agent added\n",
      summary: "an agent writing a note somebody has open",
      expected_etag: roadmapRead.match(/^etag: (\S+)/)?.[1],
    });
    // The committed notice specifically: the same write, and the read before
    // it, also post to the workspace's activity log (`agentActivity.js`),
    // which is a different object and a different question.
    const notice = rooms.calls
      .slice(writesBefore)
      .find((call) => call.body !== null && call.url.endsWith("/committed"));
    check(
      "a tool's write tells the room for that note, in that workspace",
      // The room key is derived from the session's own workspace and the path
      // that was written — the same derivation the socket route uses, so a
      // notice can never land in another tenant's room.
      written.startsWith("written:") &&
        notice?.name === roomKey("ws_presence", "1-projects/roadmap.md"),
    );
    check(
      "...and carries only the committed document identity and version",
      // The room sends a re-fetch hint. It never receives content or update
      // bytes that could outlive the socket's authorization lease.
      (() => {
        const body = JSON.parse(notice?.body ?? "null");
        return (
          typeof body?.documentId === "string" && body.documentId.length > 0 &&
          typeof body.etag === "string" && body.etag.length > 0 &&
          !("text" in body) && !("update" in body)
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
