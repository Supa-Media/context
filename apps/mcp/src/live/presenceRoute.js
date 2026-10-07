/**
 * `/presence/...` and `/agent-activity/...` — who is looking at a note, and
 * what an agent is doing in it, behind the caller's session and `canSee`.
 */

import { ACTIVITY_KINDS, activityForCaller, agentActivityKey } from "../agentActivity.js";
import { heartbeatPerson } from "./activityHeartbeat.js";
import {
  bearerToken,
  hasScope,
  resolveSession,
  SCOPE_READ,
  SCOPE_WRITE,
  SessionRefusal,
  StorageUnavailable,
  storeForSession,
} from "../session.js";
import { canSee, isPlumbing } from "../privacy/engine.js";
import { collaborationHead } from "./collaborationHttp.js";
import { createControlPlane } from "../controlPlane.js";
import { forbiddenResponse, unauthorizedResponse } from "../oauth.js";
import { json } from "../http/responses.js";
import { loadPrivacyState } from "../privacy/state.js";
import { normalizePath } from "../notes/paths.js";
import { objectExists } from "../storageLayout.js";
import { presenceClientKey } from "./relayAuthorization.js";
import { presenceDisplayName } from "./presence.js";
import { roomKey } from "../presence.js";

/**
 * `GET /presence?note=<path>` — the socket that says who else has this note
 * open, and where their carets are.
 *
 * ## It authorizes exactly like a read, and then reads nothing
 *
 * Same token, same grant, same clamp, same `privacy.md`. A caller who cannot
 * *read* the note is refused before any room is addressed, and refused with the
 * same 404 a missing note gets — because "this note exists but is private" is
 * the one thing a presence probe must not be able to ask. That refusal is the
 * reason this route loads a store at all: it never reads the note itself, only
 * the manifest that says whether the caller may.
 *
 * ## The three things a client does not get to say
 *
 * Its **name** (taken from the resolved session, below), its **id** (minted in
 * the room) and its **room** (derived from the workspace the *grant* resolved
 * to, never from anything in the URL beyond the note path). A header naming a
 * member is set here after the client's own headers are copied, so a client
 * that sends `x-presence-member` has it overwritten rather than honoured.
 *
 * "Taken from the resolved session" is half a sentence, and the other half is
 * the part that was wrong once: the session carries every context this
 * connection may *address*, and only one row of it names the person —
 * see `personalNameFor`.
 *
 * ## Groups are deliberately not passed to `canSee`
 *
 * Which means a note scoped to a group is, to this route, private — no room, no
 * roster, no caret. That is the narrow answer rather than the clever one: a
 * presence roster is a live signal about who is reading what, and the first
 * version of it should under-share. Widening it is a deliberate change with a
 * test, not an argument list nobody looked at.
 */
