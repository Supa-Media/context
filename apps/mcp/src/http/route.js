/**
 * `route` — every HTTP request to the gateway, in one function whose ORDER of
 * checks is the security boundary (origin, well-known, OAuth, the transport
 * and its session, then each surface). Moved verbatim out of `index.js`; it
 * is one statement, so a pure move cannot make this file shorter.
 */

import { openaiAppsChallengeResponse } from "./openaiAppsChallenge.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { matchWellKnown } from "./routing.js";
import { decorateRequestStore } from "./requestStore.js";
import { serveMcp } from "./mcpRoute.js";
import {
  authorizationServerMetadata,
  forbiddenResponse,
  handleAuthorize,
  handleRegister,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
  publicOrigin,
  unauthorizedResponse,
} from "../oauth.js";
import { resolvePresentedSession } from "./presentedToken.js";
import { attachPinnedDoors } from "./pinnedDoors.js";
import { attachContextOpener, onceEach } from "./contextOpener.js";
import {
  decodePathSegment,
  hasScope,
  SCOPE_CAPTURE,
  SCOPE_READ,
  SCOPE_WRITE,
  sessionForContext,
  SessionRefusal,
  splitWorkspacePath,
  StorageUnavailable,
  storeForSession,
} from "../session.js";
import { corsResponse, json } from "./responses.js";
import { createControlPlane } from "../controlPlane.js";
import { enforceOrigin, isTransportPath } from "../origin.js";
import { handleAgent } from "../agent/route.js";
import { handleReview } from "../agent/selfReview.js";
import { DREAMS_CLIENT_ID, handleDream } from "../agent/dream.js";
import { HEARTBEAT_CLIENT_ID, handleHeartbeat } from "../agent/heartbeat.js";
import { HOUSEKEEPING_CLIENT_ID, handleHousekeeping } from "../agent/housekeeping.js";
import { streamTurn, wantsProgress } from "../agent/progress.js";
import { APP_ROUTES } from "./appRoutes.js";
import { handleMessagesBackup, isMessagesBackupPath, isMessagesBackupRead, messagesBackupRefusal } from "../communications/messagesBackup.js";
import { MESSAGES_BACKUP_LOG_ROUTE, handleMessagesBackupFileRead, handleMessagesBackupLog } from "../communications/messagesBackupRead.js";
import { handleMessagesBackupFile } from "../communications/messagesBackupFiles.js";
import { MESSAGES_BACKUP_ROUTE, parseFileRoute } from "../../../../packages/communications/src/backup.js";
import { handleTexComputer, TEX_COMPUTER_PATHS } from "./texComputer.js";
import { ACCESS_SOCKET_PATH, handleAccess, handleAgentActivity, handlePresence, handleTree, TREE_SOCKET_PATH } from "../live/presenceRoute.js";
import { handleCollaboration } from "../live/collaborationRoute.js";
import { handleInbox } from "../ingestion/inboxRoute.js";
import {
  handleMeetings,
  isMeetingPath,
  matchMeetingRoute,
  meetingScopeRefusal,
  scopeForMeetingRequest,
} from "../meetings/ingest.js";
import { MEETING_SUMMARY_PATH, handleMeetingSummary } from "../meetings/summarize.js";
import { publishMeetingNote, resolveMeetingNotePath } from "../meetings/notes.js";
import { transcriptionForwarder } from "../ingestion/transcription.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";
import { PRODUCTION_MEETING_SUMMARIES_PATH, readJobSetupWith } from "../agent/production.js";
import { handleTryIt } from "../agent/tryIt.js";
import { TEXTING_ROUTES } from "../agent/textingRoutes.js";
import { withSearchPassesHeld } from "../search/heldPasses.js";
import { MOVER_PAGE_PATH, handleMoverPage } from "../moves/mover.js";
import { TEX_STORE_PATH, handleTexStoreDoor } from "../texStore/door.js";
import { WORKSPACE_STORE_PATH, handleWorkspaceStoreDoor } from "../workspaceStore/door.js";
import { IMAGE_UPLOAD_PATH, handleImageUpload } from "../notes/imageUploads.js";
import { judgeFor } from "../privacy/judge.js";

