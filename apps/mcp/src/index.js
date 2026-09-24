/**
 * Context — a scoped MCP server over a customer-owned bucket of markdown notes.
 *
 * Zero npm dependencies. Every storage call goes through a ContextStore
 * adapter (`src/store/`), so the same worker serves an R2 binding or any
 * S3-compatible endpoint. Keys are the customer's own keys: nothing here
 * namespaces or rewrites a path.
 *
 * Access model — OAuth, and only OAuth:
 *
 * Every request carries an OAuth 2.1 access token, which the control plane
 * resolves to a grant, a workspace, and a set of scopes. There is no static
 * shared secret in this worker and no environment variable that grants access
 * to anything. The old `PRIVATE_TOKEN` / `TEAM_TOKEN` / `PUBLIC_TOKEN` model is
 * *gone*, not fenced: a single-tenant construct that must never be extended to
 * multiple customers is safest when there is none of it left to extend.
 *
 * A session resolves to one workspace, a privacy tier (`private` for an owner,
 * `team` for everyone else) and scopes (`context:read`, `context:write`,
 * `context:capture`). Folder defaults and exact-note overrides live in the
 * private, Obsidian-visible privacy.md manifest inside the customer's own
 * bucket; scopes.yml and .note-acl objects are read only as a migration
 * fallback.
 *
 * Endpoints:
 *   POST /mcp                  MCP streamable HTTP (Authorization: Bearer <access token>)
 *   POST /@<slug>/mcp          the same context, named in the URL — a selector, never a boundary
 *   POST /t/<token>/mcp        compatibility fallback for clients that cannot set headers
 *   POST /inbox                drop a capture into 0-inbox/ (needs context:capture)
 *   GET  /.well-known/oauth-protected-resource[/…]    RFC 9728
 *   GET  /.well-known/oauth-authorization-server[/…]  RFC 8414
 *   POST /oauth/register       RFC 7591 dynamic client registration
 *   GET  /oauth/authorize      authorization code + PKCE (S256 only)
 *   POST /oauth/token          code exchange and refresh
 *   POST /oauth/revoke         RFC 7009, one client at a time
 *   POST /granola-webhook      signed Granola note events (single-deployment only)
 *   cron                       calendar refresh (single-deployment only)
 *
 * **Nothing here snapshots a previous version.** This gateway used to copy
 * every overwritten, moved and archived body to `.history/<path>.<stamp>.md`
 * on the premise that "object storage has no dependable versioning". It does:
 * R2, S3, B2 and Wasabi all version at the bucket, for free, capturing the
 * Obsidian and rclone writes our snapshots never saw. What the snapshots
 * actually bought was write amplification — tens of thousands of objects
 * standing for a few hundred notes, in the customer's bucket and synced down
 * to every vault — for a rollback that was never built and could not be read
 * back anyway, since `isPlumbing` refuses every dot-prefixed segment at every
 * scope, personal included.
 *
 * So versioning is the customer's to enable on a bucket they own, and this
 * gateway does not keep a second copy of their notes. The consequence is
 * stated plainly rather than dressed up: with versioning off, an overwrite is
 * final. See docs/decisions/storage-and-credentials.md.
 *
 * `.history/` remains plumbing — legacy buckets are full of it, it stays
 * unreadable and unlistable, and `deletePath` in
 * apps/convex/functions/lib/fileOps.ts still purges what is there.
 */

/*
 * Module map. This file is the Worker's entry and nothing more: the default
 * export's `fetch`, `scheduled` and `queue` handlers, the presence room's
 * Durable Object class, and the names tests import from here. Everything else
 * lives by subject, and no module imports this file back:
 *
 *   http/       route.js (every request, in the order of checks that is the
 *               security boundary), responses.js, routing.js
 *   mcp/        handlers.js (legacy and modern transport), sessionInstructions.js,
 *               instructions.js, responses.js, usage.js
 *   tools/      dispatch.js (`callTool`, the switch), session.js
 *               (`callToolForSession`, the one path to it), advertised.js
 *               (tools/list, aliases, unlisted, argument validation),
 *               schemas.js (+ schemas/, one list per family), registry.js,
 *               and one module per tool family:
 *               notes/, moves/, forms/, encryption/, visibility, search,
 *               readImage, saveContext, proposalActions, meetings,
 *               communications, links, …
 *   privacy/    engine.js (privacy.md parsing, canSee, effectiveVisibility,
 *               overrides, archive roots — evaluated from its own text by the
 *               control plane's gatewayFormat.helpers.ts, so it imports
 *               nothing), state.js (loading and recording the manifest),
 *               scopeInfo.js (the write-surface text)
 *   live/       relayAuthorization, collaborationRoute, presenceRoute,
 *               collaborationHttp, presence, agentActivity
 *   activity/   record (recordChange), readActivity, changes
 *   orient/     tool, survey, frontPage, render, access
 *   notes/      visibleKeys, paths, storage, format, embeds, sealing
 *   moves/      queueConsumer, limits, jobs, objects
 *   search/     visibleNotes, scan, budget, pacing, maintenance, writeProjection
 *   ingestion/  inboxRoute, granolaWebhook, inbox, granola, transcription
 *   agent/      route (`/agent`), turn, providers
 *   meetings/   notes          calendar/  sync, ics     context/  identity
 *   encryptionKeys/  rotation, exportRateLimit     crypto/  bytes
 *   plugins/listPluginsTool.js
 *
 * Tests that read the gateway as text read the module that holds the code,
 * and require it to be the only one that does (test/gatewaySource.mjs): the
 * dispatch census reads tools/dispatch.js, tools/session.js and
 * tools/advertised.js; IMAGE_MIME_TYPES and MAX_INLINE_IMAGE_BYTES are scraped
 * from tools/readImage.js by the email worker's and control plane's tests.
 */