export async function handlePresence(request, env, { slug, pathToken, origin }) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return new Response("expected a websocket upgrade", { status: 426 });
  }
  // A deployment without the binding — a self-host on an older config — says so
  // rather than throwing. Every note still opens, still saves and still
  // conflicts exactly as it did before this route existed, which is the
  // property that makes presence safe to switch off.
  if (!env.PRESENCE_ROOM) return json({ error: "presence_unavailable" }, 501);

  const url = new URL(request.url);
  const notePath = normalizePath(url.searchParams.get("note"));
  if (!notePath) return json({ error: "invalid_path" }, 400);
  const collaborationV2 = url.searchParams.get("collaboration") === "2";
  const requestedDocumentId = url.searchParams.get("documentId");
  if (
    collaborationV2 && requestedDocumentId !== null &&
    (!requestedDocumentId || requestedDocumentId.length > 256)
  ) {
    return json({ error: "invalid_document" }, 400);
  }

  const controlPlane = createControlPlane(env);
  let session;
  try {
    session = await resolveSession(pathToken || bearerToken(request), slug, controlPlane);
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403
      ? forbiddenResponse(origin, null, error)
      : unauthorizedResponse(origin, slug, error);
  }
  if (!hasScope(session, SCOPE_READ)) {
    return forbiddenResponse(origin, null, {
      description: `This connection does not hold the ${SCOPE_READ} scope.`,
      scope: [SCOPE_READ],
    });
  }

  let store;
  try {
    store = await storeForSession(session, env, controlPlane);
  } catch (error) {
    if (!(error instanceof StorageUnavailable)) throw error;
    return json({ error: "storage_unavailable" }, 503);
  }

  const { rules, overrides } = await loadPrivacyState(store);
  // Legacy presence deliberately under-shares group notes. Durable console
  // collaboration carries the console grant's freshly resolved group names,
  // on the same terms as its HTTP document reads; ordinary OAuth grants have
  // no names to pass and cannot gain group visibility here.
  const visible = canSee(
    notePath,
    session.scope,
    rules,
    overrides,
    collaborationV2 ? session.grantedGroups : undefined,
  );
  // **Existence is checked, and checked by listing rather than by reading.**
  //
  // Without this the route answers 200 for any path inside a team folder,
  // whether or not a note is there — and 404 only for a path the manifest holds
  // back. That difference is an oracle: a team-tier caller could ask
  // `1-projects/rates.md` and learn from the refusal alone that a note exists
  // there and was deliberately made private, which `read_note` is careful never
  // to disclose (it answers "not found" to both). So the two refusals are made
  // identical, and this route matches the read path it claims to authorize like.
  //
  // A listing rather than a `get`, because this route does not read notes and
  // should not start: a prefix listing answers "is there an object at exactly
  // this key" out of metadata, and the body never enters the worker.
  //
  // **Unconditionally, because the cost is part of the answer.** Probing only
  // when `canSee` said yes made the two refusals identical to read and
  // different to measure: a path the manifest holds back returned without
  // touching the bucket, a path the caller could have seen went to storage and
  // missed first. Same status, same body, one round trip apart — so the
  // cheaper refusal was the one where something is being held back, which is
  // the oracle the paragraph above says this route closed.
  //
  // Enumerating names inside a folder they CAN see, a team connection would
  // learn from the cost alone which of those names carry an exact-note
  // override, and an override is written only when somebody deliberately made
  // a note there private. Their own listing cannot tell them that: a held-back
  // note is absent from it either way.
  //
  // So the probe runs for everyone and its answer is combined afterwards. It
  // is metadata either way — the body still never enters the worker, for a
  // path the caller may not see least of all.
  const physicallyPresent = await objectExists(store, notePath, { metadataOnly: true });
  // A provider that dropped marker metadata can only tell us that bytes exist.
  // Resolve that ambiguity through the logical view after authorization, so a
  // tombstone opens no room without fetching a hidden note on behalf of a
  // caller who may not read it.
  const present = visible && physicallyPresent
    ? await objectExists(store, notePath)
    : physicallyPresent;
  if (!visible || !present) return json({ error: "not_found" }, 404);

  let documentId = null;
  if (collaborationV2 && requestedDocumentId !== null) {
    const head = await collaborationHead(store, notePath);
    if (head?.status !== "active" || head.documentId !== requestedDocumentId) {
      return json({ error: "document_changed" }, 409);
    }
    documentId = requestedDocumentId;
  }

  const room = env.PRESENCE_ROOM.get(
    env.PRESENCE_ROOM.idFromName(roomKey(session.workspaceId, notePath)),
  );
  // Only the two headers the room consumes cross the internal boundary. In
  // particular, the bearer/cookie and browser websocket negotiation headers
  // from the public request are not forwarded into the Durable Object.
  const headers = new Headers({ Upgrade: "websocket" });
  headers.set(
    "x-presence-member",
    JSON.stringify({
      name: presenceDisplayName(session),
      // v2 identities are server-derived for the entire socket lifetime;
      // accepting a client colour seed there would let the client influence
      // its room identity even though the committed path is authenticated.
      colorSeed: collaborationV2 ? null : url.searchParams.get("seed"),
      /*
        **Whether this caller may change the note, decided here and only here.**

        Opening the socket needs read: you have to be able to see a note to
        watch somebody edit it. Changing it needs write, and the two are not
        the same question — non-negotiable #4 says write access to somebody
        else's context is never implied by read, and a `member` of a shared
        context holds exactly that shape of grant.

        Resolved from the already-clamped scope set, so a role that cannot
        write cannot acquire it here, and sent to the room rather than trusted
        from the client.
      */
      canWrite: hasScope(session, SCOPE_WRITE),
      /*
        **Which client this socket belongs to, so a save is not mistaken for a
        tool.**

        The room announces the client behind a write as a member, so that
        somebody watching a note change can see who is changing it. The console
        writes through the same tool as any agent does — `write_note` is the
        only shape there is — so without this, saving your own note puts a
        robot wearing your name in the room beside you.

        The same digest the write carries, and never the client id itself. It
        identifies a *client*, not a person: two browser tabs are two members
        of one client and a tool holding its own grant is a different one,
        which is exactly the distinction that has to be drawn.
      */
      clientKey: await presenceClientKey(session.actorClientId),
      ...(collaborationV2
        ? {
            grantId: session.grantId,
            workspaceId: session.workspaceId,
            workspaceSlug: session.workspaceSlug,
            path: notePath,
            // Old v2 clients did not send the generation. They retain roster,
            // caret and committed-hint compatibility but are ineligible for
            // plaintext live relay until they reconnect with an upgraded URL.
            documentId,
          }
        : {}),
    }),
  );
  // The browser compatibility transport carries its bearer in the public URL.
  // The room has no use for it after the gateway resolves the session, so the
  // internal request is rebuilt on a fixed origin and contains no token, note
  // path, or other caller-controlled URL material.
  const roomUrl = collaborationV2
    ? "https://presence.invalid/presence?collaboration=2"
    : "https://presence.invalid/presence";
  return await room.fetch(new Request(roomUrl, { method: "GET", headers }));
}