export async function route(request, env, ctx) {
    const url = new URL(request.url);

    // The control plane's own call to the mover, on the raw path so no workspace selector is ever read off it.
    // It takes no person's token: the gateway secret and a ticket the control plane minted (`moves/mover.js`).
    if (url.pathname === MOVER_PAGE_PATH) return await handleMoverPage(request, env);
    // The control plane reaching Tex's notes (`texStore/door.js`) or a workspace object (`workspaceStore/door.js`), the same way.
    if (url.pathname === TEX_STORE_PATH) return await handleTexStoreDoor(request, env);
    if (url.pathname === WORKSPACE_STORE_PATH) return await handleWorkspaceStoreDoor(request, env);
    // An upload link's PUT (`notes/imageUploads.js`): no person's token and no
    // workspace selector; the ticket in its header is the whole authority.
    if (url.pathname === IMAGE_UPLOAD_PATH) return await handleImageUpload(request, env);

    const origin = publicOrigin(request, env);

    // The workspace selector comes off the front first, so every route below
    // sees the same path whether or not the caller named a context. The slug
    // selects; it never authorizes. See splitWorkspacePath.
    //
    // Meeting ingestion used to be lifted out of this line — `isMeetingPath` on
    // the raw pathname, before the selector — because `meetings` was not one of
    // `workspacePath.js`'s RESERVED_FIRST_SEGMENTS, so `POST /meetings/sessions` read
    // as a workspace called "meetings" selecting the path `/sessions`. That was
    // one route defending itself against a list it was missing from, and it left
    // the actual hole open: the name was still claimable, in a namespace where a
    // name is also a mailbox on the apex. `meetings` is in that list now, and in
    // the control plane's RESERVED_NAMES beside it, so this needs no exception.
    const { slug, path: afterSlug } = splitWorkspacePath(url.pathname);

    // Token-in-path fallback: /t/<token>/mcp, or /@slug/t/<token>/mcp.
    //
    // Kept for clients that genuinely cannot set an Authorization header. It is
    // a TRANSPORT for an OAuth-issued access token and nothing else: the token
    // is resolved by exactly the same code as a header token, gets exactly the
    // same grant, and confers exactly the same authority. It is not, and has
    // never been, the security boundary. A token in a URL lands in browser
    // history, proxy logs, and referrer headers, so prefer the header.
    let path = afterSlug;
    let pathToken = null;
    const tokenInPath = path.match(/^\/t\/([^/]+)(\/.*)?$/);
    if (tokenInPath) {
      // A malformed escape decodes to nothing rather than throwing out of
      // `fetch`. An undecodable token is not a token; the route still resolves
      // and the request gets the ordinary 401 instead of a Worker exception.
      pathToken = decodePathSegment(tokenInPath[1]);
      path = tokenInPath[2] || "/";
    }

    // MCP says a server MUST validate `Origin` on the Streamable HTTP
    // transport, to stop a page in a victim's browser from reaching an
    // authenticated endpoint by DNS rebinding. See `src/origin.js` for what
    // counts as valid — in particular that *absence* is not an attack signal
    // and `null` is not absence.
    //
    // It runs here, above the method dispatch and above every auth path, for
    // two reasons: the preflight is refused on the same terms as the request it
    // precedes, and the refusal is produced before any token, slug, or control
    // plane answer exists to vary it.
    //
    // The meeting routes are guarded on the same terms. They are authenticated,
    // state-changing and reachable from a browser, which is the whole of
    // `isTransportPath`'s reasoning about `/inbox` — and the list itself lives
    // in `origin.js`, so this asks the question here rather than editing
    // another module's idea of what speaks the MCP transport.
    if (isTransportPath(path) || isMeetingPath(path) || path === MEETING_SUMMARY_PATH || isMessagesBackupPath(path)) {
      const refusal = enforceOrigin(request, env);
      if (refusal) return refusal;
    }

    if (request.method === "OPTIONS") return corsResponse();

    const challenge = openaiAppsChallengeResponse(request, env, { slug, path });
    if (challenge) return challenge;

    const wellKnown = matchWellKnown(path);
    if (wellKnown) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405 });
      }
      if (wellKnown.kind === "authorization-server") {
        return authorizationServerMetadata(origin, env.APP_ORIGIN);
      }
      // A client that was handed `https://host/@seyi/mcp` probes
      // `/.well-known/oauth-protected-resource/@seyi/mcp` before the root form,
      // so the slug can arrive in the prefix or in the suffix. Either way it
      // describes the same resource.
      return protectedResourceMetadata(origin, slug || wellKnown.slug);
    }

    if (path.startsWith("/oauth/")) {
      const controlPlane = createControlPlane(env);
      try {
        if (path === "/oauth/register" && request.method === "POST") {
          return await handleRegister(request, env, controlPlane);
        }
        if (path === "/oauth/authorize" && request.method === "GET") {
          return await handleAuthorize(request, env, controlPlane, { origin, slug });
        }
        if (path === "/oauth/token" && request.method === "POST") {
          return await handleToken(request, env, controlPlane, { origin, slug });
        }
        if (path === "/oauth/revoke" && request.method === "POST") {
          return await handleRevoke(request, env, controlPlane);
        }
      } catch {
        // Never relay a control-plane failure verbatim: its text is written for
        // operators and the caller is an AI client on the open internet.
        return json({ error: "server_error" }, 503);
      }
      return new Response(null, { status: 405 });
    }

    // Who else is in this note. Its own branch rather than a line in the block
    // below, because it is the one authenticated route that is a GET, answers
    // 101 rather than JSON, and needs no queue, no usage counter and no search
    // budget — it never reads a note and never writes one.
    if (path === "/presence") return await handlePresence(request, env, { slug, pathToken, origin });
    // The app's live file tree and access screens from the objects (`live/treeRoute.js`, `live/accessRoute.js`): sockets, likewise.
    if (path === TREE_SOCKET_PATH || path === ACCESS_SOCKET_PATH) return await (path === TREE_SOCKET_PATH ? handleTree : handleAccess)(request, env, { slug, pathToken, origin });

    // Which notes agents touched lately, for the console's file tree. Its own
    // branch for the reasons `/presence` has one: a GET that reads no note,
    // writes nothing, and needs no queue, usage counter or search budget.
    if (path === "/agent-activity") {
      return await handleAgentActivity(request, env, { slug, pathToken, origin, ctx });
    }

    // The person's own look at Tex's browser, for the app's `/tex/<handle>`
    // page. Its own branch for the reasons `/presence` has one: it reads no
    // note, writes nothing and needs no store. It takes a header token only.
    if (TEX_COMPUTER_PATHS.has(path)) {
      return await handleTexComputer(request, env, { path, origin });
    }

    // The MCP transport: every step timed by the MCP entry point (`mcpRoute.js`).
    if (path === "/mcp") return await serveMcp(request, env, ctx, { slug, pathToken, origin });

    // A meeting route resolves a session exactly as `/mcp` does — same token,
    // same grant, same clamps — so it shares this block rather than growing a
    // second copy of it. What it does not share is the method: the contract
    // reads a session back over GET, so the POST-only gate below is asked of
    // the MCP transport paths only, and `handleMeetings` answers a wrong method
    // with a meeting error naming the route.
    const meetingRoute = matchMeetingRoute(path);
    const summaryRoute = path === MEETING_SUMMARY_PATH;
    // The app's own routes (`appRoutes.js`): what the egress gate is holding,
    // and what a card in Messages shows. Each is read over GET, so the
    // POST-only gate below is not asked of them either.
    const appRoute = APP_ROUTES.get(path);
    // The Mac app's Messages backup (`communications/messagesBackup.js`): a
    // batch, or one file. A path under the file route that is not one is
    // still this route, refused below rather than read as anything else.
    const messagesBackupRoute = isMessagesBackupPath(path);
    if (
      summaryRoute ||
      path === "/inbox" ||
      path === "/agent" ||
      path === "/agent/try" ||
      TEXTING_ROUTES.has(path) ||
      path === "/agent/review" ||
      path === "/collaboration" ||
      appRoute ||
      messagesBackupRoute ||
      meetingRoute
    ) {
      const backupRead = messagesBackupRoute && isMessagesBackupRead(path, request.method);
      if (!meetingRoute && !appRoute && !backupRead && request.method !== "POST") return new Response(null, { status: 405 });
      const controlPlane = createControlPlane(env);
      let session;
      try {
        session = await resolvePresentedSession(request, { pathToken, path, slug, controlPlane });
      } catch (error) {
        if (!(error instanceof SessionRefusal)) throw error;
        // A 403 from workspace selection deliberately drops the slug from its
        // challenge, so the refusal for "a real context you cannot reach" is
        // byte-identical to the one for a name nobody has ever registered.
        // Echoing it back would make the challenge header itself the oracle the
        // status code was careful not to be.
        return error.status === 403
          ? forbiddenResponse(origin, null, error)
          : unauthorizedResponse(origin, slug, error);
      }

      // The sharing judge (the owner, 2026-10-18): a call that lets more people
      // see something runs when the person's own words ask for it, read by a
      // small model (`privacy/judge.js`). Off unless set; nothing without a model.
      if (env.SHARING_JUDGE === "on") {
        const judge = judgeFor(env);
        if (judge) session.sharingJudge = judge;
      }

      // A meeting write is a write, and it is checked here — before a store
      // exists and before any lookup — so the refusal is decided without
      // reading anything and therefore discloses nothing about what this
      // context holds. `hasScope` reads the already-clamped set, so a `member`
      // of somebody else's workspace is refused by their role and not only by the
      // grant.
      // `/agent` asks for read and nothing more. Every write it can make is a
      // *proposal*, which the connection's own clamp decides on per call in
      // `callToolForSession` — so a read-only grant gets an assistant that can
      // answer and cannot suggest, which is the honest shape of a read-only
      // grant rather than a special case.
      // A summary is written into the note, so it needs write like any edit.
      // `/approvals` needs only read. Answering an approval releases a write,
      // but the release is replayed through `callToolForSession`, which checks
      // write against the workspace the call actually lands in: this
      // connection's default workspace may clamp the person to `member` where
      // they are an `editor` in the one they asked to write into. Clamping
      // the route here would 403 them there, and they could never approve it.
      const needed = summaryRoute || messagesBackupRoute
        ? SCOPE_WRITE
        : appRoute
        ? SCOPE_READ
        : meetingRoute
        ? scopeForMeetingRequest(request.method)
        : path === "/inbox"
          ? SCOPE_CAPTURE
          : SCOPE_READ;
      if (!hasScope(session, needed)) {
        // A meeting client is owed one of the contract's error codes, not the
        // OAuth challenge the MCP transport answers with; it names the one
        // missing scope for the same incremental-consent reason.
        if (meetingRoute || summaryRoute) return meetingScopeRefusal(needed);
        return forbiddenResponse(origin, null, {
          description: `This connection does not hold the ${needed} scope.`,
          // Incremental consent: name the one scope that was missing, so the
          // client can re-authorize for it rather than for everything.
          scope: [needed],
        });
      }

      // Owner, personal workspace, private tier: decided before a store opens.
      if (messagesBackupRoute) {
        const refusal = messagesBackupRefusal(session, slug);
        if (refusal) return refusal;
      }

      // A tool call that names another workspace opens it beside this one, not after (`contextOpener.js`).
      const openOnce = onceEach((target) => storeForSession(target, env, controlPlane));
      let store;
      try {
        store = await storeForSession(session, env, controlPlane);
      } catch (error) {
        if (!(error instanceof StorageUnavailable)) throw error;
        // Authenticated, but this workspace has no bucket we can reach. A
        // refusal, never a fallback: there is no other store to serve from and
        // reaching for one would be the cross-tenant bug itself.
        return json(
          {
            error: "storage_unavailable",
            error_description:
              "This context has no reachable storage. Reconnect it from the dashboard.",
          },
          503
        );
      }

      decorateRequestStore(store, { session, env, controlPlane, ctx, request, origin });

      if (path === "/collaboration") {
        store.actor = actorFor(session);
        return handleCollaboration(request, store, session, origin);
      }

      // Capture is anchored to the context its grant was approved for, so the
      // inbox store is built without the opener at all rather than with one
      // nothing calls. That makes "a capture-only credential reaches exactly
      // one context" structural instead of a sentence someone has to keep true.
      if (path === "/inbox") return handleInbox(request, env, store, session);

      // Meetings are anchored to the context the request addressed, for the
      // reason capture is: the store is built without an opener, so a recorder
      // left running on a laptop reaches exactly one context and a meeting
      // cannot be filed into a workspace the URL did not name. The acting identity
      // rides on the store so the audit line for a written meeting says who,
      // and not merely at what tier.
      if (summaryRoute) {
        store.actor = actorFor(session);
        // The summary's own setup note is the one other thing this route reads:
        // `@context-lc ai/production/meeting-summaries.md`, through the
        // caller's own membership and clearance there, opened only for that
        // read. The meeting's store itself still opens nothing.
        const readSetup = () =>
          readJobSetupWith(
            {
              contexts: contextsFor(session),
              openPinned: async () => {
                const target = sessionForContext(session, PINNED_CONTEXT_NAME);
                return { session: target, store: await storeForSession(target, env, controlPlane) };
              },
            },
            PRODUCTION_MEETING_SUMMARIES_PATH,
          );
        return handleMeetingSummary(request, store, session, { controlPlane, env, readSetup });
      }

      if (meetingRoute) {
        store.actor = actorFor(session);
        return handleMeetings(request, path, store, session, {
          publishNote: publishMeetingNote,
          // `null` on a deployment with no transcription configured, which is
          // the ordinary state of a self-hosted install and answers 501 rather
          // than pretending. See `meetings/transcribe.js`.
          transcribe: transcriptionForwarder(env),
          transcriptionConsent: () => controlPlane.transcriptionConsent(session.accessToken, session.workspaceId), // transcription-consent.md
          // M1: resolve a session's note by id when its stored path has moved.
          // See `resolveMeetingNotePath`'s own header for why this lives here
          // rather than in `meetings/ingest.js`.
          resolveNotePath: resolveMeetingNotePath,
        });
      }

      // Other contexts, each opened at most once this request (`contextOpener.js`).
      attachContextOpener(store, session, { env, controlPlane, origin, openOnce, pinnedName: PINNED_CONTEXT_NAME });
      // A group chat's turn reads Tex's setup in the pin it may not otherwise address, and keeps its home there.
      attachPinnedDoors(store, session, (sibling) => storeForSession(sibling, env, controlPlane));

      // After `store.openContext` is attached, deliberately: a turn may address
      // another context by name exactly as a client's tool call can, through
      // the same one place that decision is taken.
      if (path === "/agent") {
        // A turn is one invocation: the index passes its searches start wait
        // for it to end, or every later call queues behind them (`search/heldPasses.js`).
        const held = (turn) => withSearchPassesHeld(store, turn);
        // Tex's housekeeping has its own client and its own guarded turn (`agent/housekeeping.js`).
        if (session.actorClientId === HOUSEKEEPING_CLIENT_ID) return await held(() => handleHousekeeping(request, env, store, session, controlPlane));
        // Tex's nightly dream has its own client and its own turn, and does nothing else (`agent/dream.js`).
        if (session.actorClientId === DREAMS_CLIENT_ID) return await held(() => handleDream(request, env, store, session, controlPlane));
        // So has its daytime check-in, which only reads (`agent/heartbeat.js`).
        if (session.actorClientId === HEARTBEAT_CLIENT_ID) return await held(() => handleHeartbeat(request, env, store, session, controlPlane));
        // The texting Worker asks for a long task as a stream of progress
        // lines (`agent/progress.js`); everyone else gets the whole turn.
        if (!wantsProgress(request)) return await held(() => handleAgent(request, env, store, session, controlPlane));
        return streamTurn((progress, step) => held(() => handleAgent(request, env, store, session, controlPlane, { progress, step })), {
          waitUntil: ctx && typeof ctx.waitUntil === "function" ? (work) => ctx.waitUntil(work) : null,
        });
      }
      // The console's Try it box (`agent/tryIt.js`): one read-only turn on a
      // setup an @context-lc editor picked, then a judge turn on its rules.
      // The texting Worker's steer, events, cancel and stale asks (`agent/textingRoutes.js`).
      if (TEXTING_ROUTES.has(path)) return await TEXTING_ROUTES.get(path)(request, store, session);
      // The texting Worker saw a chat go quiet: score how it went (`agent/selfReview.js`).
      if (path === "/agent/review") return await handleReview(request, env, store, session, controlPlane);
      if (path === "/agent/try") return await withSearchPassesHeld(store, () => handleTryIt(request, env, store, session, controlPlane));
      if (appRoute) return await appRoute(request, store, session, path);
      if (messagesBackupRoute) {
        const file = parseFileRoute(path);
        if (backupRead) return file ? await handleMessagesBackupFileRead(store, file) : path === MESSAGES_BACKUP_LOG_ROUTE ? await handleMessagesBackupLog(request, store, session) : json({ ok: false, error: "not_found" }, 404);
        if (file) return await handleMessagesBackupFile(request, store, file);
        return path === MESSAGES_BACKUP_ROUTE ? await handleMessagesBackup(request, store) : json({ ok: false, error: "not_found" }, 404);
      }

      return json({ error: "not_found" }, 404);
    }

    return json({ error: "not_found" }, 404);
}