import { PresenceRoom as PresenceRoomDurableObject } from "./presenceRoom.js";
import { snippetLinesFor } from "./search/visible.js";
import { localIngestionStore } from "./ingestion/inbox.js";
import { json } from "./http/responses.js";
import { authorizeLiveRelay } from "./live/relayAuthorization.js";
import { handleGatewayJobMessage } from "./moves/queueConsumer.js";
import { processPendingGranolaEvents } from "./ingestion/granolaWebhook.js";
import { route } from "./http/route.js";
import { syncCalendar } from "./calendar/sync.js";
import { NoteCapReached } from "./store/noteCap.js";

export { presenceClientKey } from "./live/relayAuthorization.js";
export { EXISTENCE_MASKED_TOOLS, toolDefinitions } from "./tools/advertised.js";

/**
 * One catch around the whole request.
 *
 * An unhandled throw in a Worker is not an error response — it is a 1101 with
 * no body at all, which tells a client nothing and an operator less. Two
 * separate bugs have escaped exactly this way: a `URIError` from a malformed
 * `%` escape in the path, and a `TypeError` from a prototype-named JSON-RPC
 * method. Both were fixed at their source; both would have been a plain 500
 * rather than a dead request had this existed. Two of a kind is enough to stop
 * patching the class one instance at a time.
 *
 * It carries no detail on purpose. A thrown message here could be anything the
 * request reached — a storage error naming a key, a parser quoting its input —
 * and this response goes to an unauthenticated caller on the open internet.
 *
 * The operator gets the error's class and nothing else. Catching here removes
 * the throw from Cloudflare's exception stream, and this Worker logs nowhere
 * else, so a silent catch would trade a dead request for an invisible one — a
 * worse bargain than the bug. A class name is a fixed identifier from the
 * runtime or from our own code (`TypeError`, `ControlPlaneError`), never
 * sender-derived, which is the same line the response body draws.
 *
 * Two things make that a check rather than an audit. `instanceof Error` first,
 * because `name` and `constructor` on a thrown plain object are whatever the
 * thrower put there — every `throw` in this Worker raises an `Error` subclass
 * today, and that is a property of code somebody will edit. And its own `try`,
 * because reading a property can itself throw: a getter or a Proxy that throws
 * would escape `fetch` and restore the bodyless 1101 this guard exists to
 * remove, so the guard would un-guard itself on exactly the input it is for.
 */
/**
 * The presence room, re-exported because the runtime resolves a Durable Object
 * class off the Worker's entry module by the name its binding declares. It is
 * the only export here besides the default, and it holds no state of its own —
 * see `presenceRoom.js` for why an object with no storage is the whole design
 * rather than an omission.
 *
 * `export const` rather than `export { PresenceRoom }`. That once mattered
 * because `gatewayFormat.helpers.ts` evaluated this file's body and refuses
 * export forms that only *name* a binding; it now evaluates
 * `privacy/engine.js` alone, and the form stays because it is what the
 * Workers runtime wants either way.
 */
class AuthorizedPresenceRoom extends PresenceRoomDurableObject {
  async authorizeLiveRelay(input) {
    return authorizeLiveRelay(this.env, input);
  }
}

export const PresenceRoom = AuthorizedPresenceRoom;

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      // A create refused at the free tier's note cap is an answer, not a
      // fault: our own sentence and a fixed code, no key and no content.
      if (error instanceof NoteCapReached) {
        return json({ error: "note_cap_reached", cap: error.cap, message: error.message }, 403);
      }
      try {
        console.error(
          "unhandled",
          error instanceof Error ? String(error.name).slice(0, 64) : typeof error
        );
      } catch {
        console.error("unhandled", "unknown");
      }
      return json({ error: "server_error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    const store = localIngestionStore(env);
    if (!store) return;
    ctx.waitUntil(
      Promise.all([syncCalendar(env, store), processPendingGranolaEvents(env, store)])
    );
  },

  async queue(batch, env) {
    await Promise.all((batch?.messages || []).map((message) => handleGatewayJobMessage(message, env)));
  },
};