/**
 * `GET /agent-activity` — which notes agents read or wrote in the last few
 * minutes, for the console's file tree, its "N agents active" line and the
 * live map.
 *
 * Query parameters, all optional: `since=<ms>` returns only `events` newer
 * than that `at` (the map polls every few seconds and passes the newest `at`
 * it holds); and, from the console only, `note`/`doing` and
 * `did`/`path`/`from`/`to` — see `activityHeartbeat.js`.
 *
 * Authorized like `/presence`: same token, same grant, same clamp, same
 * `privacy.md`. The log comes back from the workspace's activity object whole
 * and is filtered here, through `canSee` for this caller, before anything is
 * counted. See `agentActivity.js` for why that order matters.
 *
 * Groups are not passed to `canSee`, as on `/presence`: a note scoped to a
 * group reads as private here. This is a live signal about who is working on
 * what, and its first version should under-share.
 *
 * A manifest that does not parse answers with nothing rather than with a
 * guess. That is the same fail-closed rule `callTool` applies.
 */
export async function handleAgentActivity(request, env, { slug, pathToken, origin }) {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (!env.PRESENCE_ROOM) return json({ error: "presence_unavailable" }, 501);

  const controlPlane = createControlPlane(env);
  let session;
  try {
    session = await resolveSession(pathToken || bearerToken(request), slug, controlPlane);
  } catch (error) {
    if (!(error instanceof SessionRefusal)) throw error;
    return error.status === 403
      ? forbiddenResponse(origin, null, error)
      : unauthorizedResponse(origin, slug, error);
  }
  if (!hasScope(session, SCOPE_READ)) {
    return forbiddenResponse(origin, null, {
      description: `This connection does not hold the ${SCOPE_READ} scope.`,
      scope: [SCOPE_READ],
    });
  }

  let store;
  try {
    store = await storeForSession(session, env, controlPlane);
  } catch (error) {
    if (!(error instanceof StorageUnavailable)) throw error;
    return json({ error: "storage_unavailable" }, 503);
  }
  const privacy = await loadPrivacyState(store);
  const now = Date.now();
  if (privacy.error) return json({ ...activityForCaller([], now, () => false), peopleCount: 0, people: [] });

  const params = new URL(request.url).searchParams;
  const sinceParam = params.has("since") ? Number(params.get("since")) : NaN;
  const since = Number.isFinite(sinceParam) && sinceParam >= 0 ? sinceParam : null;
  // Who is asking, as a person — or nothing, when it is not the console. See
  // `activityHeartbeat.js` for what a console may say and how it is checked.
  const person = await heartbeatPerson(session, store, privacy, params);

  let events = [];
  let people = { peopleCount: 0, people: [] };
  const visible = (path) =>
    typeof path === "string" && !isPlumbing(path) &&
    canSee(path, session.scope, privacy.rules, privacy.overrides);
  try {
    const room = env.PRESENCE_ROOM.get(
      env.PRESENCE_ROOM.idFromName(agentActivityKey(session.workspaceId)),
    );
    const response = await room.fetch("https://presence.invalid/activity", {
      method: "GET",
      headers: person ? { "x-activity-person": JSON.stringify(person) } : {},
    });
    const body = await response.json();
    if (Array.isArray(body?.events)) events = body.events;
    people = peopleFromRoom(body, visible);
  } catch {
    // No log is an empty answer. The tree simply draws no marks.
  }
  const wellFormed = events
    // An object still running the previous version logged `write`.
    .map((event) => (event?.kind === "write" ? { ...event, kind: "edit" } : event))
    .filter(
      (event) =>
        event && typeof event.path === "string" && typeof event.id === "string" &&
        typeof event.name === "string" && ACTIVITY_KINDS.has(event.kind) &&
        (event.kind !== "move" || typeof event.from === "string") &&
        Number.isFinite(event.at),
    );
  return json({
    ...activityForCaller(
      wellFormed,
      now,
      visible,
      await presenceClientKey(`person:${session.actorUserId}`),
      { since },
    ),
    ...people,
  });
}

/**
 * The room's people, re-checked for shape and filtered for this caller.
 *
 * Rebuilt field by field rather than passed through, so nothing the room
 * holds reaches a sidebar unless it is named here. A person's note is shown
 * only when *this* caller can see it — the person was allowed to say it
 * because they could, which says nothing about who is asking — and is
 * `null` otherwise: they are still listed, as they were before the map, just
 * not placed anywhere.
 */
function peopleFromRoom(body, visible) {
  const count = Number.isInteger(body?.peopleCount) && body.peopleCount >= 0 ? body.peopleCount : 0;
  const listed = Array.isArray(body?.people)
    ? body.people
        .filter(
          (person) =>
            person && typeof person.id === "string" && typeof person.name === "string" &&
            typeof person.color === "string" && typeof person.self === "boolean",
        )
        .map((person) => {
          const path = visible(person.path) ? person.path : null;
          return {
            id: person.id,
            name: person.name,
            color: person.color,
            self: person.self,
            path,
            doing: path === null ? null : person.doing === "edit" ? "edit" : "read",
          };
        })
    : [];
  return { peopleCount: Math.max(count, listed.length), people: listed };
}
