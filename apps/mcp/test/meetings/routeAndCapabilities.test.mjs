/**
 * `meetings` is a route, and a name nobody gets to shadow with their own
 * folder — plus the two capability sections: a bucket that cannot do a
 * conditional write, for real, and (in the next file) a backend that cannot
 * do any of that.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants. Sections 13-14 of the original file, run against the same
 * `harness` earlier sections left their state in.
 */

import {
  MEETING_PREFIX,
  PRIVACY_MANIFEST,
  SESSION_DEGRADED,
  SESSION_SHADOWED,
  SESSION_SHARED,
  SessionRefusal,
  TOKEN_LAST_WRITER,
  TOKEN_OWNER,
  TOKEN_SHARED,
  keysIn,
  meetingRequest,
  s3Binding,
  segment,
  sessionForContext,
  splitWorkspacePath,
  writeSession,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingRouteAndCapabilityChecks(check, harness) {
  const { env, recorder, neighbour, s3, controlPlane, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* ------------- 13. `meetings` is a route, and a name nobody gets --------- */

  /*
    `POST /meetings/sessions` parsed as "the context called meetings, at the
    path /sessions" until `meetings` joined `RESERVED_FIRST_SEGMENTS`. The
    gateway worked around that by lifting meeting paths out of the selector
    before it ran, which defended the route and left the hole: the name stayed
    claimable, and a name in this namespace is also a mailbox on the apex
    (CLAUDE.md, "Ingestion is on the apex, which makes the reserved-name list a
    security control"). `apps/convex/__tests__/names.test.ts` reads the
    gateway's list out of its own source and refuses to hand out anything in it,
    so the two halves of this cannot drift.

    What is checked here is the gateway half, with the workaround gone: the
    first segment is a route whoever else may have registered.
  */
  {
    const meetingsWorkspace = splitWorkspacePath("/meetings/sessions");
    check(
      "a meeting path names no workspace, whatever anybody registered",
      meetingsWorkspace.slug === null && meetingsWorkspace.path === "/meetings/sessions"
    );
    check(
      "and `@meetings` is not a context anybody can address either",
      splitWorkspacePath("/@meetings/mcp").slug === null
    );
    check(
      "nor through a tool call's own context argument, even with a row that names it",
      (() => {
        const forged = {
          workspaceId: "ws_recorder",
          workspaces: [{ workspaceId: "ws_shadow", slug: "meetings", role: "owner" }],
        };
        try {
          sessionForContext(forged, "@meetings");
          return false;
        } catch (error) {
          return error instanceof SessionRefusal && error.status === 403;
        }
      })()
    );

    /*
      And the end of the attack, end to end: a workspace registered under that
      slug — which the control plane will not issue any more, and which this
      stub is made to issue anyway — must not take the ingestion route away from
      the people using it. Before the reserved entry the selector would resolve
      `meetings`, the owner is not a member of it, and every recorder in the
      product would have been answered 403 by somebody else's handle.
    */
    controlPlane.addWorkspace("ws_shadow", "meetings", s3Binding("meet-shadow", "CC"));
    const stillOurs = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: { id: SESSION_SHADOWED, startedAt: "2026-09-01T16:00:00.000Z", title: "Not shadowed" },
    });
    check(
      "a workspace registered as `meetings` does not take the ingestion route",
      stillOurs.status === 200 && stillOurs.body?.sessionId === SESSION_SHADOWED
    );
    check(
      "...and the session lands in the caller's own bucket, not in that one",
      recorder.has(`${MEETING_PREFIX}${SESSION_SHADOWED}.json`) &&
        !s3.bucketFor("meet-shadow").has(`${MEETING_PREFIX}${SESSION_SHADOWED}.json`)
    );
  }

  /* --------- 14. a bucket that cannot do a conditional write, for real ----- */

  /*
    The fixture below proves the *state layer* reports a store's capability. This
    proves the capability survives the trip from the control plane's probe to
    the client's ack, which is where it was being lost: `storeForBinding` built
    every store with the adapter's own `conditionalWrite: true` and never read
    the binding, so a B2 or Wasabi context was told it had conflict safety it
    does not have.
  */
  controlPlane.addWorkspace("ws_lastwriter", "lastwriter", {
    ...s3Binding("meet-lastwriter", "DD"),
    capabilities: { conditionalWrite: false },
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_LAST_WRITER,
    workspaceId: "ws_lastwriter",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_meet_lastwriter",
    userId: "user_meet_lastwriter",
  });
  s3.bucketFor("meet-lastwriter").set("privacy.md", { body: PRIVACY_MANIFEST, etag: "l0" });
  const degraded = await meetingRequest(env, TOKEN_LAST_WRITER, "/meetings/sessions", {
    body: { id: SESSION_DEGRADED, startedAt: "2026-09-01T17:00:00.000Z", title: "On a bucket that cannot" },
  });
  check(
    "a context on a bucket that ignores If-Match is told so on every ack",
    degraded.status === 200 && degraded.body?.conflictSafe === false
  );
  check(
    "...and the meeting is still accepted, because degrading honestly is not refusing",
    s3.bucketFor("meet-lastwriter").has(`${MEETING_PREFIX}${SESSION_DEGRADED}.json`)
  );

  /*
    A team connection that can actually finish a meeting.

    Every other team-tier finalize in this file is *refused* — `0-inbox` inherits
    `private` from `PRIVACY_MANIFEST`, and a team connection may not create
    private content — so the suite has never once watched a team connection
    finalize successfully. That is the mainline flow for a shared workspace,
    where the meetings folder defaulting to `team` is the obvious setting, and it
    is where the tier stamp has to survive: `completionReceipt` builds a fresh
    object, and `finalizeSession` writes it with `writeSession` directly rather
    than through `updateSession`, which is the only thing that stamps.
  */
  controlPlane.addWorkspace("ws_shared", "shared", s3Binding("meet-shared", "EE"));
  await controlPlane.addGrant({
    accessToken: TOKEN_SHARED,
    workspaceId: "ws_shared",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_meet_shared",
    userId: "user_meet_shared",
  });
  s3.bucketFor("meet-shared").set("privacy.md", {
    body:
      "---\nrole: privacy-manifest\n---\n\n" +
      "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
      "folder_defaults:\n  0-inbox: team\n\nnote_overrides:\n  # none\n```\n\n" +
      "<!-- END BRAIN PRIVACY RULES -->\n",
    etag: "sh0",
  });

  await meetingRequest(env, TOKEN_SHARED, "/meetings/sessions", {
    body: {
      id: SESSION_SHARED,
      title: "Team standup",
      startedAt: "2026-09-03T09:00:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-03T09:00:00.000Z" }],
    },
  });
  const sharedFinalize = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_SHARED}/finalize`, {
    body: { endedAt: "2026-09-03T09:20:00.000Z" },
  });
  check(
    "a team connection can finish a meeting where the folder default allows it",
    sharedFinalize.status === 200 && typeof sharedFinalize.body?.notePath === "string"
  );

  const sharedReadBack = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_SHARED}`, {
    method: "GET",
  });
  check(
    "and can still read the meeting it just finished",
    sharedReadBack.status === 200 && sharedReadBack.body?.session?.state === "complete"
  );
  const sharedList = await meetingRequest(env, TOKEN_SHARED, "/meetings/sessions", { method: "GET" });
  check(
    "and its own finished meeting is still in its listing",
    JSON.stringify(sharedList.body ?? {}).includes(SESSION_SHARED)
  );

  /*
    The idempotency the contract promises: a replayed finalize answers with the
    note it already wrote. A receipt the caller can no longer see makes
    `updateSession` refuse before the "already complete" branch is reached, so a
    phone retrying after a dropped connection would be told its own finished
    meeting does not exist.
  */
  const sharedReplay = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_SHARED}/finalize`, {
    body: {},
  });
  check(
    "and a replayed finalize is still idempotent rather than a refusal",
    sharedReplay.status === 200 && sharedReplay.body?.notePath === sharedFinalize.body?.notePath
  );
  check(
    "with exactly one note written for that meeting",
    keysIn(s3.bucketFor("meet-shared"), "0-inbox/meetings/").length === 1
  );

}
