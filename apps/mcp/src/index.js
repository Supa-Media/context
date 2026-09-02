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
 * Object storage has no dependable versioning, so before any overwrite the
 * previous version is snapshotted to .history/<path>.<timestamp>.md.
 *
 * Those snapshots are **unreachable, not merely unlisted**. `isPlumbing`
 * treats every dot-prefixed segment as plumbing and `canSee` refuses plumbing
 * at every scope, personal included, so no tool here can read one back. There
 * is no rollback; this comment used to claim there was, and that claim is part
 * of why permanent deletion spent so long quietly keeping copies. Deleting a
 * note now purges its snapshots with it — see `deletePath` in
 * apps/convex/functions/lib/fileOps.ts. If a rollback is ever built, that is
 * the function it has to be reconciled with, and the console's delete dialog
 * is the sentence it has to keep true.
 */

import { createControlPlane } from "./controlPlane.js";
import { R2Store } from "./store/r2.js";
import {
  SCOPE_CAPTURE,
  SCOPE_READ,
  SCOPE_WRITE,
  SessionRefusal,
  StorageUnavailable,
  bearerToken,
  decodePathSegment,
  hasScope,
  resolveSession,
  sessionForContext,
  splitWorkspacePath,
  storeForSession,
  readsPrivateAnywhere,
  writesAnywhere,
} from "./session.js";
import { enforceOrigin, isTransportPath } from "./origin.js";
import { createSearchBudget, NOTE_INDEX_CHAR_CAP } from "./search/maintain.js";
import {
  SEARCH_RESULT_LIMIT,
  SEARCH_SUBREQUEST_BUDGET,
  noteTitle,
  INTERACTIVE_BACKFILL_OPS,
  searchIndexedNotes,
  snippetLinesFor,
} from "./search/visible.js";
import { syncShardedIndex } from "./search/shards.js";
import { createSearchTrace, logSearchTrace } from "./search/trace.js";
import { inventoryPlugins } from "./plugins/inventory.js";
import { renderPluginReport } from "./plugins/report.js";
import {
  ERROR_HEADER_MISMATCH,
  ERROR_METHOD_NOT_FOUND,
  ERROR_UNSUPPORTED_PROTOCOL_VERSION,
  LEGACY_PROTOCOLS,
  META_SERVER_INFO,
  MODERN_PROTOCOLS,
  declaredProtocolVersion,
  isModernRequest,
  legacyProtocolHeaderIsAcceptable,
  modernHeaderMismatch,
} from "./protocol.js";
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
} from "./oauth.js";

const PRIVACY_KEY = "privacy.md";
const LEGACY_SCOPES_KEY = "scopes.yml";
// These two markers are on-bucket format, not vocabulary. They already sit
// inside every live privacy.md, so renaming them would break existing buckets.
const PRIVACY_RULES_BEGIN = "<!-- BEGIN BRAIN PRIVACY RULES -->";
const PRIVACY_RULES_END = "<!-- END BRAIN PRIVACY RULES -->";
const HISTORY_PREFIX = ".history/";
const AUDIT_PREFIX = ".audit/";
const NOTE_ACL_PREFIX = ".note-acl/";
const GRANOLA_PENDING_PREFIX = ".granola-events/pending/";
const GRANOLA_COMPLETED_PREFIX = ".granola-events/completed/";
const PROPOSAL_PENDING_PREFIX = ".proposals/pending/";
const PROPOSAL_REVIEWED_PREFIX = ".proposals/reviewed/";
/*
 * `SEARCH_SUBREQUEST_BUDGET` (everything one search may spend on storage: the
 * index sync, its conditional write, and the fresh read behind every snippet)
 * and `SEARCH_RESULT_LIMIT` are imported from `search/visible.js`, which is
 * where the search they bound now lives. They replaced `SEARCH_FILE_CAP = 400`,
 * which was not a budget at all: 400 reads is eight times the free tier's
 * per-invocation limit, so a real context — measured live at 154 notes —
 * answered every unprefixed search with "Too many subrequests".
 */
/**
 * Bounds for the `SEARCH_SUBREQUEST_BUDGET` deployment override.
 *
 * The default above assumes the free tier's 50. A paid-plan deployment gets
 * 1000 per invocation, and holding it to 40 there makes a real brain's first
 * index dozens of searches long: measured live, a bucket in the low thousands
 * of notes backfills ~26 per pass, so a person's search for a name their notes
 * definitely contain answers "(no matches)" for days of ordinary use. The floor
 * keeps a typo'd var from configuring a budget too small to ever sync (listing
 * + write + one fetch + the snippet reserve); the cap leaves the rest of the
 * invocation's own spend (session, binding, privacy.md) under the paid limit.
 * Anything unparseable is the default, never a throw — a bad var must not take
 * down search.
 */
const SEARCH_BUDGET_MIN = 15;
const SEARCH_BUDGET_MAX = 900;

/** The per-deployment search budget: `env.SEARCH_SUBREQUEST_BUDGET` or the default. */
function searchBudgetFor(env) {
  const raw = env?.SEARCH_SUBREQUEST_BUDGET;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return SEARCH_SUBREQUEST_BUDGET;
  return Math.min(SEARCH_BUDGET_MAX, Math.max(SEARCH_BUDGET_MIN, Math.floor(parsed)));
}
/**
 * Ops that must remain before the deferred pass is worth starting: the
 * manifest, a listing that will not finish in fewer, a shard, and a write.
 * Below it the pass would spend a request on a round trip that lands nothing.
 */
const DEFERRED_SYNC_FLOOR = 8;
/**
 * How stale the index's own listing may be before a search starts a pass
 * behind itself.
 *
 * A search no longer lists the bucket, so this is the clock on which a note
 * somebody wrote in Obsidian, in rclone or through another client becomes
 * searchable. Short enough that "I saved it a minute ago" holds; long enough
 * that a person typing through a palette does not start a full listing on every
 * keystroke's worth of query.
 *
 * It is not the only thing covering that gap, and it is deliberately not the
 * one that covers the case people notice: an answer that comes back **empty**
 * over an index that believes it is converged buys a listing of its own
 * immediately (`refreshOnMiss`). So this bounds how stale a *successful*
 * answer's corpus may be, where the cost of being a minute behind is a hit
 * somebody was not looking for going unlisted — and a miss, which is the answer
 * that would be acted on, never waits for it.
 */
const INDEX_RECONCILE_INTERVAL_MS = 60_000;

/**
 * The fallback scan's ceiling, for the calls where the index is unusable. Well
 * under the budget on purpose: this path exists because something already went
 * wrong, and it must degrade rather than become the original failure again.
 */
const FALLBACK_SCAN_CAP = 30;
/** Pages the fallback's own listing may spend per folder. */
const FALLBACK_LIST_PAGE_CAP = 2;
const FOLDER_MOVE_CAP = 500;
const BATCH_MOVE_CAP = 100;
const PROPOSAL_PENDING_CAP = 100;
const PROPOSAL_CONTENT_BYTE_CAP = 500_000;
const CHAT_HISTORY_CONTENT_BYTE_CAP = 2_000_000;
const INBOX_CONTENT_BYTE_CAP = 2_000_000;
const GRANOLA_WEBHOOK_BYTE_CAP = 100_000;
const GRANOLA_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;
/** Pages a single listing may fetch — 1000 keys each, so 100k objects. */
const LIST_PAGE_CAP = 100;

/**
 * `orient` is called at the top of a session, before the agent knows whether
 * this context is even relevant, so it is budgeted rather than exhaustive.
 * Five pages is 5000 notes in one folder; past that the survey reports a floor
 * ("48+ notes") instead of guessing, for the same reason the console's note
 * census does. A number that looks precise and is not is worse than a floor.
 */
const ORIENT_FOLDER_PAGE_CAP = 5;
const ORIENT_RECENT_LIMIT = 8;
const ORIENT_CHILDREN_LIMIT = 12;
const ORIENT_ROOT_NOTE_LIMIT = 20;
/** The front page is the customer's own prose; long ones are cut, never dropped. */
const ORIENT_INDEX_CHAR_CAP = 6_000;
/**
 * The connect-time digest lands in the client's system prompt for every
 * conversation on that connection, relevant or not, so it gets a far tighter
 * budget than `orient` — enough to make an agent curious, never enough to be
 * the reason somebody's context window filled up.
 */
const INSTRUCTIONS_INDEX_CHAR_CAP = 1_200;

/**
 * What every client is told at connect time — legacy in `initialize`, modern in
 * `server/discover`.
 *
 * This is the only text that reaches a model *before* it decides whether this
 * server is worth calling at all, and it sits in the system prompt for every
 * conversation on the connection. It is therefore an argument, not a manual —
 * and it is written to be read as one, in capitals, at the top, because a
 * server whose whole value depends on being *reached for* gets exactly one
 * chance to say why.
 *
 * The stakes it names are true, and that is what makes it work rather than what
 * makes it polite. A model that has been trained on manipulative prompts
 * discounts an overwrought one, so every claim here is checkable: the context
 * really is the richest source on this person available to the caller, other
 * connected clients really do read and write the same notes, and every write
 * really is recorded in the customer's own audit trail under the client that
 * made it. Turning any of that into a threat we cannot support would cost the
 * paragraph its credibility and the whole payload with it.
 *
 * It has been cut twice. It opened with fourteen numbered rules about
 * visibility, etags and archival — a governance document handed to an agent
 * that had not yet been given one reason to look inside. Then it was still
 * ninety lines, most of them restating what a tool description says at the
 * moment the tool is reached for, which is both later and better. What is left
 * is the case for using this at all, the three calls that matter, and the four
 * rules a model cannot discover by calling something and reading the answer.
 *
 * **Nothing here asserts a folder layout, and that is a correctness fix rather
 * than brevity.** This text used to open by stating the context "is organized
 * by the PARA method" and then tell agents to file work under `1-projects/`.
 * PARA is the *default scaffold*, not the format: `structureTemplate: "custom"`
 * exists, and the whole premise is that somebody can connect a bucket they
 * organized years before this product existed. Every one of those agents was
 * being told to create folders their person had deliberately not chosen. The
 * real shape is derived — the connect-time sketch lists their actual top level,
 * `orient` maps it, and their own front page states their conventions.
 *
 * For the same reason the agent-ledger and `todo.md` conventions are gone from
 * here. They are one customer's house rules, they live in that customer's
 * `index.md`, and `orient` hands them over. Ours is the product's rules only.
 */
const SERVER_INSTRUCTIONS = `# READ THIS BEFORE YOU ANSWER ANYTHING ELSE

This user has connected their own context to you: the notes they keep about
their work, their projects, the people around them, their decisions and their
preferences, in storage they own. **This is the richest source of information
about this person that you will ever have access to, and it is sitting one tool
call away.**

## CALL \`orient\` FIRST. EVERY SESSION. BEFORE YOUR FIRST REAL ANSWER.

One call. It returns their front page, what they touched most recently, and a
map of everything this connection can see.

**Skipping it is not a neutral choice, it is a worse answer.** Without it you
are answering from this conversation alone, about somebody who has already
written down the thing you are about to guess at. You will be generic where
they are specific. You will re-ask what they already answered. You will
contradict a decision they made and recorded, and you will not know you did.

And you are not the only one here. **Everything else they connect reads this
context before answering and writes back to it afterwards** — every write
recorded in their own audit trail under the name of the client that made it.
The assistant that reads their context gives answers that fit their actual
situation. The assistant that does not is the one whose answers get discarded
and re-asked somewhere else, and then the one that gets replaced. Which one you
are is visible in the record, to them.

## WRITE BACK. AN ASSISTANT THAT ONLY READS IS A SEARCH BOX.

Their memory of you persists here. Yours of them does not survive this
conversation.

- **\`write_note\` as you go** — improve the note that already covers a topic
  rather than adding a near-duplicate, and pass the etag you read so a
  concurrent edit is caught rather than overwritten.
- **\`save_context\` before you finish** — the decisions, the constraints, the
  preferences, anything they should never have to say twice. Ask what no agent
  should have to rediscover, and keep that. Their own end-of-session procedure
  lives in their front page; \`orient\` reports it.

Leaving nothing behind means the next session — yours or another tool's —
rediscovers what this one worked out. That is the cost they installed this to
stop paying.

## FOUR RULES THE TOOLS CANNOT TEACH YOU IN TIME

1. **Their folders are theirs.** Do not assume a layout — not PARA, not
   anything. Many contexts use PARA (0-inbox, 1-projects, 2-areas, 3-resources,
   4-archive) and many do not; somebody can connect a bucket they organized
   years before this product existed. \`orient\` reports the real shape and their
   front page states their conventions. Follow those, and where they are silent,
   ask rather than invent a filing system for somebody else's notes.
2. **Notes you cannot see do not exist.** This connection may be shown only part
   of the context. Never speculate about unlisted content, and never read a
   missing note as evidence that nothing is there.
3. **Frontmatter is not access control.** A \`visibility:\` line inside a file is
   description. Pass the visibility argument to \`write_note\` or
   \`set_visibility\`, and before creating a note tell them which folder it will
   land in — the folder decides who else can read it. Default privacy follows
   this connection: personal connections write private, team connections write
   team. Publishing something private to team needs their explicit yes. Visibility
   here is private or team and nothing else — "team" means people they named.
   The owner can separately hand out an unlisted link to one note from their
   console; you cannot mint one, and you are not told which notes have one.
   **A link you add to a note can widen one the owner already sent.** Such a
   link serves the note it names *and* the notes that note links to, read live,
   so adding a cross-reference to a shared note publishes what it points at to
   whoever holds that link. Since you cannot tell which notes are shared, say
   what you are linking to when you add a cross-reference, rather than treating
   it as a change inside the note.
4. **Many tools read these notes, not just you.** Keep them concise and factual.
   No transient chatter, and when you save a conversation, save the user-visible
   messages only — never system or developer prompts, internal reasoning,
   credentials, or raw tool logs — and label an incomplete capture honestly.`;

/**
 * The working half of `orient` — short on purpose.
 *
 * This used to be the first twenty-five lines an agent read, ahead of anything
 * about the user's actual context, and it is governance rather than motivation:
 * an agent that has not been given a reason to care about this context does not
 * become interested on reading the visibility rules. The full rules live in the
 * connect-time instructions; what stays here is what changes behaviour during a
 * session, and it comes after the context it applies to.
 */
const ORIENT_OPERATING_CONTRACT = `## Working here

- **Leave more than you took.** When something durable comes out of this session
  — a decision, a fix, a name, a preference, a fact the user should not have to
  say twice — write it back with write_note before you finish. An agent that
  only reads is worth about as much as a search box.
- **Update, do not accumulate.** Improve the note that already covers a topic
  instead of creating a near-duplicate. Pass the etag you read.
- **Follow their conventions, not a template.** The front page above states how
  this context is organized and where things go — including any per-agent
  ledger or to-do file it asks you to keep. Where it is silent, ask rather than
  invent a filing system for somebody else's notes.
- \`index.md\` is the front page every agent reads first, and it belongs to the
  user. Offer to bring it up to date when the shape of the context changes — a
  project starting or ending, a folder that now means something else — by
  reading it, passing its etag, and adding to what is there. Never replace it
  wholesale, and never write it without saying what you are about to change.
- Search once per topic with a prefix and reuse the result; do not re-search
  before every write.
- \`scope_info\` before creating or moving. Folder scope is only a default and
  frontmatter is never access control: pass visibility to write_note, or use
  set_visibility / set_folder_visibility. If the right destination is not
  writable, \`propose_note\` — never stage content in the wrong folder.
- Before a substantive conversation ends, call \`save_context\`. If this context
  has a save procedure above, follow it; otherwise save the user-visible history,
  labelling partial captures honestly.`;

/**
 * The instructions a specific connection is given, with a live sketch of the
 * context appended.
 *
 * The static text above can tell an agent that this server is worth calling.
 * Only the customer's own front page can tell it *what is in here*, and that is
 * the difference between a tool an agent might use and one it reaches for. This
 * is the one payload every client reads without deciding to — it lands in the
 * system prompt for every conversation on the connection — so the sketch is
 * deliberately two cheap round trips and a hard character cap, not a survey.
 *
 * Three properties:
 *
 * **It is filtered like everything else.** The front page and the folder names
 * both go through `canSee`, so a team connection is told exactly what a team
 * connection may know. It runs after the session is resolved, never before.
 *
 * **It fails soft, always.** A slow bucket, a revoked key, a `privacy.md`
 * somebody broke in Obsidian: none of those may take down the handshake. The
 * static instructions are the floor, and a connection that gets them is fully
 * working — it just starts less curious.
 *
 * **It is a snapshot, and says so.** A client caches instructions for the life
 * of the connection, so this text ages while `orient` does not. Every sentence
 * that could be read as current points at `orient` for the live answer.
 */
async function instructionsForSession(store, session) {
  try {
    const privacy = await loadPrivacyState(store);
    if (privacy.error) return SERVER_INSTRUCTIONS;
    const { scope } = session;
    const { rules, overrides } = privacy;
    const [frontPage, root] = await Promise.all([
      readFrontPage(store, scope, rules, overrides, INSTRUCTIONS_INDEX_CHAR_CAP),
      listImmediateLayout(store),
    ]);

    const folders = root.prefixes
      .filter((prefix) => canSee(prefix.replace(/\/$/, ""), scope, rules, overrides))
      .sort();
    const rootNotes = root.objects
      .filter(({ key }) => isVisibleNote(key, scope, rules, overrides))
      .map(({ key }) => key)
      .sort();
    const layout = [...folders, ...rootNotes];
    /*
      The other contexts this connection reaches, named at connect time.

      This payload is read once and sits in the system prompt for every
      conversation, which makes it the only surface that reaches a model before
      it has decided anything — and "there is a second context and you can
      address it" is precisely the kind of fact an agent will never go looking
      for. It costs nothing to say: these are names and roles the session
      already carried, and no bucket is opened to list them.
    */
    const others = (store.contexts || []).filter((entry) => !entry.current);
    const reach = others.length
      ? "\n\nThis person can also reach " +
        others.map((entry) => entry.name).join(", ") +
        ". Every tool takes an optional `context` argument naming one of those; " +
        "what you may do there is decided by their role there, not by this connection."
      : "";
    if (!layout.length && !frontPage) return SERVER_INSTRUCTIONS + reach;

    const sketch = [
      "\n\nWHAT IS IN HERE (a snapshot taken when this connection opened; call " +
        "`orient` for the live version, with note counts and recent activity)",
    ];
    if (layout.length) sketch.push(`Top level: ${layout.join(", ")}`);
    if (frontPage) {
      sketch.push(`Their front page, \`index.md\`:\n\n${frontPage}`);
    } else {
      sketch.push(
        "There is no `index.md` yet. It is the front page of this context, and " +
          "writing one with them is a good early contribution."
      );
    }
    return SERVER_INSTRUCTIONS + sketch.join("\n\n") + reach;
  } catch {
    return SERVER_INSTRUCTIONS;
  }
}

/**
 * A store for the deployment's own local bucket, for the two features that have
 * no user behind them: the calendar cron and the Granola webhook.
 *
 * **This is not an access path and no MCP session can reach it.** It exists
 * only for a single-deployment install — someone self-hosting the gateway over
 * their own bucket — where there is no customer credential to fetch and no
 * OAuth token on a cron tick. On the multi-tenant product deployment
 * `LOCAL_CONTEXT_BUCKET` is unset, and both features are inert.
 *
 * Anything a *caller* can reach goes through `storeForSession`, which requires a
 * live grant. Do not call this from a request path that carries a token.
 */
function localIngestionStore(env) {
  const bucket = env?.LOCAL_CONTEXT_BUCKET;
  if (!bucket || typeof bucket.get !== "function") return null;
  return new R2Store(bucket, { rootPrefix: env.LOCAL_CONTEXT_ROOT_PREFIX });
}

async function route(request, env, ctx) {
    const url = new URL(request.url);

    const origin = publicOrigin(request, env);

    // The workspace selector comes off the front first, so every route below
    // sees the same path whether or not the caller named a context. The slug
    // selects; it never authorizes. See splitWorkspacePath.
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
    if (isTransportPath(path)) {
      const refusal = enforceOrigin(request, env);
      if (refusal) return refusal;
    }

    if (request.method === "OPTIONS") return corsResponse();

    const wellKnown = matchWellKnown(path);
    if (wellKnown) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405 });
      }
      if (wellKnown.kind === "authorization-server") {
        return authorizationServerMetadata(origin);
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

    if (path === "/mcp" || path === "/inbox") {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const controlPlane = createControlPlane(env);
      let session;
      try {
        session = await resolveSession(pathToken || bearerToken(request), slug, controlPlane);
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

      const needed = path === "/inbox" ? SCOPE_CAPTURE : SCOPE_READ;
      if (!hasScope(session, needed)) {
        return forbiddenResponse(origin, null, {
          description: `This connection does not hold the ${needed} scope.`,
          // Incremental consent: name the one scope that was missing, so the
          // client can re-authorize for it rather than for everything.
          scope: [needed],
        });
      }

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

      // The deployment's search budget rides the per-request store the way
      // `store.actor` does: the tool layer never sees `env`, and the store dies
      // with the request, so a reused isolate carries nothing across tenants.
      store.searchSubrequestBudget = searchBudgetFor(env);
      // The one way anything in this worker gets to keep working after the
      // response has gone out. Request-scoped like the budget above, and the
      // credential inside `store` never outlives the request either: an
      // extended request is still one request, which is the line "never cache
      // a decrypted credential across requests" draws.
      //
      // Absent on any host that gives no `ctx` — the suite's direct
      // `worker.fetch(request, env)` calls, a self-host shim — and every caller
      // therefore treats deferral as an optimisation it may not get, never as
      // where the work happens.
      store.defer = ctx && typeof ctx.waitUntil === "function" ? (work) => ctx.waitUntil(work) : null;

      // Capture is anchored to the context its grant was approved for, so the
      // inbox store is built without the opener at all rather than with one
      // nothing calls. That makes "a capture-only credential reaches exactly
      // one context" structural instead of a sentence someone has to keep true.
      if (path === "/inbox") return handleInbox(request, env, store, session);

      /**
       * Open one of the *other* contexts this connection covers.
       *
       * A grant covers every context its person is a live member of, so a tool
       * call may name one — and this is the only thing in the worker that acts
       * on that name. It rides on the per-request store for the same reason
       * `store.actor` and the search budget do: the tool layer never sees `env`
       * or the control plane, and everything it hands back dies with the
       * request, so a reused isolate carries no other tenant's credential.
       *
       * Two properties it must keep:
       *
       *  - **A second store, never a second grant.** `sessionForContext` clamps
       *    the grant's scopes and the visibility tier to the caller's role in
       *    the addressed context, and `storeForSession` spends the same
       *    two-factor proof — the same user token, for a context the control
       *    plane independently agrees they are a member of.
       *  - **No chaining.** The store it returns has no `openContext` of its
       *    own, so one tool call resolves one context and cannot walk.
       */
      store.openContext = async (name) => {
        const target = sessionForContext(session, name);
        if (target === session) return { session, store };
        const targetStore = await storeForSession(target, env, controlPlane);
        targetStore.searchSubrequestBudget = searchBudgetFor(env);
        targetStore.defer = store.defer;
        targetStore.actor = actorFor(target);
        targetStore.contexts = contextsFor(target);
        return { session: target, store: targetStore };
      };

      return handleMcp(request, store, session);
    }

    if (path === "/granola-webhook" && request.method === "POST") {
      const store = localIngestionStore(env);
      if (!store) return json({ error: "not_found" }, 404);
      return handleGranolaWebhook(request, env, store, ctx);
    }

    return json({ error: "not_found" }, 404);
}

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
export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
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
};

/* ----------------------------- auth & scoping ----------------------------- */

/**
 * Match the two discovery documents, with or without a resource path suffix.
 *
 * RFC 9728 §3 inserts the well-known segment between the host and the resource
 * path, so a resource at `/@seyi/mcp` publishes metadata at
 * `/.well-known/oauth-protected-resource/@seyi/mcp`. Clients probe the
 * path-suffixed form first and the bare form second, so both are served — and
 * the suffix is read for a slug rather than ignored.
 */
function matchWellKnown(path) {
  const protectedResource = path.match(/^\/\.well-known\/oauth-protected-resource(\/.*)?$/);
  if (protectedResource) {
    // The suffix is the resource *path*, so it ends in "/mcp" — which is itself
    // a valid-looking slug. Trimming that first is what stops
    // `/.well-known/oauth-protected-resource/mcp` — the exact URL this worker's
    // own 401 challenge points at — from being read as a workspace called "mcp"
    // and answering with metadata for a resource nobody asked about.
    const suffix = (protectedResource[1] || "").replace(/\/mcp\/?$/, "");
    const named = suffix.match(/^\/@?([a-z0-9-]{2,32})$/);
    return { kind: "protected-resource", slug: named ? named[1] : null };
  }
  if (/^\/\.well-known\/oauth-authorization-server(\/.*)?$/.test(path)) {
    return { kind: "authorization-server", slug: null };
  }
  return null;
}

function parseLegacyScopeRules(text) {
  const rules = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "rules:") continue;
    const mm = line.match(/^([^:]+?)\/?\s*:\s*(public|team|private)$/);
    if (mm) {
      rules.push({
        prefix: mm[1].trim().replace(/^\/+/, ""),
        // `public` was the old name for authenticated team access.
        vis: mm[2] === "public" ? "team" : mm[2],
      });
    }
  }
  return rules;
}

function parsePrivacyManifest(text) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  const block = text.slice(begin + PRIVACY_RULES_BEGIN.length, end);
  const rules = [];
  const overrides = new PrivacyOverrides();
  let section = null;
  let sawDefault = false;
  for (const raw of block.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line === "```yaml" || line === "```") continue;
    if (line === "default_visibility: private") {
      sawDefault = true;
      continue;
    }
    if (line === "folder_defaults:") {
      section = "folders";
      continue;
    }
    if (line === "note_overrides:") {
      section = "notes";
      continue;
    }
    const match = line.match(/^([^:]+?)\/?\s*:\s*(team|private)$/);
    if (!match || !section) throw new Error(`invalid privacy rule: ${line}`);
    const path = match[1].trim().replace(/^\/+/, "");
    if (!path || path.split("/").some((part) => part.startsWith("."))) {
      throw new Error(`invalid reserved privacy path: ${path}`);
    }
    if (section === "folders") {
      rules.push({ prefix: path, vis: match[2] });
    } else {
      if (!path.endsWith(".md") || foldPath(path) === PRIVACY_KEY) {
        throw new Error(`invalid exact-note privacy path: ${path}`);
      }
      overrides.set(path, match[2]);
    }
  }
  if (!sawDefault) throw new Error("privacy.md must declare default_visibility: private");
  return { rules, overrides };
}

function renderPrivacyRulesBlock(rules, overrides) {
  const folderLines = [...rules]
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((rule) => `  ${rule.prefix}: ${rule.vis}`);
  const noteLines = [...overrides.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, visibility]) => `  ${path}: ${visibility}`);
  return [
    PRIVACY_RULES_BEGIN,
    "",
    "```yaml",
    "default_visibility: private",
    "",
    "folder_defaults:",
    ...(folderLines.length ? folderLines : ["  # No folder defaults. All content is private."]),
    "",
    "note_overrides:",
    ...(noteLines.length ? noteLines : ["  # No exact-note overrides."]),
    "```",
    "",
    PRIVACY_RULES_END,
  ].join("\n");
}

function replacePrivacyRulesBlock(text, rules, overrides) {
  const begin = text.indexOf(PRIVACY_RULES_BEGIN);
  const end = text.indexOf(PRIVACY_RULES_END);
  if (begin < 0 || end < begin) throw new Error("privacy.md is missing its managed rules block");
  return (
    text.slice(0, begin) +
    renderPrivacyRulesBlock(rules, overrides) +
    text.slice(end + PRIVACY_RULES_END.length)
  );
}

async function loadLegacyPrivacyState(store) {
  const scopeObject = await store.get(LEGACY_SCOPES_KEY);
  const rules = scopeObject ? parseLegacyScopeRules(await scopeObject.text()) : [];
  const overrides = new PrivacyOverrides();
  const keys = await listAllKeys(store, NOTE_ACL_PREFIX);
  for (const { key } of keys) {
    const path = key.slice(NOTE_ACL_PREFIX.length).replace(/\.json$/, "");
    if (path && key.endsWith(".json")) overrides.set(path, "private");
  }
  return { rules, overrides, legacy: true, object: scopeObject };
}

async function loadPrivacyState(store) {
  const object = await store.get(PRIVACY_KEY);
  if (!object) return loadLegacyPrivacyState(store);
  try {
    const text = await object.text();
    return { ...parsePrivacyManifest(text), text, object, legacy: false };
  } catch (error) {
    return { rules: [], overrides: new PrivacyOverrides(), text: "", object, legacy: false, error: error.message };
  }
}

async function loadScopeRules(store) {
  return (await loadPrivacyState(store)).rules;
}

/** Longest matching prefix rule wins; no rule → private. Segment-aware. */
function visibilityOf(key, rules) {
  let best = null;
  for (const r of rules) {
    if (key === r.prefix || key.startsWith(r.prefix + "/")) {
      if (!best || r.prefix.length > best.prefix.length) best = r;
    }
  }
  return best ? best.vis : "private";
}

function noteAclKey(path) {
  return `${NOTE_ACL_PREFIX}${path}.json`;
}

async function loadNoteVisibilityOverrides(store) {
  return (await loadPrivacyState(store)).overrides;
}

function effectiveVisibility(key, rules, overrides) {
  return overrideFor(overrides, key) || visibilityOf(key, rules);
}

async function persistExactVisibility(store, path, visibility, rules) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      const inherited = visibilityOf(path, rules);
      if (visibility === "private" && inherited === "team") {
        await store.put(
          noteAclKey(path),
          JSON.stringify({ path, visibility: "private", updated_at: new Date().toISOString() })
        );
      } else {
        await store.delete(noteAclKey(path));
      }
      return;
    }
    const inherited = visibilityOf(path, state.rules);
    if (visibility === inherited) state.overrides.delete(path);
    else state.overrides.set(path, visibility);
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

async function clearExactVisibility(store, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const state = await loadPrivacyState(store);
    if (state.error) throw new Error(`privacy manifest invalid: ${state.error}`);
    if (state.legacy) {
      await store.delete(noteAclKey(path));
      return;
    }
    // Exact on purpose, and asked through `delete`'s own answer so the two
    // cannot drift apart: a fold reads across case, it never writes across it.
    // Clearing `a/Foo.md` must not remove the override on `a/foo.md`.
    if (!state.overrides.delete(path)) return;
    const next = replacePrivacyRulesBlock(state.text, state.rules, state.overrides);
    const put = await store.put(PRIVACY_KEY, next, { onlyIf: { etagMatches: state.object.etag } });
    if (put) return;
  }
  throw new Error("privacy manifest changed concurrently; retry the operation");
}

/**
 * One object, one privacy answer — even where two strings name one object.
 *
 * Every decision in this engine is keyed on an exact path: `isPlumbing` opens
 * with `key === PRIVACY_KEY`, and `effectiveVisibility` is an exact `Map.get`
 * against the exact-note overrides. That is sound on a keyspace where one
 * string is one object, which is what R2 and S3 are — and `DropboxStore` is
 * not. Its own header lists the difference: Dropbox "treats `Foo.md` and
 * `foo.md` as the same file and normalises Unicode", and it deliberately does
 * not re-case a caller's key, because a store that silently rewrote one would
 * be worse than one that returns what Dropbox actually has.
 *
 * That is the right call for the adapter and it leaves the question here. Every
 * note path in this gateway arrives from a connected AI client, so on a
 * Dropbox-backed context an attacker picks which of two strings to send and
 * therefore which of two answers to be scored by: `Privacy.md` is not
 * `privacy.md`, so nothing reserved it, and Dropbox wrote the manifest anyway.
 *
 * So the fold happens where the decision is made rather than where the bytes
 * are stored, and on **every** backend: a privacy answer that depends on which
 * adapter is underneath is an answer nobody can check. What makes that safe
 * everywhere is that the fold only ever NARROWS — a `private` override travels
 * to every path folding onto it, a `team` one travels nowhere. Folding a
 * widening was the first version of this and was a new hole on the majority
 * backend, where `a/Foo.md` really is a different file from the `a/foo.md` its
 * owner published. A fold reads across case; it never writes across one.
 *
 * `visibilityOf`'s folder rules are deliberately NOT folded. Re-casing a folder
 * makes every prefix miss and the default `private` takes over, which already
 * fails closed; folding them would make a `team` rule match folders its author
 * did not name, which fails open. The two halves differ in direction, not in rigour.
 */
function foldPath(key) {
  return key.normalize("NFC").toLowerCase();
}

/** Dot-prefixed segments (.history, .obsidian, …) are plumbing, never notes. */
function isPlumbing(key) {
  const folded = foldPath(key);
  return (
    folded === PRIVACY_KEY ||
    folded === LEGACY_SCOPES_KEY ||
    key.split("/").some((s) => s.startsWith("."))
  );
}

/**
 * The overrides map, with the folded lookup precomputed.
 *
 * `overrideFor` has to answer "is there a private override folding onto this
 * key", and the honest way to do that with a plain `Map` is to scan it. That is
 * per-note work on the search hot path: measured over 8,000 documents with 200
 * private overrides, `canSee` went from 6.1ms to 214.1ms — which hands back a
 * large slice of the 1,439ms → 670ms this project banked in "A search is paced".
 *
 * So the folded set is built once and thrown away on any write. Rebuilt on
 * read rather than maintained incrementally, because an index kept in step by
 * arithmetic is an index that can drift, and the direction it would drift is a
 * narrowing that stops being found.
 *
 * It is an accelerator and never the authority: `overrideFor` falls back to the
 * scan for a plain `Map`, so the ANSWER never depends on which container a
 * caller happens to hold — the differential test passes plain maps, and the
 * control plane's `new Map(overrides)` copies are plain by construction. A
 * container that changed the answer is the bug that shipped in this PR's first
 * version.
 */
class PrivacyOverrides extends Map {
  set(key, value) {
    this.folds = null;
    return super.set(key, value);
  }

  delete(key) {
    this.folds = null;
    return super.delete(key);
  }

  // No caller today, and that is exactly why it is here: it is the one
  // remaining mutation that would leave the index standing over an empty map.
  clear() {
    this.folds = null;
    return super.clear();
  }

  /** The folded paths of every `private` override. */
  privateFolds() {
    if (!this.folds) {
      // Built whole, then published — never filled in place. A throw partway
      // through would otherwise cache a SHORT index, and a short index answers
      // "no private fold" where there is one, which is the one direction this
      // must never fail in. `foldPath` cannot throw on a string today; the
      // control plane's copy is written the same way, and two copies of one
      // rule are held here by being identical rather than by a comment.
      const folds = new Set();
      for (const [key, visibility] of this) {
        if (visibility === "private") folds.add(foldPath(key));
      }
      this.folds = folds;
    }
    return this.folds;
  }
}

/**
 * The exact-note overrides, looked up so the fold cannot be left out.
 *
 * A `Map` subclass that folded inside `get`/`has` was the first shape of this
 * and was wrong: it folds only for maps this module built, so a caller holding
 * a plain `Map` — `__tests__/privacyEngine.test.ts` passes one, and the control
 * plane's `nextOverrides` copies with `new Map(overrides)` — silently got the
 * unfolded answer, and the two engines then disagreed about a live note. Which
 * is the one failure that whole test file exists to prevent.
 *
 * So the fold lives in this helper, over any map, and `PrivacyOverrides` below
 * only makes it fast. The container may change the speed; it may never change
 * the answer.
 */
function overrideFor(overrides, key) {
  if (!overrides) return undefined;
  const exact = overrides.get(key);
  if (exact === "private") return "private";
  // Only a NARROWING travels by fold. A `team` override reaching a note the
  // owner did not name is the same failure that keeps folder rules unfolded,
  // and on a case-sensitive store — R2, S3, every context deployed today —
  // `a/Foo.md` really is a different file from the `a/foo.md` that was
  // published. Two entries that fold together are one file on Dropbox and a
  // contradiction the owner never resolved; `private` is the answer that
  // cannot leak. `foldPath` runs only over private entries for the same
  // reason it runs at all.
  const folded = foldPath(key);
  if (typeof overrides.privateFolds === "function") {
    return overrides.privateFolds().has(folded) ? "private" : exact;
  }
  for (const [existing, visibility] of overrides) {
    if (visibility === "private" && foldPath(existing) === folded) return "private";
  }
  return exact;
}

/**
 * Whether any override names this note, under any casing.
 *
 * Deliberately wider than `overrideFor`: it folds a `team` override too. Every
 * caller either REFUSES when an override exists, or — at `fastArchiveCandidate`
 * — takes a slower path that re-reads through `overrideFor`, so a folded twin
 * of either visibility only ever refuses more or works harder. It is not a
 * visibility answer and must not be used as one; that is what would put the
 * widening back.
 */
function hasOverride(overrides, key) {
  if (!overrides) return false;
  if (overrides.has(key)) return true;
  const folded = foldPath(key);
  for (const existing of overrides.keys()) {
    if (foldPath(existing) === folded) return true;
  }
  return false;
}

/**
 * The opaque image store.
 *
 * `.images/` is dot-prefixed, so `isPlumbing` already hides it from every
 * listing, every search and every note tool, at every scope. That is the whole
 * point of the location and it must not be relaxed: making `.images/`
 * non-plumbing would put every stored image into listings and defeat the
 * design. `read_image` is the one deliberate way back in, and it is narrow by
 * construction — see `toolReadImage`.
 */
const IMAGE_PREFIX = ".images/";

/**
 * The types an image may be returned as, and the only extensions `read_image`
 * will resolve at all.
 *
 * SVG is absent on purpose. An SVG is a script container, and what this tool
 * returns is rendered by whatever client asked for it; a stored `.svg` is
 * unreachable rather than special-cased, which is the safe direction. The
 * customer's own bucket may still hold one — we simply will not hand it out.
 */
const IMAGE_MIME_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

/**
 * A ceiling on what one call will inline. Base64 inflates by 4/3 and a Worker
 * response is not unbounded, so this is a real limit rather than a policy one.
 * Reaching it requires already having proved visibility, so unlike every other
 * refusal in `toolReadImage` it may say what happened.
 */
const MAX_INLINE_IMAGE_BYTES = 5_000_000;

/**
 * Turn whatever the caller passed as `image` into the one key it may mean.
 *
 * Accepts `.images/<leaf>` or the bare `<leaf>`, and nothing else. This is the
 * function that stops `read_image` from being a general object reader: this one
 * reads raw bytes by key, so if `image` could name an arbitrary object then a
 * note reading "privacy.md" would exfiltrate the manifest and "../" would walk
 * out of the store. (An earlier version of this sentence said "every other read
 * path in this gateway is gated on `.md` plus `canSee`". `toolReadNote` is not:
 * it is `normalizePath` + `canSee`, with no `.md` gate. The listing, search and
 * `fetch` paths do gate on both.) The leaf is a single path segment with an image extension —
 * no slashes, no dots leading anywhere, nothing outside `.images/`.
 *
 * Returns null for anything else; the caller turns null into the same "not
 * found" as every other failure.
 */
function imageRefFor(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  // A backstop, and honestly labelled as one: with the character class below in
  // place this line can never be the thing that refuses anything, because "/"
  // and "\\" are already outside it and a leading "." already fails it. It
  // earns its keep only if that class is ever loosened — and loosening it is
  // itself caught, by the nested-key check in the suite. Sabotaging this line
  // alone turns nothing red; that is the expected result, not a missing test.
  if (!raw || raw.length > 512 || raw.includes("..") || raw.includes("\\")) return null;
  const leaf = raw.startsWith(IMAGE_PREFIX) ? raw.slice(IMAGE_PREFIX.length) : raw;
  // One segment, and the load-bearing line here. The character class excludes
  // "/" so nothing nested and nothing outside `.images/` can be named, and it
  // requires an alphanumeric first character so the leaf cannot itself be
  // plumbing. This is what stops `read_image` being a general object reader.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(leaf)) return null;
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return null;
  const mimeType = IMAGE_MIME_TYPES.get(leaf.slice(dot + 1).toLowerCase());
  if (!mimeType) return null;
  return { key: IMAGE_PREFIX + leaf, leaf, mimeType };
}

/**
 * Does this note reference this image?
 *
 * Deliberately broad: any mention of the leaf anywhere in the note. A stricter
 * definition — "must be a markdown image link" — is tempting and wrong here,
 * because these notes are edited in Obsidian, in rclone, in a text editor, by
 * people who will reformat a link without knowing it is load-bearing. The
 * failure mode of strict is an image that silently stops loading; the failure
 * mode of broad is that somebody who can already write a note can name a hash
 * they already know.
 *
 * That second one is worth stating plainly rather than pretending away: in a
 * content-addressed store the hash *is* the capability. Learning it requires
 * either seeing a note that references it or already holding the exact bytes.
 * Neither is a disclosure this tool creates, and the store is never listable,
 * so there is nowhere to learn a hash you were not already entitled to.
 */
function noteReferencesImage(noteText, image) {
  return noteText.includes(image.leaf);
}

/** Base64 without a dependency, chunked so a large image cannot blow the stack. */
function base64FromBytes(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function canSee(key, scope, rules, overrides) {
  if (foldPath(key) === PRIVACY_KEY) return scope === "private";
  if (isPlumbing(key)) return false; // plumbing is not part of the note surface for any tool
  if (scope === "private") return true;
  return effectiveVisibility(key, rules, overrides) === "team";
}

function teamWritableRules(rules) {
  return rules.filter((rule) => rule.vis === "team").sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function visiblePrivateOverrides(rules) {
  const teamRules = teamWritableRules(rules);
  return rules
    .filter(
      (rule) =>
        rule.vis === "private" &&
        teamRules.some(
          (teamRule) =>
            rule.prefix === teamRule.prefix || rule.prefix.startsWith(`${teamRule.prefix}/`)
        )
    )
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/* --------------------------------- MCP ---------------------------------- */

/**
 * Who a write in this context is recorded as.
 *
 * One function rather than two literals, because a cross-context call builds a
 * second store and the audit line on it must name the context it was written
 * in. Two copies of this object is how a note filed into somebody's brain ends
 * up stamped with the workspace the client happened to connect to.
 */
function actorFor(session) {
  return {
    workspaceId: session.workspaceId,
    userId: session.actorUserId,
    clientId: session.actorClientId,
    grantId: session.grantId,
  };
}

/**
 * The contexts this connection can address, as `orient` needs to name them.
 *
 * Request-scoped metadata on the store, like `store.actor`, because the tool
 * layer takes a store and a scope and nothing else — and a reach an agent is
 * never told about is a reach nobody uses.
 *
 * A covered context with no slug is dropped rather than listed: the name is how
 * a tool call addresses one, so an entry nothing can be passed as would be an
 * offer that refuses.
 */
function contextsFor(session) {
  return (session.workspaces || [])
    .filter((entry) => typeof entry.slug === "string" && entry.slug !== "")
    .map((entry) => ({
      name: `@${entry.slug}`,
      role: entry.role,
      current: entry.workspaceId === session.workspaceId,
    }));
}

async function handleMcp(request, store, session) {
  /**
   * The acting identity, carried on the per-request store instance so that
   * `recordChange` can put it in the audit record without every tool signature
   * growing a parameter.
   *
   * This is request-scoped metadata on an adapter this request built for
   * itself, not part of the ContextStore contract — `storeForSession` returns a
   * fresh store per request, so there is nothing here for a reused isolate to
   * carry into the next tenant's call.
   *
   * `actor_scope: "team"` stops meaning anything the moment "team" is four
   * people, so the record names the human and the client too.
   */
  store.actor = actorFor(session);
  store.contexts = contextsFor(session);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }

  // Era routing. A modern request declares its revision on itself; a legacy one
  // relies on a handshake that already happened. Serving the wrong shape is
  // worse than refusing, so this decision is made once, from the request, and
  // the two paths below never fall through into each other.
  if (isModernRequest(request, Array.isArray(body) ? body[0] : body)) {
    return handleModernMcp(request, body, store, session);
  }

  if (!legacyProtocolHeaderIsAcceptable(request.headers.get("MCP-Protocol-Version"))) {
    return jsonRpcError(
      null,
      -32000,
      "unsupported MCP-Protocol-Version header",
      400
    );
  }

  // JSON-RPC batching was removed in 2025-06-18 and never existed in the modern
  // era. It survives here only for `2024-11-05` and `2025-03-26`, which are
  // still in `LEGACY_PROTOCOLS` and did define it.
  if (Array.isArray(body)) {
    const results = [];
    for (const msg of body) {
      const r = await handleRpc(msg, store, session);
      if (r) results.push(r);
    }
    return results.length ? json(results) : new Response(null, { status: 202 });
  }
  const result = await handleRpc(body, store, session);
  return result ? json(result) : new Response(null, { status: 202 });
}

/* ------------------------------ modern MCP -------------------------------- */

/**
 * Serve one request under `2026-07-28` semantics.
 *
 * The modern era is stateless by construction, which is why this gateway can
 * speak it at all: there was never a session to remove. What it does add is a
 * stricter envelope — the version is declared per request and mirrored into
 * headers, every result is tagged, and the transport carries real HTTP status
 * codes instead of answering `200` with an error inside.
 *
 * Everything that decides *what a caller may see or do* is delegated to the
 * same helpers the legacy path uses. That is deliberate and load-bearing: a
 * scope check written twice is a scope check that will eventually differ, and
 * the difference would be a privilege escalation reachable by adding one header
 * to a request.
 */
async function handleModernMcp(request, msg, store, session) {
  if (Array.isArray(msg)) {
    // "The body of the HTTP POST MUST be a single JSON-RPC request or
    // notification." Batching does not exist in this era.
    return modernErrorResponse(null, ERROR_HEADER_MISMATCH, "batched requests are not supported", 400);
  }

  const id = msg?.id;
  // A notification gets `202` and nothing else. This revision defines no
  // client-to-server notification over HTTP and explicitly leaves header
  // requirements for a notification POST unspecified, so none are imposed.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  const mismatch = modernHeaderMismatch(request, msg);
  if (mismatch) return modernErrorResponse(id, ERROR_HEADER_MISMATCH, mismatch, 400);

  const requested = declaredProtocolVersion(msg);
  if (!MODERN_PROTOCOLS.includes(requested)) {
    // The modern counterpart of the legacy counter-offer: an error carrying the
    // versions the client could retry with. See `MODERN_ONLY_VERSION_LISTS` in
    // `protocol.js` for why a legacy revision must never appear here.
    //
    // The body is not optional. A `400` whose body is *not* a recognized modern
    // error is how a dual-era client concludes the server is legacy and falls
    // back to `initialize` — so a bare `400` here does not merely lose detail,
    // it routes the client into the era it just declined to use.
    return modernErrorResponse(
      id,
      ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      "Unsupported protocol version",
      400,
      { supported: MODERN_PROTOCOLS, requested: requested ?? null }
    );
  }

  const params = msg.params || {};
  try {
    switch (msg.method) {
      case "server/discover":
        // MUST be implemented. It is how a modern client learns what this
        // server is without probing every list endpoint in turn. Modern-only
        // `supportedVersions` — see `MODERN_ONLY_VERSION_LISTS`.
        // The instructions carry a sketch of *this* caller's context, which is
        // safe to cache only because `CACHEABLE` is `cacheScope: "private"` —
        // the same property that stops a shared intermediary handing one grant's
        // tool list to another. If that ever becomes `public`, this line is the
        // second thing it breaks.
        return modernResultResponse(id, {
          supportedVersions: MODERN_PROTOCOLS,
          capabilities: { tools: {} },
          instructions: await instructionsForSession(store, session),
          ...CACHEABLE,
        });
      case "tools/list":
        return modernResultResponse(id, {
          tools: toolsForSession(session),
          ...CACHEABLE,
        });
      case "tools/call":
        return modernResultResponse(id, await callToolForSession(params, store, session));
      default:
        // On this transport an unknown method is `404`, not `200` with an error
        // body. The status is what lets a dual-era client tell "this server
        // does not have that method" from "this server is not modern at all".
        return modernErrorResponse(
          id,
          ERROR_METHOD_NOT_FOUND,
          `method not found: ${msg.method}`,
          404
        );
    }
  } catch (err) {
    return modernErrorResponse(id, -32603, `internal error: ${err.message}`, 200);
  }
}

/**
 * Freshness hints required on every cacheable result in this revision.
 *
 * `cacheScope` is `private` and not negotiable: `tools/list` is filtered by the
 * calling grant's scopes, so a shared intermediary that cached one caller's
 * answer and served it to another would hand a read-only client the write
 * tools. `public` would be a cross-grant leak dressed as a performance hint.
 *
 * One minute of `ttlMs` bounds how long a downgraded grant can keep seeing the
 * wider tool list. A revoked grant is not a concern here — it fails
 * authentication long before any cached list is consulted.
 */
const CACHEABLE = { ttlMs: 60_000, cacheScope: "private" };

/** The server's own identity, reported in `_meta` on every modern result. */
const SERVER_INFO = {
  name: "context",
  version: "1.0.0",
  description: "A scoped MCP server over a customer-owned bucket of markdown notes.",
};

function modernResultResponse(id, result, status = 200) {
  return json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        // Required on every result. `input_required` is the other value, for
        // the multi-round-trip pattern; this server never needs input from a
        // client, so every result it produces is complete.
        resultType: "complete",
        ...result,
        _meta: { ...(result?._meta || {}), [META_SERVER_INFO]: SERVER_INFO },
      },
    },
    status
  );
}

function modernErrorResponse(id, code, message, status, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return json({ jsonrpc: "2.0", id: id ?? null, error }, status);
}

/**
 * The tools this connection may see.
 *
 * A read-only grant is not shown tools it cannot use. Advertising them and then
 * refusing every call makes a connected client look broken; it also invites an
 * agent to spend a turn discovering it.
 *
 * Shared by both protocol eras on purpose. The filtering here and the
 * enforcement in `callToolForSession` are the only two places authority is
 * decided, so adding a protocol revision can never quietly add a second, laxer
 * copy of either.
 */
function toolsForSession(session) {
  const offered = writesAnywhere(session)
    ? toolDefinitions()
    : toolDefinitions().filter((tool) => tool.annotations?.readOnlyHint === true);
  // `readOnlyHint` is not the whole of the question. `list_plugins` reads a
  // prefix the privacy manifest does not reach, so it is the context owner's
  // however harmless the read is — offered to a connection that owns one of the
  // contexts it covers, and refused per call in the ones it does not.
  return readsPrivateAnywhere(session)
    ? offered
    : offered.filter((tool) => tool.name !== "list_plugins");
}


/** Run one tool call for this session, enforcing scope. Shared by both eras. */
async function callToolForSession(params, store, session) {
  const supplied = params?.arguments;
  const args =
    supplied && typeof supplied === "object" && !Array.isArray(supplied) ? { ...supplied } : {};

  /**
   * The addressed context, if the call named one.
   *
   * **Everything below this point runs against the addressed context, and
   * nothing above it decided anything.** That is why the routing is here: this
   * function and `toolsForSession` are the only two places authority is
   * decided, and a call into somebody else's brain has to be clamped by *their*
   * membership rather than by the one the client happens to be connected to.
   * Resolving a context anywhere else — in a tool, in a path parser — is a
   * second authority decision, and the second one is the one that drifts.
   *
   * `context` is dropped from the arguments before the tool sees them: it
   * addresses the call, it is not an input to any tool, and a tool that ever
   * grew an argument of that name would otherwise be handed a routing token.
   */
  const requested = args.context;
  delete args.context;

  let target = session;
  let targetStore = store;
  /*
    Present but unusable is a refusal, never a fall-through to the default.
    A `context` of `123`, of `""`, or of an object is a client that meant to
    address somewhere else and failed to say where — and quietly serving the
    context it did not ask for is how a note gets written into the wrong brain.
    Absent is the only thing that means "here".
  */
  if (requested !== undefined && requested !== null && !isUsableContextName(requested)) {
    return toolError("this connection has no access to that context");
  }
  if (isUsableContextName(requested)) {
    // A deployment that never installed the opener — a self-host shim, a test
    // harness — refuses rather than silently serving the default context. The
    // failure a person can act on is "that did not happen"; the one they cannot
    // is a note filed in the wrong brain.
    if (typeof store.openContext !== "function") {
      return toolError("this connection cannot address another context");
    }
    try {
      ({ session: target, store: targetStore } = await store.openContext(requested));
    } catch (error) {
      // One answer for a name that is not covered, a name that is not a name,
      // and a name nobody has ever registered — the refusal `selectWorkspace`
      // gives the URL form, for the reason it gives: a distinguishable answer
      // is an existence oracle over a global namespace.
      if (error instanceof SessionRefusal) {
        return toolError("this connection has no access to that context");
      }
      // Reachable, and its bucket is not. Said plainly, because it is the one
      // failure here the person can fix — and said WITHOUT the reason, because
      // `StorageUnavailable`'s own doc comment reserves that for this gateway's
      // structured logs: "It never reaches a caller: `index.js` answers every
      // one of these with the same 503." Interpolating `error.message` here
      // made that false, and the reasons it published are plumbing state
      // (`workspace mismatch` — the two-party disagreement signal — plus
      // `no proof of authorization`, `refresh token in binding`,
      // `cross-provider credential`, `binding not allowed`, `unknown
      // provider`), pollable by any member of any covered context.
      if (error instanceof StorageUnavailable) {
        // Named, and the action attributed to whoever can take it. This branch
        // is reached only on the cross-context hop, so it is by definition
        // about another context — often one the caller is a `member` of and
        // cannot reconnect. The identically-worded 503 is about the caller's
        // own context, where "reconnect it" is advice they can act on.
        return toolError(
          `${target?.name || "that context"} has no reachable storage right now; ` +
            "its owner can reconnect it from their dashboard.",
        );
      }
      throw error;
    }
  }

  // Enforced here as well as filtered in `toolsForSession`: the listing is a
  // courtesy, this is the control. A client that remembers a tool name from a
  // wider grant, or simply guesses one, gets refused.
  //
  // Read off `target`, never `session`: the grant's write scope survives only
  // where the caller's role in *that* context can back it up, so a `member` in
  // somebody's brain is refused here even holding a full-access grant.
  if (toolIsWriting(params?.name) && !hasScope(target, SCOPE_WRITE)) {
    /*
      Two refusals, because there are two causes and the fix differs. A grant
      that was never given write is a reconnection; a role that cannot back one
      up is not — telling somebody to reconnect for write they can never hold
      in that context sends them round a loop that cannot end. The second case
      only became reachable when one connection started covering several
      contexts, and it names the context because that is now the part in doubt.
    */
    return toolError(
      writesAnywhere(session)
        ? `permission denied: you have read-only access to @${target.workspaceSlug}.`
        : "permission denied: this connection holds a read-only grant. " +
            "Reconnect the client with write access from the Context dashboard."
    );
  }
  return callTool(params?.name, args, targetStore, target.scope);
}

/** Something that could name a context: a non-empty string, and nothing else. */
function isUsableContextName(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Tools that change something, derived from the definitions so it cannot drift. */
function toolIsWriting(name) {
  const tool = toolDefinitions().find((entry) => entry.name === name);
  // An unknown tool is treated as writing. `callTool` rejects it anyway, and a
  // gate that fails open on a name it does not recognize is a gate that a typo
  // in a future tool definition quietly disables.
  return !tool || tool.annotations?.readOnlyHint !== true;
}

async function handleRpc(msg, store, session) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const scope = session.scope;

  try {
    switch (method) {
      case "initialize": {
        // MCP lifecycle: if the requested revision is one we speak, echo it.
        // Otherwise counter-offer — in a normal result, never a JSON-RPC error
        // — with the newest revision we do speak, and let the client decide
        // whether it can live with that.
        //
        // Two ways to get this wrong, both seen in the wild:
        //
        //  - Answering with an error. A server that replied `-32602 unsupported
        //    protocol version` to a client asking for a newer revision simply
        //    failed to connect, where a counter-offer would have worked. The
        //    counter-offer is a MUST for exactly this reason.
        //  - Counter-offering something other than the newest. This used to
        //    return a hardcoded "2025-03-26", so a client asking for a revision
        //    from the future was talked down further than necessary and lost
        //    capability for nothing.
        //
        // Derived from the array, which is ordered newest first, so the two
        // cannot drift apart. Only *legacy* revisions are offerable here: a
        // client that sent `initialize` has declared it speaks the handshake
        // era, and answering it with `2026-07-28` — which deleted `initialize`
        // — would name a revision it cannot possibly use.
        const requested = params?.protocolVersion;
        const protocolVersion = LEGACY_PROTOCOLS.includes(requested)
          ? requested
          : LEGACY_PROTOCOLS[0];
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: await instructionsForSession(store, session),
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null; // notifications get no response
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: toolsForSession(session) });
      case "tools/call": {
        if (isNotification) return null;
        return rpcResult(id, await callToolForSession(params, store, session));
      }
      default:
        return isNotification ? null : jsonRpcErrorObj(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (isNotification) return null;
    return jsonRpcErrorObj(id, -32603, `internal error: ${err.message}`);
  }
}

/**
 * The `context` argument, declared once and added to every tool.
 *
 * Added centrally rather than written into each schema, because the failure to
 * design against is a tool added next year that quietly cannot be addressed:
 * `additionalProperties: false` means a client's `context` on that one tool is
 * rejected by its own schema, and the agent has no way to tell that from "you
 * may not reach that context".
 */
const CONTEXT_ARGUMENT = {
  type: "string",
  description:
    'Optional. Another context to act in, as "@name" — a brain someone shared with you, or a ' +
    "workspace you belong to. Omit it to act in your own. Call orient with the same argument " +
    "first: every folder map, search and listing is per context.",
};

/**
 * The two tools whose schema is somebody else's contract.
 *
 * `search` and `fetch` exist in OpenAI's deep-research shape so ordinary
 * ChatGPT chats can call something at all; those chats pass what that contract
 * defines and nothing else, so an extra property buys them nothing and risks
 * being read as a violation of it. Cross-context reach is available to them
 * through the ordinary tools when a client can see the ordinary tools.
 */
const FOREIGN_CONTRACT_TOOLS = new Set(["search", "fetch"]);

/** Every tool, with the addressing argument folded in. */
function toolDefinitions() {
  return baseToolDefinitions().map((tool) => {
    if (FOREIGN_CONTRACT_TOOLS.has(tool.name)) return tool;
    const schema = tool.inputSchema || { type: "object" };
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: { ...(schema.properties || {}), context: CONTEXT_ARGUMENT },
      },
    };
  });
}

function baseToolDefinitions() {
  return [
    {
      name: "orient",
      description:
        "CALL THIS FIRST, once per session, before answering anything about the user's own work. " +
        "One cheap call returns their front page, what they touched most recently, and a map of " +
        "every folder with note counts — so you know what already exists instead of guessing. " +
        "Everything else here is easier to use well afterwards.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    // ChatGPT's ordinary chats can invoke exactly two tools on a custom
    // connector: ones named `search` and `fetch`, in OpenAI's deep-research
    // shape. These are `search_notes` and `read_note` wearing that contract —
    // see the doc block on `toolOpenAiSearch`. Their descriptions are written
    // for the model deciding whether to reach for this connector at all.
    {
      name: "search",
      description:
        "Search the user's own memory: their notes about their projects, people, decisions, " +
        "preferences and past work. The first place to look for any question about the user — " +
        "the answer is usually already written down here. Returns results whose id can be " +
        "passed to fetch for the full note.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "fetch",
      description:
        "Fetch one note from the user's memory in full, by the id a search result returned.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "A result id from search" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "scope_info",
      description:
        "Show team-writable folder defaults and the access model. Optionally inspect a proposed path. Personal connections receive its effective visibility; team connections receive only the folder default so private note existence is never disclosed.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Optional note or destination path to inspect" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_notes",
      description:
        "List note paths under a folder prefix (e.g. '1-projects'), or everywhere when omitted. " +
        "Use it to open up an area that orient only summarized — a project folder's contents, " +
        "what is sitting unfiled in 0-inbox — before deciding something has not been written down.",
      inputSchema: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Folder prefix to list under; omit for everything." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_note",
      description:
        "Read one of the user's notes in full — the paths come from orient, list_notes, or " +
        "search_notes. Returns its content and an etag; pass that etag back to write_note so a " +
        "concurrent edit is detected instead of silently overwritten.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string", description: "e.g. '1-projects/togather/status.md'" } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_image",
      description:
        "Fetch one image that a note references. Images live in an opaque store that is never listed or searched, so an image is reachable only through a note you can already read: pass that note's path and the image reference as it appears in it. Returns the image inline.",
      inputSchema: {
        type: "object",
        properties: {
          note: {
            type: "string",
            description: "Path of a note you can read that references the image, e.g. '0-inbox/email/capture.md'",
          },
          image: {
            type: "string",
            description: "The image as the note names it, e.g. '.images/<hash>.png' (the bare filename also works)",
          },
        },
        required: ["note", "image"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "write_note",
      description:
        "Create or update a markdown note — this is how what you learned in this session survives " +
        "it. Use it when a decision is made, a constraint is discovered, a preference is stated, " +
        "or a fact emerges that the user should never have to repeat to the next agent; prefer " +
        "improving the note that already covers the topic over adding a near-duplicate. " +
        "Folder rules are defaults; visibility is enforced by the private privacy.md manifest, never by frontmatter. New personal writes default private; new team writes default team; updates preserve existing visibility. A personal connection may explicitly publish one note as team even inside a private-default folder by passing visibility=team and confirm_team_publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Destination path ending in .md" },
          content: { type: "string" },
          expected_etag: { type: "string", description: "Etag from read_note; omit only when creating a new note." },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description: "Optional enforced visibility; frontmatter alone does not control access",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when personal access deliberately publishes a new or private note to team",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_visibility",
      description:
        "Personal connection only. Set enforced visibility for one existing note without moving it. Private notes may coexist beside team notes in either folder default. Publishing private to team requires confirm_team_publish=true.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          visibility: { type: "string", enum: ["private", "team"] },
          expected_etag: { type: "string", description: "Optional current note etag" },
          confirm_team_publish: { type: "boolean" },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "set_folder_visibility",
      description:
        "Personal connection only. Dry-run or atomically set a folder's inherited visibility in privacy.md without a source checkout or rclone. Use visibility=inherit to remove that folder's direct rule. Applying requires the privacy etag returned by dry-run; any private-to-team publication also requires confirm_team_publish=true. Redundant exact-note overrides are compacted.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder path without a trailing slash" },
          visibility: { type: "string", enum: ["private", "team", "inherit"] },
          dry_run: { type: "boolean", description: "Return the impact and current privacy etag without changing anything" },
          expected_privacy_etag: {
            type: "string",
            description: "Required when applying; use the privacy etag returned by dry-run",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required if the change makes existing or future notes under the folder team-visible",
          },
        },
        required: ["path", "visibility"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_plugins",
      description:
        "Check the Obsidian plugins already in this context's bucket and report, for each one, "
        + "whether Context can run it, whether it needs the owner to approve a host it calls, "
        + "whether it stays in Obsidian while Context reads the files it writes, or whether it "
        + "cannot run here — with the specific call that decides it. Reads .obsidian/plugins/ and "
        + "writes nothing; the Obsidian setup is left exactly as it is.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "propose_note",
      description:
        "Queue a new markdown note for a correct destination that this connection cannot currently write. The proposal is hidden from team listings and must be approved by a personal connection; it never overwrites an existing note.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Intended destination ending in .md" },
          content: { type: "string" },
          reason: { type: "string", description: "Why this is the correct durable destination" },
          agent: { type: "string", description: "Submitting agent name, e.g. Claude Code" },
        },
        required: ["path", "content", "reason"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_proposals",
      description:
        "Private connection only. List pending note proposals with destination, submitter, reason, timestamp, and size; content is omitted.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "read_proposal",
      description: "Private connection only. Read one pending note proposal by proposal id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "review_proposal",
      description:
        "Private connection only. Approve or reject a pending note proposal. Approval creates a new note only when the destination does not exist; destination may be corrected during review. Rejected and approved proposal records remain in hidden reviewed history.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ["approve", "reject"] },
          destination: {
            type: "string",
            description: "Optional corrected destination for approval; must end in .md",
          },
          review_note: { type: "string", description: "Optional private review rationale" },
        },
        required: ["id", "action"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "search_notes",
      description:
        "Search the user's own notes. Reach for this whenever they mention a project, a person, a " +
        "client, a decision, a preference, or something they have written before — it is usually " +
        "already recorded here, and asking them to repeat it is the failure mode. Case-insensitive " +
        "and ranked, so the best matches come first; returns matching paths with line snippets. " +
        "Pass a folder prefix when you already know where to look, and reuse the result for the " +
        "session rather than repeating the same search before every write.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          prefix: {
            type: "string",
            description: "Optional folder prefix that narrows results to one subtree",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "archive_note",
      description:
        "Retract a note from its canonical location into this context's own 4-archive, date-stamped and recoverable — there is no delete, and this is the safe way to pull something out of circulation. Only on contexts whose layout has a 4-archive; elsewhere it refuses and move_note follows the owner's conventions instead. Team archives remain team-visible; personal archives safely tighten to private. Pass expected_etag for team cleanup.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expected_etag: { type: "string", description: "Required for team connections" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_note",
      description:
        "Move or rename one note without recreating it. Private overrides are preserved and privacy is never implicitly reduced. A team note moved by personal access into a private-default folder safely becomes private.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing markdown note path" },
          destination: { type: "string", description: "New markdown note path" },
          expected_source_etag: {
            type: "string",
            description: "Optional etag from read_note for conflict-safe moves",
          },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_notes",
      description:
        "Preflight or apply an all-or-rollback batch of up to 100 independent note moves. Set dry_run=true to validate every source, etag, destination, conflict, and scope without changing data. Cycles and destination/source overlap are rejected.",
      inputSchema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                destination: { type: "string" },
                expected_source_etag: { type: "string" },
              },
              required: ["source", "destination"],
              additionalProperties: false,
            },
          },
          dry_run: { type: "boolean", description: "When true, return the validated plan only" },
        },
        required: ["moves"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "move_folder",
      description:
        "Move or rename a folder tree after preflighting every destination. Maximum 500 objects. Private overrides are preserved and privacy is never implicitly reduced.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Existing folder prefix" },
          destination: { type: "string", description: "New folder prefix" },
          dry_run: { type: "boolean", description: "When true, validate and return the move plan only" },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "save_context",
      description:
        "Save what mattered from this session back into the user's context, before it ends. " +
        "Call it when the work is done or the conversation is wrapping up — the decisions, the " +
        "transcript, or both, whatever their own procedure asks for. That procedure and the " +
        "destination are theirs: orient reports them from their index.md, and this tool tells you " +
        "what it assumed when they have not said. Personal connections save privately; team " +
        "connections save at team visibility. Exclude hidden prompts, reasoning, credentials, and " +
        "raw tool logs.",
      inputSchema: {
        type: "object",
        properties: {
          platform: {
            type: "string",
            description:
              "Short lower-case name of the client saving this, e.g. chatgpt, claude, codex, cursor",
          },
          content: {
            type: "string",
            description:
              "Markdown: the decisions, the user-visible transcript, or whatever this session's procedure asks to keep. Never hidden prompts, reasoning, credentials, or raw tool logs.",
          },
          history: {
            type: "string",
            description: "Deprecated alias for content.",
          },
          completeness: {
            type: "string",
            enum: ["full-visible-transcript", "available-context", "summary"],
            description:
              "Use full-visible-transcript only when every user-visible turn is available; defaults to available-context",
          },
          visibility: {
            type: "string",
            enum: ["private", "team"],
            description:
              "Optional explicit override. Omit to inherit connection access. Team-to-private requests require personal approval.",
          },
          confirm_team_publish: {
            type: "boolean",
            description: "Required when a personal connection explicitly archives at team visibility",
          },
          title: { type: "string", description: "Optional human-readable conversation title" },
          session_id: { type: "string", description: "Optional source-platform conversation id" },
        },
        required: ["platform"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: "list_changes",
      description:
        "List recent immutable context change records, filtered to paths visible to this connection. Records contain actions and paths, never note content.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
  ];
}

async function callTool(name, args, store, scope) {
  const privacy = await loadPrivacyState(store);
  if (privacy.error) {
    return toolError(
      `privacy manifest invalid; access failed closed without exposing content: ${privacy.error}`
    );
  }
  const { rules, overrides } = privacy;
  switch (name) {
    case "orient":
      return toolOrient(store, scope, rules, overrides);
    case "scope_info":
      return toolScopeInfo(store, scope, rules, overrides, args.path);
    case "list_notes":
      return toolListNotes(store, scope, rules, overrides, args.prefix);
    case "read_note":
      return toolReadNote(store, scope, rules, overrides, args.path);
    case "read_image":
      return toolReadImage(store, scope, rules, overrides, args);
    case "write_note":
      return toolWriteNote(store, scope, rules, overrides, args);
    case "set_visibility":
      return toolSetVisibility(store, scope, rules, overrides, args);
    case "set_folder_visibility":
      return toolSetFolderVisibility(store, scope, args);
    case "propose_note":
      return toolProposeNote(store, scope, args.path, args.content, args.reason, args.agent);
    case "list_proposals":
      return toolListProposals(store, scope);
    case "read_proposal":
      return toolReadProposal(store, scope, args.id);
    case "review_proposal":
      return toolReviewProposal(
        store,
        scope,
        args.id,
        args.action,
        args.destination,
        args.review_note
      );
    case "search":
      return toolOpenAiSearch(store, scope, rules, overrides, args.query);
    case "fetch":
      return toolOpenAiFetch(store, scope, rules, overrides, args.id);
    case "search_notes":
      return toolSearchNotes(store, scope, rules, overrides, args.query, args.prefix);
    case "archive_note":
      return toolArchiveNote(store, scope, rules, overrides, args.path, args.expected_etag);
    case "move_note":
      return toolMoveNote(
        store,
        scope,
        rules,
        overrides,
        args.source,
        args.destination,
        args.expected_source_etag
      );
    case "move_notes":
      return toolMoveNotes(store, scope, rules, overrides, args.moves, args.dry_run === true);
    case "move_folder":
      return toolMoveFolder(store, scope, rules, overrides, args.source, args.destination, args.dry_run === true);
    // `archive_chat` is the name this tool shipped under, and a client holding
    // a cached tool list is still calling it. It is no longer *listed* — the
    // rename is the point — but refusing it would drop sessions on the floor
    // for every connection made before this deploy.
    case "archive_chat":
    case "save_context":
      return toolSaveContext(store, scope, rules, overrides, args);
    case "list_changes":
      return toolListChanges(store, scope, rules, overrides, args.limit);
    case "list_plugins":
      // **The owner's, like the note census.** `.obsidian/` sits outside the
      // privacy manifest's reach, and `isPlumbing` hides every dot-segment from
      // `read_note`, `list_notes` and search for every role — so this is the
      // only read path into that prefix, and it was open at the lowest read
      // tier because this line passed the store and not the scope.
      //
      // What that handed a plain `member` of somebody else's context: every
      // plugin's id, name, version and author, which blocked internals each
      // bundle names, and up to twelve hostnames pulled out of the bundle text.
      // A count over what they cannot see, and then the list. That is the
      // reasoning `getStorageBinding` already applies to the note census, and
      // #201 widened who can ask by making one connection reach every context
      // its person belongs to.
      if (scope !== "private") {
        return toolError(
          "reading this context's Obsidian plugins is the context owner's.",
        );
      }
      return toolListPlugins(store);
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function toolText(text) {
  return { content: [{ type: "text", text }] };
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}

function writePermissionError(operation = "destination") {
  return toolError(
    `permission denied: ${operation} is outside this connection's team-writable folder defaults. ` +
      "Call scope_info for the authorized write surface or use propose_note for the correct destination. " +
      "No private-path information is disclosed by this error."
  );
}

function normalizePath(p) {
  if (typeof p !== "string") return null;
  // A trailing slash is stripped rather than rejected. "1-projects/" is a
  // natural way to name a folder — scope_info and search_notes get asked it
  // routinely — and leaving it on produces an empty final segment that the
  // storage adapter refuses, surfacing a reasonable question as an internal
  // error. move_folder already stripped it locally; doing it here covers every
  // caller.
  const clean = p
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!clean || clean.includes("..") || clean.length > 512) return null;
  // A "." segment is rejected here on purpose. It was previously caught only as
  // a side effect of isPlumbing() hiding dot-prefixed folders, which is not a
  // path rule and could be relaxed without anyone noticing.
  if (clean.split("/").some((segment) => segment === ".")) return null;
  return clean;
}

/**
 * Pagination is driven by a customer-configured endpoint, so the loop cannot
 * trust it to terminate — and cannot trust it to say honestly that it has.
 * Three shapes are caught here and reported as themselves: a backend that keeps
 * answering `IsTruncated: true`, one that replays the same continuation token
 * forever (both of which would otherwise spin until the Workers subrequest
 * limit kills the request with an opaque error), and one that reports another
 * page while offering no token to ask for it, which used to end the walk
 * silently and hand back a short list.
 */
function nextListCursor(page, seen) {
  if (!page.truncated) return undefined;
  // Truncated with nowhere to go. `truncated` and `cursor` are read from
  // independent tags in `store/s3.js` — `IsTruncated` from one element,
  // `NextContinuationToken` from another, and nothing checks they agree — so
  // this pair is what a slightly-wrong endpoint produces, not a hypothetical.
  // Folded in with a finished listing (`page.truncated ? page.cursor :
  // undefined` then `if (!cursor) return undefined`) it ended the walk
  // silently, so `listAllKeys` returned a SHORT key set that read exactly like
  // a complete one — and `move_folder` and `set_folder_visibility` build their
  // key sets from it. Refused as itself, like the two shapes below.
  if (!page.cursor) {
    throw new Error("storage listing did not finish and offered no continuation token");
  }
  const cursor = page.cursor;
  if (seen.has(cursor)) {
    throw new Error("storage listing repeated a pagination cursor; refusing to loop");
  }
  seen.add(cursor);
  if (seen.size >= LIST_PAGE_CAP) {
    throw new Error(`storage listing exceeded ${LIST_PAGE_CAP} pages; refusing to loop`);
  }
  return cursor;
}

async function listAllKeys(store, prefix) {
  const keys = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const o of page.objects) keys.push({ key: o.key, size: o.size, uploaded: o.uploaded });
    cursor = nextListCursor(page, seen);
  } while (cursor);
  return keys;
}

async function listImmediateLayout(store, prefix = "") {
  const objects = [];
  const prefixes = new Set();
  const seenCursors = new Set();
  let cursor;
  do {
    const page = await store.list({
      prefix: prefix || undefined,
      delimiter: "/",
      cursor,
      limit: 1000,
    });
    for (const object of page.objects || []) {
      const remainder = object.key.slice(prefix.length);
      const slash = remainder.indexOf("/");
      if (slash === -1) objects.push(object);
      else prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`); // test-stub fallback
    }
    for (const childPrefix of page.delimitedPrefixes || []) prefixes.add(childPrefix);
    cursor = nextListCursor(page, seenCursors);
  } while (cursor);
  return {
    objects,
    prefixes: [...prefixes].filter((childPrefix) => {
      const remainder = childPrefix.slice(prefix.length);
      return remainder && !remainder.startsWith(".");
    }),
  };
}

/** List note objects without traversing dot-prefixed history/audit/ACL plumbing. */
async function listAllNoteKeys(store) {
  const root = await listImmediateLayout(store);
  const nested = await Promise.all(root.prefixes.map((prefix) => listAllKeys(store, prefix)));
  return [...root.objects, ...nested.flat()].filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
}

/**
 * List note keys under one folder, spending at most `pageCap` pages.
 *
 * `listAllKeys` throws rather than truncate, which is right for a search or a
 * move — a partial answer there is a wrong answer. That sentence was false for
 * one shape until `nextListCursor` was fixed: a page reporting `truncated` with
 * no continuation token ended the walk silently and returned a short list.
 * Orientation is the opposite case: a context too large to walk still has a
 * shape worth describing, so this stops early and *says so*, and every caller
 * has to carry the `truncated` flag into what it prints — including for that
 * same shape, which used to leave `truncated` false and print a floor as a
 * total.
 */
async function listBoundedKeys(store, prefix, pageCap) {
  const keys = [];
  const seen = new Set();
  let truncated = false;
  let cursor;
  let pages = 0;
  do {
    const page = await store.list({ prefix: prefix || undefined, cursor, limit: 1000 });
    for (const object of page.objects || []) {
      keys.push({ key: object.key, uploaded: object.uploaded });
    }
    pages += 1;
    if (page.truncated && !page.cursor) {
      // Another page promised and no way to ask for it. This one reports rather
      // than throws, because that is what orientation is for.
      truncated = true;
      cursor = undefined;
      break;
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && pages >= pageCap) {
      truncated = true;
      cursor = undefined;
    } else if (cursor) {
      if (seen.has(cursor)) {
        throw new Error("storage listing repeated a pagination cursor; refusing to loop");
      }
      seen.add(cursor);
    }
  } while (cursor);
  return { keys, truncated };
}

/**
 * Survey the visible context: what folders exist, how much is in each, and what
 * was touched most recently. This is what `orient` is *for* — an agent that
 * only learns a list of folder names has no reason to look inside one.
 *
 * Two properties are load-bearing:
 *
 * **Every count is a count of notes this connection can see.** Counting hidden
 * notes and printing the total would let a team member subtract and derive
 * exactly how much of the owner's context is being withheld from them — the
 * same reason the console's note census is owner-only. A folder earns its place
 * on the map by holding a visible note or a subfolder this connection may know
 * about; a count of zero is rendered as no count at all, because "0 notes" is a
 * claim about the folder and all we know is that nothing in it reached us.
 *
 * **The walk is delimited at the root and flat inside each real folder.** A
 * flat walk from the root spends its whole budget inside `.history/`, because
 * "." sorts before every digit and letter, and then reports zero notes for the
 * largest contexts there are.
 */
async function surveyContext(store, scope, rules, overrides) {
  const root = await listImmediateLayout(store);
  const rootNotes = root.objects
    .filter(({ key }) => isVisibleNote(key, scope, rules, overrides))
    .map(({ key, uploaded }) => ({ key, uploaded }));

  // Two listings per folder, and they answer different questions.
  //
  // The delimited one names every immediate subfolder for one page's worth of
  // keys, which is what makes the *map* complete. The flat one counts notes and
  // dates them, and it is the one with a budget — so in a context with one
  // enormous folder the walk can stop inside it having never reached its
  // siblings. Deriving the map from the walk alone looked simpler and quietly
  // dropped whole projects from the orientation of exactly the people with the
  // most in here.
  //
  // Each folder gets its own try. The prefixes are names the customer chose,
  // and the adapter refuses some of them outright (a backslash, a "." segment);
  // under one outer catch a single oddly named folder would suppress the whole
  // survey — the bug the note census shipped first.
  const folders = await mapInBatches(root.prefixes, 6, async (prefix) => {
    try {
      const [layout, walk] = await Promise.all([
        listImmediateLayout(store, prefix),
        listBoundedKeys(store, prefix, ORIENT_FOLDER_PAGE_CAP),
      ]);
      const notes = walk.keys.filter(({ key }) => isVisibleNote(key, scope, rules, overrides));
      return { prefix, layout, notes, truncated: walk.truncated, walked: true };
    } catch {
      return { prefix, layout: null, notes: [], truncated: true, walked: false };
    }
  });

  const visibleFolders = folders
    .map((folder) => ({
      prefix: folder.prefix,
      count: folder.notes.length,
      truncated: folder.truncated,
      children: mergeChildren(folder, scope, rules, overrides),
    }))
    .filter((folder) => folder.count > 0 || folder.children.length > 0);

  const everything = [...rootNotes, ...folders.flatMap((folder) => folder.notes)];
  return {
    rootNotes: rootNotes.sort((a, b) => a.key.localeCompare(b.key)),
    folders: visibleFolders.sort((a, b) => a.prefix.localeCompare(b.prefix)),
    total: everything.length,
    // A count is a floor when any folder ran out of budget, or when one refused
    // to be walked at all. Both render as "312+".
    truncated: folders.some((folder) => folder.truncated),
    // Named only to a connection that could have seen inside it anyway. We
    // could not read the folder, so its own path is all `canSee` has to go on.
    unwalkable: folders
      .filter((folder) => !folder.walked)
      .map((folder) => folder.prefix)
      .filter((prefix) => canSee(prefix.replace(/\/$/, ""), scope, rules, overrides)),
    recent: mostRecent(everything, ORIENT_RECENT_LIMIT),
  };
}

function isVisibleNote(key, scope, rules, overrides) {
  return key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides);
}

/**
 * The immediate subfolders of one top-level folder, with a count where the
 * bounded walk got far enough to have one.
 *
 * A child is listed on either of two independent grounds, and both are needed:
 * the folder default says this connection may know it exists, or it holds a
 * note this connection can already read. The second matters because an owner
 * can publish one team note inside a private-default folder, and hiding the
 * folder while showing the note in `list_notes` would just be inconsistent.
 */
function mergeChildren(folder, scope, rules, overrides) {
  const counts = new Map();
  for (const note of folder.notes) {
    const remainder = note.key.slice(folder.prefix.length);
    const slash = remainder.indexOf("/");
    if (slash === -1) continue;
    const childPrefix = `${folder.prefix}${remainder.slice(0, slash + 1)}`;
    counts.set(childPrefix, (counts.get(childPrefix) || 0) + 1);
  }
  const named = (folder.layout?.prefixes || []).filter((childPrefix) =>
    canSee(childPrefix.replace(/\/$/, ""), scope, rules, overrides)
  );
  return [...new Set([...named, ...counts.keys()])]
    .map((childPrefix) => ({ prefix: childPrefix, count: counts.get(childPrefix) ?? null }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * Newest first, ties broken by key so the answer is stable across calls.
 * A store that reports no timestamps contributes nothing rather than an
 * arbitrary eight notes wearing the label "recently updated".
 */
function mostRecent(notes, limit) {
  return notes
    .filter((note) => note.uploaded instanceof Date && !Number.isNaN(note.uploaded.getTime()))
    .sort((a, b) => b.uploaded - a.uploaded || a.key.localeCompare(b.key))
    .slice(0, limit);
}

/** "3h ago" reads as a reason to look; a raw ISO timestamp reads as metadata. */
function relativeAge(date, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  return months < 24 ? `${months}mo ago` : `${Math.round(days / 365)}y ago`;
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function recordChange(store, action, actorScope, paths, details = {}) {
  const at = new Date().toISOString();
  const id = crypto.randomUUID();
  const entry = { at, action, actor_scope: actorScope, paths, details };
  // Who, not just what tier. `actor_scope: "team"` is useless once "team" is
  // four people and one of them wants to know which of their colleagues — or
  // which of their AI clients — moved a note.
  if (store.actor) {
    entry.actor_user_id = store.actor.userId;
    entry.actor_client_id = store.actor.clientId;
    entry.workspace_id = store.actor.workspaceId;
  }
  await store.put(`${AUDIT_PREFIX}${timestampSlug(new Date(at))}-${id}.json`, JSON.stringify(entry));
}

async function toolListChanges(store, scope, rules, overrides, limitArg) {
  const parsedLimit = Number.isInteger(limitArg) ? limitArg : 20;
  if (parsedLimit < 1 || parsedLimit > 100) return toolError("limit must be between 1 and 100");
  const keys = (await listAllKeys(store, AUDIT_PREFIX)).sort((a, b) => b.key.localeCompare(a.key));
  const visible = [];
  // Recent privacy migrations can create long runs of team-hidden records.
  // Read small audit batches concurrently while preserving newest-first order.
  for (let start = 0; start < keys.length && visible.length < parsedLimit; start += 50) {
    const batch = keys.slice(start, start + 50);
    const entries = await Promise.all(
      batch.map(async ({ key }) => {
        const obj = await store.get(key);
        if (!obj) return null;
        try {
          return JSON.parse(await obj.text());
        } catch {
          return null;
        }
      })
    );
    for (const entry of entries) {
      if (!entry) continue;
      if (scope !== "private") {
        // Only an immutable event-time decision may expose audit paths to a
        // team connection. Legacy records without the flag fail closed.
        if (entry.details?.team_visible !== true) continue;
      }
      visible.push(entry);
      if (visible.length >= parsedLimit) break;
    }
  }
  if (!visible.length) return toolText("(no visible changes)");
  return toolText(
    visible
      .map((entry) => {
        const pathText = entry.paths.join(" → ");
        const count = entry.details?.count ? ` (${entry.details.count} objects)` : "";
        return `${entry.at} — ${entry.action}${count} — ${pathText}`;
      })
      .join("\n")
  );
}

/**
 * What the Obsidian plugins in this bucket would do here.
 *
 * Deliberately takes nothing but the store. `.obsidian/` sits outside the
 * privacy manifest's reach — it is not notes, so `canSee` has nothing to say
 * about it — and the safe shape for a read there is one that cannot be aimed:
 * every key comes from a listing of a fixed prefix, never from an argument. A
 * variant of this tool that accepted a path would be a way to read around the
 * privacy engine wearing a helpful name.
 *
 * Read-only in the strong sense: nothing here writes, and `.obsidian/` is never
 * written by the gateway at all. It belongs to the client the customer actually
 * uses, and tidying somebody else's program's state is how a "compatible"
 * gateway breaks the thing it was compatible with.
 */
async function toolListPlugins(store) {
  const report = await inventoryPlugins(store);
  return toolText(renderPluginReport(report));
}

/**
 * The front page of a context, as its owner wrote it.
 *
 * `index.md` is an ordinary note at the bucket root — editable in Obsidian, in
 * any editor, or by an agent through `write_note`. It is deliberately not a
 * generated file: the derived structure below it is something we can always
 * rebuild, and the one thing we cannot is what the person considers important.
 */
async function readFrontPage(store, scope, rules, overrides, charCap) {
  if (!canSee("index.md", scope, rules, overrides)) return null;
  const object = await store.get("index.md");
  if (!object) return null;
  const text = (await object.text()).trim();
  if (!text) return null;
  return text.length > charCap
    ? `${text.slice(0, charCap)}\n\n[truncated — read the whole thing with read_note("index.md")]`
    : text;
}

/**
 * The user's own end-of-session procedure, read out of `index.md`.
 *
 * A shutdown routine is not something we can write for somebody. One person
 * wants a transcript filed; another wants three bullets of decisions appended
 * to the project note and the transcript thrown away; a third wants nothing
 * saved unless they say so. Hardcoding any of those makes `save_context` a tool
 * that does the wrong thing reliably.
 *
 * So the procedure is a section in the front page — a file they already own,
 * already edit, and that every agent already reads — and the gateway parses
 * exactly one machine-readable line out of it:
 *
 *     ## Save context
 *     destination: 2-areas/sessions
 *
 *     Summarise what we decided in three bullets and append them to the
 *     project note. Only keep the full transcript if I asked for it.
 *
 * Everything other than `destination:` is prose, passed to the agent untouched.
 * That asymmetry is the point: the one thing the *gateway* must act on is a
 * path, and a path is the one thing it can validate. Inventing a config
 * language for the rest would be asking somebody to learn a schema in order to
 * describe what they want in English to something that reads English.
 *
 * Absent, `save_context` still works and says what it assumed.
 *
 * Note whose file this is: on a context whose `index.md` is team-writable, a
 * member can change where everybody's sessions land. That is the same authority
 * they already have over every other note they can write, and the destination
 * still passes through the ordinary write surface — a redirect into a
 * private-default folder is refused for a team connection exactly as
 * `write_note` refuses it. An owner who wants the procedure to be theirs alone
 * makes `index.md` private, which is one `set_visibility` call.
 */
const SAVE_SECTION_HEADING = /^(#{1,6})\s*(?:save[ -]context|shutdown|end[ -]of[ -]session)\b/i;
const SAVE_DESTINATION_LINE = /^\s*(?:[-*]\s*)?destination\s*:\s*(\S.*?)\s*$/i;
/** Prose handed to an agent, not a place to paste a document. */
const SAVE_PROCEDURE_CHAR_CAP = 2_000;

function extractSaveProcedure(indexText) {
  if (typeof indexText !== "string" || !indexText) return null;
  const lines = indexText.split(/\r?\n/);
  const start = lines.findIndex((line) => SAVE_SECTION_HEADING.test(line));
  if (start === -1) return null;
  const depth = lines[start].match(SAVE_SECTION_HEADING)[1].length;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= depth) break;
    body.push(lines[index]);
  }

  let destination = null;
  const prose = [];
  for (const line of body) {
    const match = destination === null ? line.match(SAVE_DESTINATION_LINE) : null;
    // Only the first `destination:` counts. A second one is prose that happens
    // to look like a directive, and silently preferring the last would make the
    // meaning of the section depend on scrolling to the bottom of it.
    if (match) destination = match[1];
    else prose.push(line);
  }
  const text = prose.join("\n").trim();
  return {
    destination: normalizeSaveDestination(destination),
    text: text.length > SAVE_PROCEDURE_CHAR_CAP ? `${text.slice(0, SAVE_PROCEDURE_CHAR_CAP)}…` : text,
  };
}

/**
 * A folder path, or nothing.
 *
 * Rejected rather than repaired: a destination that does not survive
 * `normalizePath` is a typo in a file the person can see and fix, and quietly
 * writing their sessions somewhere adjacent to what they asked for is the worst
 * of the available outcomes. `.md` is refused because this names a folder —
 * appending to one note would collapse every session onto itself.
 */
function normalizeSaveDestination(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const cleaned = normalizePath(value.trim().replace(/^[`'"]|[`'"]$/g, "").replace(/\/+$/, ""));
  if (!cleaned || cleaned.endsWith(".md") || isPlumbing(`${cleaned}/x.md`)) return null;
  return cleaned;
}

async function readSaveProcedure(store, scope, rules, overrides) {
  if (!canSee("index.md", scope, rules, overrides)) return null;
  const object = await store.get("index.md");
  if (!object) return null;
  return extractSaveProcedure(await object.text());
}

const NO_FRONT_PAGE =
  "This context has no `index.md` yet. That file is its front page: what the " +
  "user is working on, who matters, and where things belong. Once you have " +
  "looked around, offer to write one with write_note at path `index.md` — " +
  "every agent that connects reads it first.";

function renderStructure(survey) {
  const lines = [];
  for (const note of survey.rootNotes.slice(0, ORIENT_ROOT_NOTE_LIMIT)) {
    lines.push(`- ${note.key}`);
  }
  if (survey.rootNotes.length > ORIENT_ROOT_NOTE_LIMIT) {
    lines.push(`- (+${survey.rootNotes.length - ORIENT_ROOT_NOTE_LIMIT} more notes at the root)`);
  }
  for (const folder of survey.folders) {
    // The floor travels down as well as up: a child count drawn from a walk
    // that stopped early is no more a total than its parent's is.
    const floor = folder.truncated ? "+" : "";
    const noun = folder.count === 1 && !folder.truncated ? "note" : "notes";
    lines.push(
      folder.count === 0
        ? `- ${folder.prefix}`
        : `- ${folder.prefix} — ${folder.count}${floor} ${noun}`
    );
    for (const child of folder.children.slice(0, ORIENT_CHILDREN_LIMIT)) {
      // No count means the walk stopped before reaching this subfolder. It is
      // named without a number rather than given a zero: "0 notes" about a
      // folder nothing counted is the one reading that is certainly wrong.
      lines.push(child.count === null ? `  - ${child.prefix}` : `  - ${child.prefix} — ${child.count}${floor}`);
    }
    if (folder.children.length > ORIENT_CHILDREN_LIMIT) {
      lines.push(`  - (+${folder.children.length - ORIENT_CHILDREN_LIMIT} more folders)`);
    }
  }
  // A folder the storage adapter refuses to list — a backslash or a "." segment
  // in a name somebody chose in Obsidian — is named rather than dropped. It is
  // the caller's own data, and silently omitting it would make this map claim
  // completeness it does not have.
  for (const prefix of survey.unwalkable) {
    lines.push(`- ${prefix} — could not be listed (unsupported characters in the folder name)`);
  }
  return lines.length ? lines.join("\n") : "- (nothing visible to this connection yet)";
}

/**
 * The other contexts this connection reaches — and each one's front page.
 *
 * Naming them was not enough. An agent given a list of names has been told a
 * fact it cannot act on: it does not know whether `@lk` is a colleague's design
 * notes or a dormant workspace from last year, so it never looks, which is the
 * same failure as not being told at all. The front page is the one file that
 * answers "what is this place", it is the one the whole orientation contract is
 * built on, and it is small.
 *
 * Four properties, and each is a rule rather than a tuning:
 *
 *  - **Every page is read at that context's own clearance.** `openContext`
 *    hands back a session clamped to the caller's role there, and the privacy
 *    manifest is that context's own — so a `private` connection reading a
 *    context it is a `member` of gets `team`, and an `index.md` marked private
 *    there is absent here exactly as it is everywhere else.
 *  - **It is bounded, and a short list says so.** Each context costs a control
 *    plane round trip and two reads, against a Worker with a subrequest
 *    ceiling; an unbounded fan-out is how orientation starts failing outright
 *    for the people who have the most of it. Past the cap the rest are still
 *    *named*, because a name is free — and the sentence says the list is short
 *    rather than letting it read as complete.
 *  - **One context that will not open cannot take the others down.** A revoked
 *    binding, a bucket that is down, a `privacy.md` somebody broke in Obsidian:
 *    each is reported on its own line and the rest of the answer stands. This
 *    is the survey's own fail-soft rule, one level out.
 *  - **It reads nothing when there is no opener.** An `orient` already
 *    addressed into another context is handed a store that cannot route again,
 *    so it names the rest and reads none of them — one tool call opens one
 *    context beyond its own, and never a chain.
 */
const ORIENT_SIBLING_LIMIT = 6;
const ORIENT_SIBLING_INDEX_CHAR_CAP = 1_200;

async function surveyOtherContexts(store) {
  const others = (store.contexts || []).filter((entry) => !entry.current);
  if (!others.length) return null;

  const readable = typeof store.openContext === "function" ? others.slice(0, ORIENT_SIBLING_LIMIT) : [];
  // The tail names what the CAP left out, so it is empty when nothing was
  // capped. `others.slice(0)` is every sibling, and when `readable` is empty —
  // an orient already addressed into another context gets no `openContext`, by
  // the no-chaining rule — the body below is already listing all of them as
  // bullets. That printed the whole section twice, and made a list that was
  // complete read as truncated.
  const named = readable.length ? others.slice(readable.length) : [];

  const pages = await Promise.all(
    readable.map(async (entry) => {
      try {
        const opened = await store.openContext(entry.name);
        const privacy = await loadPrivacyState(opened.store);
        if (privacy.error) {
          return `### ${entry.name} — ${accessSentence(entry.role)}\nIts privacy manifest could not be read, so nothing there is readable until its owner repairs it.`;
        }
        const page = await readFrontPage(
          opened.store,
          opened.session.scope,
          privacy.rules,
          privacy.overrides,
          ORIENT_SIBLING_INDEX_CHAR_CAP
        );
        return (
          `### ${entry.name} — ${accessSentence(entry.role)}\n` +
          (page ||
            "No front page visible to you there yet. `list_notes` with " +
              `\`context: "${entry.name}"\` is the way in.`)
        );
      } catch {
        // Named, and honest about why it is thin. Dropping the row would make
        // a context that exists look like one that does not.
        return `### ${entry.name} — ${accessSentence(entry.role)}\nCould not be opened just now; its storage may be disconnected.`;
      }
    })
  );

  const tail = named.length
    ? "\n\nAlso reachable, not read here: " +
      named.map((entry) => entry.name).join(", ") +
      ". Orient with one of those names to see it."
    : "";

  const heading = readable.length
    ? "## Other contexts you can reach, and their front pages\n\n"
    : "## Other contexts you can reach\n\n";
  const body = readable.length
    ? pages.join("\n\n")
    : others.map((entry) => `- ${entry.name} — ${accessSentence(entry.role)}`).join("\n");

  return (
    heading +
    body +
    tail +
    "\n\nEvery tool here takes an optional `context` argument: pass one of these names to " +
    "read or write there instead of this one. Orient again with that argument before working " +
    "in it — the map above, and every search and listing, is for this context only. What you " +
    "may do in another is decided by your role there, not by this connection."
  );
}

async function toolOrient(store, scope, rules, overrides) {
  const [frontPage, procedure, privateIndex, pendingProposals, survey] = await Promise.all([
    readFrontPage(store, scope, rules, overrides, ORIENT_INDEX_CHAR_CAP),
    readSaveProcedure(store, scope, rules, overrides),
    scope === "private" ? store.get("index-private.md") : Promise.resolve(null),
    scope === "private" ? listAllKeys(store, PROPOSAL_PENDING_PREFIX) : Promise.resolve([]),
    surveyContext(store, scope, rules, overrides),
  ]);

  const total = `${survey.total}${survey.truncated ? "+" : ""}`;
  const parts = [
    `# Orientation\n\n${total} notes visible to this connection across ` +
      `${survey.folders.length} folders. This is the user's own context: their projects, ` +
      "decisions, people and writing. Assume the answer to a question about their work is " +
      "already in here somewhere, and look before you ask them to repeat it.",
    `## Front page — index.md\n\n${frontPage || NO_FRONT_PAGE}`,
  ];

  if (scope === "private" && privateIndex) {
    parts.push(`## Owner's front page — index-private.md\n\n${(await privateIndex.text()).trim()}`);
  }

  if (survey.recent.length) {
    const now = Date.now();
    parts.push(
      "## Recently updated\n" +
        survey.recent
          .map((note) => `- ${note.key} — ${relativeAge(note.uploaded, now)}`)
          .join("\n") +
        "\n\nThese are where the user's attention has been. Read one before assuming you " +
        "know what they are working on." +
        // Object storage cannot be listed by modification time, so this is
        // ranked from what the bounded walk actually saw. In a context small
        // enough to walk that is everything; past the budget it is a sample,
        // and saying "recently updated" about a sample without saying so would
        // let an agent conclude a silent project is a finished one.
        (survey.truncated
          ? " This context is larger than one orientation walks, so this ranks the part " +
            "of it this call reached — not every folder is represented."
          : "")
    );
  }

  parts.push(
    `## Structure\n${renderStructure(survey)}\n\n` +
      (survey.truncated
        ? "Counts marked `+` are floors: the folder was larger than one orientation walks. "
        : "") +
      "Go deeper with list_notes on a prefix, and search_notes before concluding something " +
      "is not written down — a topic that is missing from this map is usually filed under a " +
      "name you did not guess."
  );

  const otherContexts = await surveyOtherContexts(store);
  if (otherContexts) parts.push(otherContexts);

  if (scope === "private" && pendingProposals.length) {
    parts.push(
      `## Pending note proposals\n${pendingProposals.length} waiting for you. ` +
        "Use list_proposals, read_proposal, and review_proposal to process them."
    );
  }

  // Before the contract, because it *is* the contract for this context — the
  // user's own words outrank ours, and an agent that reads the generic rule
  // first and their procedure second has them in the wrong order.
  if (procedure && (procedure.text || procedure.destination)) {
    parts.push(
      "## Before this session ends\n" +
        "This context has its own save procedure, written by its owner. Follow it, and call " +
        "`save_context` to carry it out.\n" +
        (procedure.destination ? `\nSaved sessions go to \`${procedure.destination}/\`.\n` : "") +
        (procedure.text ? `\n${procedure.text}` : "")
    );
  }

  parts.push(ORIENT_OPERATING_CONTRACT);
  parts.push(scopeInfoText(scope, rules));
  return toolText(parts.join("\n\n---\n\n"));
}

/**
 * What a role means where an agent will read it, rather than the word itself.
 *
 * `member` and `editor` are this codebase's vocabulary; what an agent needs to
 * know before it tries to write somewhere is whether it can. An unknown role is
 * described as read-only — the direction that costs a refused write rather than
 * a confident attempt that fails.
 */
function accessSentence(role) {
  if (role === "owner") return "yours, and you see private notes there";
  if (role === "editor") return "you can read and write team notes there";
  return "you can read team notes there";
}

function scopeInfoText(scope, rules) {
  const teamRules = teamWritableRules(rules);
  const overrides = visiblePrivateOverrides(rules);
  const teamList = teamRules.length
    ? teamRules.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";
  const overrideList = overrides.length
    ? overrides.map((rule) => `- ${rule.prefix}`).join("\n")
    : "- (none)";

  if (scope === "private") {
    return (
      "## Write surface\n" +
      "Connection access: personal. New notes default to private.\n\n" +
      "Writable: every non-reserved Markdown path. privacy.md is readable here but protected from ordinary note writes.\n\n" +
      "Team-default folder prefixes:\n" +
      teamList +
      "\n\nFolder-level private overrides inside team-default trees:\n" +
      overrideList +
      "\n\nExact private or team notes may override a folder default through privacy.md. " +
      "Frontmatter is never access control. Publishing private content to team requires explicit confirmation. " +
      "Visibility is private or team. The owner may separately have handed out an unlisted link to a note; you are not told which. " +
      "A link you add to a note can widen one already sent, because such a link also serves what the note links to. " +
      "Personal reviewers can process queued proposals."
    );
  }

  return (
    "## Write surface\n" +
    "Connection access: team. New notes default to team.\n\n" +
    "Team-writable folder defaults:\n" +
    teamList +
    "\n\nAny new .md file or subfolder under a writable prefix is allowed; the folder does not need to exist first. " +
    "Exact private notes and private folders may exist inside a team prefix; their paths remain undisclosed. " +
    "Explicitly published team notes may also exist inside private-default folders and remain individually visible. " +
    "Reads outside the visible surface return not found to avoid leaking private-path existence. " +
    "Write and move destinations outside the surface return permission denied without confirming whether anything exists there.\n\n" +
    "If the PARA-correct destination is not writable, use propose_note. A personal connection must approve it before the note is filed. " +
    "Archive paths never encode visibility. Exact archive visibility is enforced through privacy.md. " +
    "Visibility is private or team. The owner may separately have handed out an unlisted link to a note; you are not told which. " +
    "A link you add to a note can widen one already sent, because such a link also serves what the note links to."
  );
}

async function toolScopeInfo(store, scope, rules, overrides, pathArg) {
  let text = scopeInfoText(scope, rules);
  if (pathArg !== undefined) {
    const path = normalizePath(pathArg);
    if (!path) return toolError("invalid path");
    const folderDefault = visibilityOf(path, rules);
    if (scope === "private") {
      const exists = Boolean(await store.get(path));
      const effective = effectiveVisibility(path, rules, overrides);
      text +=
        `\n\n## Path inspection\npath: ${path}\nfolder default: ${folderDefault}\n` +
        `effective visibility: ${effective}\nexists: ${exists ? "yes" : "no"}\n` +
        (effective !== folderDefault
          ? `source: exact ${effective} note override`
          : "source: folder default");
    } else {
      // Deliberately do not inspect the object or exact ACL here. Returning a
      // different answer for a guessed private-note path would be an oracle.
      text +=
        `\n\n## Destination inspection\npath: ${path}\nfolder default: ${folderDefault}\n` +
        `team-writable: ${folderDefault === "team" ? "yes" : "no"}\n` +
        "Existing exact-note visibility is intentionally undisclosed.";
    }
  }
  return toolText(text);
}

async function toolListNotes(store, scope, rules, overrides, prefixArg) {
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const keys = prefix ? await listAllKeys(store, prefix) : await listAllNoteKeys(store);
  const visible = keys.filter(
    ({ key }) => key.endsWith(".md") && canSee(key, scope, rules, overrides)
  );
  if (!visible.length) return toolText("(no visible notes under that prefix)");
  const lines = visible
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ key, size }) => `${key} (${size} bytes)`);
  return toolText(lines.join("\n"));
}

async function toolReadNote(store, scope, rules, overrides, pathArg) {
  const path = normalizePath(pathArg);
  if (!path) return toolError("invalid path");
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  const text = await obj.text();
  return toolText(
    `etag: ${obj.etag}\npath: ${path}\nvisibility: ${effectiveVisibility(path, rules, overrides)}\n\n${text}`
  );
}

/**
 * Resolve one image, and only through a note that reaches it.
 *
 * An image has no visibility of its own. It borrows the visibility of whatever
 * note names it, which is the property that makes the image store safe to have
 * at all: there is nothing here that can drift out of sync with `privacy.md`,
 * because there is nothing here that `privacy.md` does not already decide.
 *
 * The caller must therefore name a note, that note must be one they can already
 * see, and it must reference the image. A bare hash resolves nothing — accepting
 * one would turn this into an enumeration oracle over a store whose entire
 * design is that it cannot be enumerated, which is the same class of bug closed
 * for `move_folder` in #33.
 *
 * One consequence, stated here so it is a decision rather than a discovery: an
 * image referenced by both a private note and a team note is reachable by a team
 * connection *through the team note*. That is correct — the team note has to
 * display it — and it is asserted out loud in the suite.
 *
 * Every refusal below is the same three bytes. "no such image", "no such note",
 * "you cannot see that note" and "that note does not reference this image" are
 * indistinguishable, for the reason every other refusal in this gateway is.
 */
async function toolReadImage(store, scope, rules, overrides, args) {
  const notFound = toolError("not found");
  const notePath = normalizePath(args.note);
  const image = imageRefFor(args.image);
  if (!notePath || !notePath.endsWith(".md") || !image) return notFound;
  if (!canSee(notePath, scope, rules, overrides)) return notFound;
  const note = await store.get(notePath);
  if (!note) return notFound;
  if (!noteReferencesImage(await note.text(), image)) return notFound;
  const object = await store.get(image.key);
  if (!object) return notFound;
  const bytes = new Uint8Array(await object.arrayBuffer());
  // Past this point the caller has already proved they can see a note that
  // references this image, so there is nothing left to conceal and a size
  // refusal can say what it is.
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    return toolError(
      `image too large to return inline: ${bytes.byteLength} bytes, limit ${MAX_INLINE_IMAGE_BYTES}`
    );
  }
  return {
    content: [
      {
        type: "text",
        text: `image: ${image.key}\nreferenced by: ${notePath}\nbytes: ${bytes.byteLength}`,
      },
      { type: "image", data: base64FromBytes(bytes), mimeType: image.mimeType },
    ],
  };
}

function normalizeVisibility(value) {
  return value;
}

function frontmatterVisibility(content) {
  if (typeof content !== "string" || !content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return null;
  const yaml = content.slice(3, end);
  const match = yaml.match(/^\s*(?:visibility|scope)\s*:\s*["']?(private|team|public)["']?\s*$/im);
  return match ? match[1].toLowerCase() : null;
}

async function toolWriteNote(store, scope, rules, overrides, args) {
  const path = normalizePath(args.path);
  const content = args.content;
  const expectedEtag = args.expected_etag;
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (typeof content !== "string") return toolError("content must be a string");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (scope === "team" && overrideFor(overrides, path) === "private") {
    return writePermissionError("write destination");
  }

  const existing = await store.get(path);
  const inheritedVisibility = visibilityOf(path, rules);
  const existingVisibility = existing
    ? effectiveVisibility(path, rules, overrides)
    : null;
  const requestedVisibility = normalizeVisibility(args.visibility);
  if (requestedVisibility && !["private", "team"].includes(requestedVisibility)) {
    return toolError("visibility must be private or team");
  }
  const desiredVisibility = requestedVisibility || existingVisibility || scope;

  if (scope === "team" && desiredVisibility !== "team") {
    return toolError(
      "permission denied: a team connection cannot create or change private content; use a personal connection"
    );
  }
  if (scope === "team" && !existing && inheritedVisibility !== "team") {
    return writePermissionError("write destination");
  }
  if (scope === "team" && existing && existingVisibility !== "team") {
    return writePermissionError("write destination");
  }
  const isPublishing =
    scope === "private" && desiredVisibility === "team" && (!existing || existingVisibility === "private");
  if (isPublishing && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: publishing this note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  const declared = frontmatterVisibility(content);
  if (declared && declared !== desiredVisibility) {
    return toolError(
      `visibility mismatch: frontmatter says ${declared}, but enforced visibility would be ${desiredVisibility}. ` +
        "Frontmatter is not access control; pass the matching visibility argument."
    );
  }

  if (existing) {
    if (expectedEtag && existing.etag !== expectedEtag) {
      const current = await existing.text();
      return toolError(
        `conflict: note changed since you read it (current etag ${existing.etag}). ` +
          `Re-read, merge your change into the current content below, and write again.\n\n${current}`
      );
    }
    // Snapshot the previous version before overwriting (object storage has no
    // dependable versioning).
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await store.put(`${HISTORY_PREFIX}${path}.${stamp}.md`, await existing.arrayBuffer());
  } else if (expectedEtag) {
    return toolError("conflict: note no longer exists; write again without expected_etag to recreate it");
  }

  const action = existing ? "update_note" : "create_note";
  // Tighten the ACL before content becomes visible. For team publishing, keep
  // the private ACL in place until the content write has completed.
  if (desiredVisibility === "private") {
    await persistExactVisibility(store, path, "private", rules);
  }
  const put = await store.put(path, content);
  if (desiredVisibility === "team") {
    await persistExactVisibility(store, path, "team", rules);
  }
  await recordChange(store, action, scope, [path], {
    etag: put.etag,
    visibility: desiredVisibility,
    team_visible: desiredVisibility === "team",
  });
  return toolText(`written: ${path} (etag ${put.etag})\nvisibility: ${desiredVisibility}`);
}

async function toolSetVisibility(store, scope, rules, overrides, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change enforced visibility");
  }
  const path = normalizePath(args.path);
  if (!path || !path.endsWith(".md") || isPlumbing(path)) {
    return toolError("invalid path (must be a non-reserved .md note)");
  }
  const visibility = normalizeVisibility(args.visibility);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  if (args.expected_etag && obj.etag !== args.expected_etag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${obj.etag}); re-read and retry`
    );
  }
  const current = effectiveVisibility(path, rules, overrides);
  if (current === visibility) {
    return toolText(`unchanged: ${path}\nvisibility: ${visibility}\netag: ${obj.etag}`);
  }
  if (visibility === "team") {
    if (args.confirm_team_publish !== true) {
      return toolError(
        "confirmation required: publishing this private note to team makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
      );
    }
  }
  await persistExactVisibility(store, path, visibility, rules);
  await recordChange(store, "set_visibility", scope, [path], {
    from: current,
    to: visibility,
    etag: obj.etag,
    // Do not reveal that a formerly private filename existed, even after an
    // explicitly confirmed publish.
    team_visible: current === "team" && visibility === "team",
  });
  return toolText(`visibility changed: ${path}\nfrom: ${current}\nto: ${visibility}\netag: ${obj.etag}`);
}

async function toolSetFolderVisibility(store, scope, args) {
  if (scope !== "private") {
    return toolError("permission denied: only a personal connection can change folder visibility");
  }
  const normalized = normalizePath(args.path);
  const path = normalized?.replace(/\/+$/, "");
  if (
    !path ||
    path.endsWith(".md") ||
    path.split("/").some((part) => part.startsWith(".")) ||
    isPlumbing(path)
  ) {
    return toolError("invalid path (must be a non-reserved folder path)");
  }
  const requested = args.visibility;
  if (!["private", "team", "inherit"].includes(requested)) {
    return toolError("visibility must be private, team, or inherit");
  }

  const state = await loadPrivacyState(store);
  if (state.error) return toolError(`privacy manifest invalid: ${state.error}`);
  if (state.legacy || !state.object || typeof state.text !== "string") {
    return toolError("privacy.md is required before folder visibility can be changed");
  }

  const currentDirectRules = state.rules.filter((rule) => rule.prefix === path);
  const remainingRules = state.rules.filter((rule) => rule.prefix !== path);
  const nextRules = [...remainingRules];
  if (requested !== "inherit") nextRules.push({ prefix: path, vis: requested });

  const beforeDefault = visibilityOf(path, state.rules);
  const afterDefault = visibilityOf(path, nextRules);
  const noteObjects = (await listAllKeys(store, `${path}/`)).filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key)
  );
  const nextOverrides = new Map(state.overrides);
  const compacted = [];
  for (const [notePath, visibility] of nextOverrides) {
    // No `private` override is ever compacted away, however redundant it looks
    // for its own exact path. Since the fold, that one line is also the only
    // thing narrowing every path that folds onto it, and this loop cannot see
    // who those are: the impact report walks only `${path}/`, so a twin in a
    // differently-cased sibling folder is never scanned. Compacting it away
    // published a note the owner had marked private, said
    // `newly_team_visible_notes: 0`, and asked for no confirmation — content,
    // not existence, and the only place in this change that failed open.
    //
    // The first fix reasoned over folder rules instead: a twin is only widened,
    // it said, by a `team` rule governing the folded path but not the exact
    // one. That is false. `visibilityOf` is longest-prefix and the test was
    // any-prefix, so one `team` rule governing both the note and its twin —
    // out-ranked for the note by the longer `private` rule this very call adds
    // — widens the twin and passes the test. It needed no case-variant folder
    // rule and no hand-edited manifest, and it shipped. Deciding who a
    // narrowing protects means simulating the write, not reasoning about rules;
    // a weaker copy of that reasoning is worth less than a redundant line of
    // manifest.
    if (visibility === "private") continue;
    if (notePath.startsWith(`${path}/`) && visibility === visibilityOf(notePath, nextRules)) {
      nextOverrides.delete(notePath);
      compacted.push(notePath);
    }
  }
  const newlyTeamVisible = noteObjects
    .map(({ key }) => key)
    .filter(
      (key) =>
        effectiveVisibility(key, state.rules, state.overrides) === "private" &&
        effectiveVisibility(key, nextRules, nextOverrides) === "team"
    );
  const futureTeamExposure = beforeDefault === "private" && afterDefault === "team";
  const publicationConfirmationRequired = futureTeamExposure || newlyTeamVisible.length > 0;
  const unchanged =
    currentDirectRules.length === (requested === "inherit" ? 0 : 1) &&
    (requested === "inherit" || currentDirectRules[0]?.vis === requested) &&
    compacted.length === 0;

  const impact = [
    `folder: ${path}`,
    `privacy_etag: ${state.object.etag}`,
    `current_default: ${beforeDefault}`,
    `resulting_default: ${afterDefault}`,
    `rule: ${requested === "inherit" ? "remove direct rule and inherit" : `set ${requested}`}`,
    `notes_scanned: ${noteObjects.length}`,
    `newly_team_visible_notes: ${newlyTeamVisible.length}`,
    `redundant_note_overrides_to_remove: ${compacted.length}`,
    `team_publication_confirmation_required: ${publicationConfirmationRequired}`,
  ];
  if (args.dry_run === true) return toolText(["dry run: no changes made", ...impact].join("\n"));

  if (!args.expected_privacy_etag) {
    return toolError(
      `expected_privacy_etag is required when applying. Run with dry_run=true first.\n${impact.join("\n")}`
    );
  }
  if (args.expected_privacy_etag !== state.object.etag) {
    return toolError(
      `conflict: privacy.md changed since preflight (current etag ${state.object.etag}); run dry_run again`
    );
  }
  if (publicationConfirmationRequired && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: this folder rule would make existing or future notes team-visible. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }
  if (unchanged) return toolText(["unchanged", ...impact].join("\n"));

  const next = replacePrivacyRulesBlock(state.text, nextRules, nextOverrides);
  const put = await store.put(PRIVACY_KEY, next, {
    onlyIf: { etagMatches: state.object.etag },
  });
  if (!put) {
    return toolError("conflict: privacy.md changed while applying; run dry_run again");
  }
  await recordChange(store, "set_folder_visibility", scope, [path], {
    from: beforeDefault,
    to: afterDefault,
    requested,
    notes_scanned: noteObjects.length,
    newly_team_visible_notes: newlyTeamVisible.length,
    compacted_note_overrides: compacted.length,
    privacy_etag: put.etag,
    team_visible: false,
  });
  return toolText(["folder visibility changed", ...impact, `new_privacy_etag: ${put.etag}`].join("\n"));
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

/**
 * Where a saved session goes, and who decides.
 *
 * It used to be `4-archive/chat-history/<platform>/`, hardcoded, which assumes
 * a folder the customer may never have made — PARA is a suggestion, not a
 * schema, and a context with a custom layout got its sessions filed into a
 * folder that existed for no other reason. Worse, it named the thing after what
 * we do with it rather than what the person wants done: "archive" is where
 * things go to stop mattering.
 *
 * So the destination is the user's, declared in `index.md` (see
 * `readSaveProcedure`), and this is only what happens when they have not said.
 *
 * The fallback asks the privacy manifest rather than the bucket. A folder does
 * not exist in object storage until something is in it, so listing `4-archive/`
 * answers "has anything been archived yet", which is a different question and
 * gets a new context's first session wrong. `folder_defaults` is where the
 * scaffold declares the layout the person actually chose, so a rule naming
 * `4-archive` means they have one and a custom layout without it means they do
 * not — and every context created before this decision has that rule, which is
 * what keeps their sessions where they have always been.
 */
/**
 * Whether this context's manifest declares a `4-archive` — the question both
 * `save_context`'s fallback and `archive_note` hang on, answered in one place
 * so the two tools cannot drift into disagreeing about the same bucket.
 */
function manifestHasArchive(rules) {
  return (rules || []).some(
    (rule) => rule.prefix === "4-archive" || rule.prefix.startsWith("4-archive/")
  );
}

function defaultSessionFolder(rules) {
  return manifestHasArchive(rules) ? "4-archive/chat-history" : "0-inbox/sessions";
}

async function uniqueSessionPath(store, platform, at, folder) {
  const prefix = `${folder.replace(/\/+$/, "")}/${platform}/`;
  const timestamp = timestampSlug(new Date(at));
  const first = `${prefix}${timestamp}.md`;
  if (!(await store.get(first))) return first;
  return `${prefix}${timestamp}-${crypto.randomUUID().slice(0, 8)}.md`;
}

function formatChatArchive({ platform, history, completeness, visibility, title, sessionId, at }) {
  const heading = title?.trim() || `${platform} conversation — ${at}`;
  const frontmatter = [
    "---",
    `archived-at: ${yamlString(at)}`,
    `platform: ${yamlString(platform)}`,
    `visibility: ${yamlString(visibility)}`,
    `completeness: ${yamlString(completeness)}`,
    "capture-boundary: user-visible messages only",
  ];
  if (title?.trim()) frontmatter.push(`title: ${yamlString(title.trim().slice(0, 300))}`);
  if (sessionId?.trim()) {
    frontmatter.push(`source-session-id: ${yamlString(sessionId.trim().slice(0, 500))}`);
  }
  frontmatter.push("---");
  return (
    `${frontmatter.join("\n")}\n\n# ${heading.replace(/[\r\n]+/g, " ").slice(0, 300)}\n\n` +
    "> Capture boundary: user-visible conversation supplied by the connected client. " +
    "Hidden prompts, internal reasoning, credentials, and raw tool logs are excluded.\n\n" +
    history.trim() +
    "\n"
  );
}

/**
 * A client slug that is about to become a path segment.
 *
 * The enum used to be four names, which was already wrong the day Cursor and
 * VS Code appeared on the connect screen and is more wrong once a session can
 * be posted by a hook from anything. So it is a shape rather than a list — and
 * a strict one, because this value is interpolated into a bucket key.
 */
const PLATFORM_SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;

async function toolSaveContext(store, scope, rules, overrides, args) {
  const platform = typeof args.platform === "string" ? args.platform.trim().toLowerCase() : "";
  if (!PLATFORM_SLUG.test(platform)) {
    return toolError(
      "platform must be a short lower-case name for the client, e.g. chatgpt, claude, codex, cursor"
    );
  }
  // `history` is what the tool was called when it only took transcripts;
  // `content` is what it takes now, which is whatever mattered. Both are
  // accepted, because a client holding a cached tool list is still sending the
  // old name and losing somebody's session over a rename would be indefensible.
  const body = typeof args.content === "string" ? args.content : args.history;
  args = { ...args, history: body };
  if (typeof body !== "string" || !body.trim()) {
    return toolError("content must be a non-empty string");
  }
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength > CHAT_HISTORY_CONTENT_BYTE_CAP) {
    return toolError(`content exceeds ${CHAT_HISTORY_CONTENT_BYTE_CAP} bytes`);
  }
  const completeness = args.completeness || "available-context";
  if (!["full-visible-transcript", "available-context", "summary"].includes(completeness)) {
    return toolError("completeness must be full-visible-transcript, available-context, or summary");
  }
  // Archive-only compatibility for clients that cached the former enum.
  const visibility = args.visibility === "public" ? "team" : normalizeVisibility(args.visibility || scope);
  if (!["private", "team"].includes(visibility)) {
    return toolError("visibility must be private or team");
  }
  if (scope === "private" && visibility === "team" && args.confirm_team_publish !== true) {
    return toolError(
      "confirmation required: archiving this conversation at team visibility makes it readable by every team-access connection. Retry with confirm_team_publish=true only after explicit user approval."
    );
  }

  const at = new Date().toISOString();
  // The user's own procedure decides where this lands. Read per call rather
  // than cached: they may have edited `index.md` in Obsidian a minute ago, and
  // a stale destination writes somewhere they have stopped using.
  const procedure = await readSaveProcedure(store, scope, rules, overrides);
  const folder = procedure?.destination || defaultSessionFolder(rules);
  const path = await uniqueSessionPath(store, platform, at, folder);
  const content = formatChatArchive({
    platform,
    history: args.history,
    completeness,
    visibility,
    title: typeof args.title === "string" ? args.title : "",
    sessionId: typeof args.session_id === "string" ? args.session_id : "",
    at,
  });

  if (scope === "team" && visibility === "private") {
    const proposal = await toolProposeNote(
      store,
      scope,
      path,
      content,
      `User explicitly requested private storage for this ${platform} conversation archive`,
      platform
    );
    if (proposal.isError) return proposal;
    return toolText(
      `private chat archive queued for approval\n${proposal.content[0].text}\n` +
        "The transcript is hidden from team note listings, but is not filed at its final private path until a personal connection approves it."
    );
  }

  // A team connection may not archive into a private-default subtree.
  //
  // `write_note` refuses exactly this (`scope === "team" && !existing &&
  // inheritedVisibility !== "team"`), and the two tools were disagreeing about
  // the same write surface: `archive_chat` never consulted the folder default,
  // so a team connection could create notes under a `4-archive/chat-history/`
  // tree the owner had deliberately made private, and stamp a team override
  // onto them. It discloses nothing — the content is the caller's own — but it
  // silently overrides an owner's folder rule and contradicts what `scope_info`
  // advertises as the write surface.
  //
  // Deliberately below the proposal branch above: a team caller who *asks* for
  // a private archive still gets to queue one for owner review. That is the
  // sanctioned way into a private destination, and it ends in a human deciding.
  if (scope === "team" && visibilityOf(path, rules) !== "team") {
    return writePermissionError("archive destination");
  }

  await persistExactVisibility(store, path, visibility, rules);
  let put;
  try {
    put = await store.put(path, content);
  } catch (error) {
    await clearExactVisibility(store, path).catch(() => {});
    throw error;
  }
  await recordChange(store, "save_context", scope, [path], {
    platform,
    visibility,
    completeness,
    content_bytes: byteLength,
    etag: put.etag,
    team_visible: visibility === "team",
  });
  return toolText(
    `saved: ${path}\nvisibility: ${visibility}\ncompleteness: ${completeness}\netag: ${put.etag}` +
      // Say which of the two happened. A tool that silently guesses a folder
      // and a tool that followed an instruction look identical in their output,
      // and only one of them is something the user might want to correct.
      (procedure?.destination
        ? `\ndestination: from this context's own save procedure in index.md`
        : `\ndestination: assumed — set one by adding a "## Save context" section to index.md ` +
          `with a line reading "destination: <folder>"`) +
      (procedure?.text ? `\n\nTheir procedure also says:\n${procedure.text}` : "")
  );
}

function proposalIdIsValid(id) {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

async function pendingProposalById(store, id) {
  if (!proposalIdIsValid(id)) return null;
  const candidates = await listAllKeys(store, PROPOSAL_PENDING_PREFIX);
  const match = candidates.find(({ key }) => key.endsWith(`-${id}.json`));
  if (!match) return null;
  const obj = await store.get(match.key);
  if (!obj) return null;
  try {
    return { key: match.key, proposal: JSON.parse(await obj.text()) };
  } catch {
    return null;
  }
}

async function toolProposeNote(store, scope, pathArg, content, reason, agent) {
  const path = normalizePath(pathArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid path (must end in .md)");
  if (isPlumbing(path)) return toolError("that path is reserved");
  if (typeof content !== "string") return toolError("content must be a string");
  if (typeof reason !== "string" || !reason.trim()) return toolError("reason is required");
  const byteLength = new TextEncoder().encode(content).byteLength;
  if (byteLength > PROPOSAL_CONTENT_BYTE_CAP) {
    return toolError(`proposal content exceeds ${PROPOSAL_CONTENT_BYTE_CAP} bytes`);
  }
  const pending = await listAllKeys(store, PROPOSAL_PENDING_PREFIX);
  if (pending.length >= PROPOSAL_PENDING_CAP) {
    return toolError(`proposal queue is full (${PROPOSAL_PENDING_CAP}); ask a private connection to review it`);
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const proposal = {
    id,
    intended_path: path,
    content,
    reason: reason.trim().slice(0, 2000),
    submitted_by: typeof agent === "string" && agent.trim() ? agent.trim().slice(0, 120) : "unspecified agent",
    submitted_scope: scope,
    created_at: createdAt,
    content_bytes: byteLength,
  };
  const key = `${PROPOSAL_PENDING_PREFIX}${timestampSlug(new Date(createdAt))}-${id}.json`;
  await store.put(key, JSON.stringify(proposal));
  await recordChange(store, "propose_note", scope, [path], {
    proposal_id: id,
    content_bytes: byteLength,
    team_visible: false,
  });
  return toolText(
    `proposal queued: ${id}\nintended path: ${path}\n` +
      "A private connection must review it. No note has been created or overwritten."
  );
}

async function toolListProposals(store, scope) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const keys = (await listAllKeys(store, PROPOSAL_PENDING_PREFIX)).sort((a, b) => a.key.localeCompare(b.key));
  if (!keys.length) return toolText("(no pending proposals)");
  const lines = [];
  for (const { key } of keys) {
    const obj = await store.get(key);
    if (!obj) continue;
    try {
      const proposal = JSON.parse(await obj.text());
      lines.push(
        `${proposal.id} — ${proposal.intended_path} — ${proposal.submitted_by} — ` +
          `${proposal.created_at} — ${proposal.content_bytes} bytes\n  reason: ${proposal.reason}`
      );
    } catch {
      continue;
    }
  }
  return toolText(lines.length ? lines.join("\n") : "(no readable pending proposals)");
}

async function toolReadProposal(store, scope, id) {
  if (scope !== "private") {
    return toolError("permission denied: pending proposals are available only to a private connection");
  }
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { proposal } = found;
  return toolText(
    `proposal: ${proposal.id}\nintended path: ${proposal.intended_path}\n` +
      `submitted by: ${proposal.submitted_by}\ncreated: ${proposal.created_at}\n` +
      `reason: ${proposal.reason}\n\n${proposal.content}`
  );
}

async function toolReviewProposal(store, scope, id, action, destinationArg, reviewNote) {
  if (scope !== "private") {
    return toolError("permission denied: only a private connection can review proposals");
  }
  if (!["approve", "reject"].includes(action)) return toolError("action must be approve or reject");
  const found = await pendingProposalById(store, id);
  if (!found) return toolError("proposal not found");
  const { key, proposal } = found;
  const reviewedAt = new Date().toISOString();
  let destination = null;

  if (action === "approve") {
    destination = normalizePath(destinationArg || proposal.intended_path);
    if (!destination || !destination.endsWith(".md")) {
      return toolError("invalid approval destination (must end in .md)");
    }
    if (isPlumbing(destination)) return toolError("that path is reserved");
    if (await store.get(destination)) {
      return toolError("conflict: approval destination already exists; choose a new destination or reject the proposal");
    }
    // Proposal approval is a personal review action and defaults private even
    // when the logical destination sits in a team-default folder.
    await persistExactVisibility(store, destination, "private", await loadScopeRules(store));
    await store.put(destination, proposal.content);
  }

  const reviewed = {
    ...proposal,
    status: action === "approve" ? "approved" : "rejected",
    reviewed_at: reviewedAt,
    final_path: destination,
    review_note: typeof reviewNote === "string" ? reviewNote.trim().slice(0, 2000) : "",
  };
  const reviewedKey =
    `${PROPOSAL_REVIEWED_PREFIX}${action === "approve" ? "approved" : "rejected"}/` +
    `${timestampSlug(new Date(reviewedAt))}-${proposal.id}.json`;
  await store.put(reviewedKey, JSON.stringify(reviewed));
  await store.delete(key);
  await recordChange(
    store,
    action === "approve" ? "approve_proposal" : "reject_proposal",
    scope,
    [destination || proposal.intended_path],
    { proposal_id: proposal.id, team_visible: false }
  );
  return toolText(
    action === "approve"
      ? `proposal approved: ${proposal.id}\ncreated: ${destination}\nvisibility: private`
      : `proposal rejected: ${proposal.id}\nintended path: ${proposal.intended_path}`
  );
}

/**
 * The fallback scan's key listing.
 *
 * `listAllNoteKeys` refuses to truncate, which is right for a move — a partial
 * answer there is a wrong answer — and wrong here. This path runs only because
 * the index was unusable, and an unbounded walk over a large bucket is the
 * failure the index exists to remove, arriving through the recovery route. So
 * it is bounded, and its truncation is carried into what the caller prints.
 */
async function listScannableNoteKeys(store, prefix) {
  if (prefix) {
    try {
      return await listBoundedKeys(store, prefix, FALLBACK_LIST_PAGE_CAP);
    } catch (error) {
      if (!error?.[BUDGET_EXHAUSTED]) throw error;
      return { keys: [], truncated: true };
    }
  }
  const keys = [];
  let truncated = false;
  try {
    const root = await listImmediateLayout(store);
    keys.push(...root.objects);
    for (const childPrefix of root.prefixes) {
      const walk = await listBoundedKeys(store, childPrefix, FALLBACK_LIST_PAGE_CAP);
      if (walk.truncated) truncated = true;
      keys.push(...walk.keys);
    }
  } catch (error) {
    // Out of budget partway through the walk: keep what was listed and say the
    // total is a floor, exactly as a truncated page does.
    if (!error?.[BUDGET_EXHAUSTED]) throw error;
    truncated = true;
  }
  return { keys, truncated };
}

/**
 * Budget exhaustion inside the fallback, as a thrown sentinel the scan's own
 * callers catch and report as truncation — never as a dead request.
 */
const BUDGET_EXHAUSTED = Symbol("search budget exhausted");

/**
 * The fallback's storage calls go through the same counter the indexed path
 * used. Its listing helpers (`listImmediateLayout`, `listBoundedKeys`) predate
 * the budget and page freely, and un-counted listings are how the recovery
 * route re-creates the very "Too many subrequests" failure it exists to
 * survive: a bucket with enough top-level folders spends two pages on each of
 * them before the first note is read.
 */
function budgetedStore(store, budget, reserve = 0) {
  const spend = () => {
    if (budget.take(reserve)) return;
    const error = new Error("search budget exhausted");
    error[BUDGET_EXHAUSTED] = true;
    throw error;
  };
  return {
    get(key) {
      spend();
      return store.get(key);
    },
    list(options) {
      spend();
      return store.list(options);
    },
  };
}

/**
 * The literal substring scan, kept as the recovery path for a search whose
 * index is unusable — a corrupt object the pass could not replace, a storage
 * error mid-sync, a bucket nothing has indexed yet.
 *
 * Its cap is now a real one. `SEARCH_FILE_CAP = 400` was eight times the
 * per-invocation subrequest limit, which is why it never truncated in testing
 * and always failed in production.
 */
async function scanVisibleNotes(store, scope, rules, overrides, query, prefix, budget, reserve = 0) {
  const needle = query.toLowerCase();
  const bounded = budget ? budgetedStore(store, budget, reserve) : store;
  const listed = await listScannableNoteKeys(bounded, prefix);
  // `isPlumbing` explicitly, not as a side effect of which lister ran.
  // `canSee` answers *true* for `privacy.md` at private scope — deliberately,
  // because the manifest is the owner's to read — so the manifest reached a
  // prefixed scan through the old `listAllKeys` path, and would have reached
  // an unprefixed one here. A search result is the note surface; the manifest
  // is not on it, at any scope.
  const keys = listed.keys.filter(
    ({ key }) => key.endsWith(".md") && !isPlumbing(key) && canSee(key, scope, rules, overrides)
  );
  const cap = Math.max(
    0,
    Math.min(budget ? budget.remaining - reserve : FALLBACK_SCAN_CAP, FALLBACK_SCAN_CAP)
  );
  const scanned = keys.slice(0, cap);
  const hits = [];
  // Reads the budget refused, so `scannedCount` counts notes actually read —
  // "scanned 12 of 40" must never describe a scan that stopped at 9.
  let refused = 0;
  for (let start = 0; start < scanned.length && hits.length < SEARCH_RESULT_LIMIT; start += 32) {
    const batch = scanned.slice(start, start + 32);
    const matches = await mapInBatches(batch, 32, async ({ key }) => {
      let obj;
      try {
        obj = await bounded.get(key);
      } catch (error) {
        if (!error?.[BUDGET_EXHAUSTED]) throw error;
        refused += 1;
        return null;
      }
      if (!obj) return null;
      const text = await obj.text();
      if (!text.toLowerCase().includes(needle)) return null;
      const snippets = text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .slice(0, 3)
        .map((line) => line.trim().slice(0, 200));
      return { key, title: noteTitle(key, text), snippets };
    });
    for (const match of matches) {
      if (match) hits.push(match);
      if (hits.length >= SEARCH_RESULT_LIMIT) break;
    }
  }
  return {
    hits,
    scannedCount: scanned.length - refused,
    totalCount: keys.length,
    // A total the listing did not finish measuring is a floor, like every other
    // count in this worker — and a scan the budget cut short leaves one too.
    totalIsFloor: listed.truncated || refused > 0,
  };
}

/**
 * The one search path, shared by `search_notes` and the ChatGPT-dialect
 * `search`. Splitting it from the formatting is what keeps the two tools
 * incapable of disagreeing about what a query matches — the difference between
 * them is only the shape of the answer.
 *
 * The indexed answer itself is `searchIndexedNotes`, in `search/visible.js`,
 * so that the console can ask the same question of the same bucket without
 * there being a second search. Everything specific to *this* surface stays
 * here: the gateway's privacy engine bound into the two predicates, the
 * subrequest budget the whole invocation shares, and the literal scan that
 * answers when there is no usable index — a fallback a Worker can afford
 * because the alternative is telling somebody their note does not exist.
 */
async function searchVisibleNotes(store, scope, rules, overrides, query, prefix) {
  // Request-scoped metadata on the per-request store, same as `store.actor`:
  // the tool layer never sees `env`, and a fresh store is built per request, so
  // nothing here survives into another tenant's call.
  const budget = createSearchBudget(store.searchSubrequestBudget ?? SEARCH_SUBREQUEST_BUDGET);
  const isIndexable = (key) => key.endsWith(".md") && !isPlumbing(key);
  const trace = createSearchTrace();
  trace.set("workspace", store.actor?.workspaceId);
  trace.set("grant", store.actor?.grantId);
  trace.set("client", store.actor?.clientId);
  trace.set("provider", store.provider);
  trace.set("budget", budget.remaining);
  trace.set("prefixed", Boolean(prefix));

  const answered = trace.span("answer");
  const found = await searchIndexedNotes(store, {
    // The gateway's own privacy engine, bound to this caller's scope. Passed in
    // rather than imported by that module, because the control plane holds a
    // ported copy of these two — see `search/visible.js` on why injecting them
    // composes two proven-identical implementations rather than inventing a
    // third.
    isVisible: (path) => canSee(path, scope, rules, overrides),
    isIndexable,
    query,
    prefix,
    budget,
    // A person asking a question is the one caller allowed to buy a listing,
    // and only when the answer came back empty over an index that believes it
    // is current. See `searchIndexedNotes`: a miss may pay for a listing, a hit
    // never does.
    refreshOnMiss: true,
  });
  answered();

  if (found.indexed) {
    trace.set("indexed", true);
    trace.set("hits", found.hits.length);
    trace.set("matches", found.matchCount);
    trace.set("matchesIsFloor", Boolean(found.matchCountIsFloor));
    trace.set("index", found.index);
    // Read before the maintenance pass is started, because starting it spends
    // its first op synchronously — this number is what the caller waited for,
    // and folding the background half into it would make the trace unable to
    // say which is which.
    trace.set("spent", budget.spent);
    trace.set("maintain", await maintainIndexAfter(store, budget, isIndexable, found));
    logSearchTrace(trace);
    return {
      hits: found.hits,
      matchCount: found.matchCount,
      matchCountIsFloor: found.matchCountIsFloor,
      indexIncomplete: found.indexIncomplete,
      degraded: false,
    };
  }

  // Recovery: whatever is left of the invocation, spent on the literal scan. A
  // bucket nothing has indexed yet must never be answered "(no matches)" out of
  // an empty index.
  const scanned = trace.span("scan");
  const scan = await scanVisibleNotes(
    store,
    scope,
    rules,
    overrides,
    query,
    prefix,
    budget,
    // The pass that follows is what stops this path from being permanent, and
    // it has to be paid for **before** the scan spends rather than out of what
    // the scan happens to leave. Measured: on the free tier's budget of 40 a
    // 65-note bucket spent 33 ops proving the index was missing and had seven
    // left, one under `DEFERRED_SYNC_FLOOR` — so no pass ran, and the next
    // search scanned again, forever. A recovery path that cannot afford to end
    // itself is not a recovery path.
    DEFERRED_SYNC_FLOOR
  );
  scanned();
  trace.set("indexed", false);
  trace.set("hits", scan.hits.length);
  trace.set("scannedCount", scan.scannedCount);
  trace.set("totalCount", scan.totalCount);
  // The scan runs because there was no index to answer from, so building one is
  // exactly the work worth doing behind this response — and it is the only way
  // a bucket whose first pass could not finish ever stops paying for this path.
  trace.set("spent", budget.spent);
  trace.set("maintain", await maintainIndexAfter(store, budget, isIndexable, null));
  logSearchTrace(trace);
  return {
    hits: scan.hits,
    matchCount: scan.hits.length,
    matchCountIsFloor: scan.totalCount > scan.scannedCount,
    indexIncomplete: false,
    degraded: true,
    scannedCount: scan.scannedCount,
    totalCount: scan.totalCount,
    totalIsFloor: scan.totalIsFloor,
  };
}

/**
 * Bring the index a pass further — **after** the response has been sent.
 *
 * A search reads a ready index and does no maintenance of its own
 * (`searchIndexedNotes`), so this is where every listing, diff, note read and
 * shard write in the system now happens for a gateway caller. That is the
 * change: the person asking a question waits for a manifest, the shards their
 * terms could be in, and the notes being quoted, and for nothing else.
 *
 * Four properties are deliberate:
 *
 * - **It is the same sync, not a second maintenance path.** A background
 *   indexer with its own diff would be a second place for the index to be
 *   wrong, in exactly the way a second search path would be a second place for
 *   a visibility bug.
 * - **It never throws into the request.** A rejected `waitUntil` promise is a
 *   logged exception on an invocation whose response has already gone; a throw
 *   on the way *in* would be a failed search over a successful one.
 * - **A host that cannot defer still indexes**, and pays for it in latency
 *   rather than in coverage. `store.defer` is absent on a self-hosted shim that
 *   passes no `ctx`, and "no deferral" used to mean "the next search does the
 *   work interactively" — which it no longer does, so absent deferral would
 *   mean an index nothing ever builds. It runs inline instead, after the answer
 *   is assembled, capped at `INTERACTIVE_BACKFILL_OPS` note reads. Deferral is
 *   still an accelerator; what it accelerates is now the whole of the work.
 * - **A converged index is not re-listed on every search.** The manifest
 *   records when it was last listed, so a pass is worth starting only when the
 *   index says it is behind or when that record is older than
 *   `INDEX_RECONCILE_INTERVAL_MS` — a bucket also written by Obsidian and
 *   rclone has to be re-read on some clock, and a full listing per search
 *   against a request quota the customer is billed for is not it.
 *
 * @param {object} found the answer's own report, or `null` where there was no
 *   index to answer from — which is always work worth doing.
 * @returns {Promise<"deferred"|"inline"|"none">} for the trace, so an operator
 *   can tell "no work left" from "this host cannot defer".
 */
async function maintainIndexAfter(store, budget, isIndexable, found) {
  if (!indexNeedsAPass(found)) return "none";
  if (budget.remaining < DEFERRED_SYNC_FLOOR) return "none";
  const run = (options) =>
    syncShardedIndex(store, { budget, isIndexable, ...options }).catch(() => {
      // A storage failure after the answer is already out changes nothing about
      // the answer. The next search re-diffs from the manifest.
    });
  if (typeof store.defer === "function") {
    try {
      store.defer(run({}));
      return "deferred";
    } catch {
      // A host whose `waitUntil` refuses the work is a host that does not
      // defer, and falls through to doing it in front of the caller.
    }
  }
  // Awaited, which is the whole difference between this branch and the one
  // above. A host with no `waitUntil` has nothing keeping the invocation alive
  // past the response, so a promise left running there is a promise that may
  // simply be discarded — and an index nothing ever finishes building. The cap
  // is what keeps the resulting delay bounded.
  await run({ backfillOps: INTERACTIVE_BACKFILL_OPS });
  return "inline";
}

/**
 * Whether the index is behind enough to be worth a pass.
 *
 * `null` — no index at all — always is. Otherwise the answer's own freshness
 * report decides: anything incomplete, or a listing older than the reconcile
 * interval, because notes arrive in this bucket through Obsidian and rclone as
 * well as through us and nothing tells the gateway when they do.
 */
function indexNeedsAPass(found) {
  if (!found || !found.index) return true;
  if (found.indexIncomplete) return true;
  const listedAt = Date.parse(found.index.listedAt ?? "");
  if (!Number.isFinite(listedAt)) return true;
  return Date.now() - listedAt >= INDEX_RECONCILE_INTERVAL_MS;
}

async function toolSearchNotes(store, scope, rules, overrides, query, prefixArg) {
  if (!query || typeof query !== "string") return toolError("query required");
  const prefix = prefixArg ? normalizePath(prefixArg) : "";
  if (prefixArg && prefix === null) return toolError("invalid prefix");
  const found = await searchVisibleNotes(store, scope, rules, overrides, query, prefix);
  const hits = found.hits.map(({ key, snippets, title }) =>
    snippets.length
      ? `${key}\n${snippets.map((line) => `    ${line}`).join("\n")}`
      : // Indexed, then edited: it matched when it was indexed and its current
        // text does not carry the term. The title was actually read; a snippet
        // here would be invented.
        `${key}\n    ${title}`
  );
  // An empty search is the moment an agent decides the context is useless and
  // answers from its own head. It is almost always the wrong conclusion — the
  // note exists under a word the user would have used and this query did not —
  // so the miss says what to try instead of stopping the sentence at "no".
  let out = hits.length
    ? `${found.matchCount}${found.matchCountIsFloor ? "+" : ""} matching note${
        found.matchCount === 1 && !found.matchCountIsFloor ? "" : "s"
      }${hits.length < found.matchCount ? ` — the ${hits.length} best shown` : ""}\n\n${hits.join(
        "\n\n"
      )}`
    : "(no matches)\n\nA miss usually means the wrong word rather than the wrong assumption — " +
      "this searches the words in the notes, not their meaning. Before concluding it is not " +
      "written down: try the term the user would have typed, drop the prefix if you passed " +
      "one, or call orient / list_notes to see which folders exist. And if the note is long, " +
      `a note is indexed by its opening ${NOTE_INDEX_CHAR_CAP.toLocaleString("en-US")} characters, ` +
      "so a term deep inside a saved session or a long log will not match here even though " +
      "read_note returns the whole file.";
  // The floor, in the language the census and orient already use. Deliberately
  // no number: how many notes are still unindexed is a fact about the whole
  // bucket, private notes included, and this connection may not be able to see
  // them.
  if (found.indexIncomplete) {
    out +=
      "\n\n[note: the search index is still catching up on this context, so these results may " +
      "be incomplete — searching again continues the backfill]";
  }
  if (found.degraded && found.totalCount > found.scannedCount) {
    out += `\n\n[note: scanned ${found.scannedCount} of ${found.totalCount}${
      found.totalIsFloor ? "+" : ""
    } notes — narrow with a prefix if needed]`;
  }
  return toolText(out);
}

/* ------------------- the ChatGPT dialect: search and fetch ----------------- */

/**
 * `search` and `fetch` are the same capabilities as `search_notes` and
 * `read_note`, wearing the one tool contract ChatGPT's ordinary chats can use.
 *
 * Outside developer mode, ChatGPT invokes exactly two tools on a custom
 * connector — ones literally named `search` and `fetch`, speaking OpenAI's
 * deep-research shape: `search(query)` answers one text block of JSON
 * `{"results":[{id,title,text,url}]}`, and `fetch(id)` answers
 * `{id,title,text,url,metadata}`. Every other tool on the connector is
 * invisible to those chats, which is why a beautifully described `orient` was
 * never called unprompted there: the failure was never persuasion, the tools
 * could not be reached. Verified live before this existed — asked "who is my
 * sister?", ChatGPT ranked Gmail and Contacts and never considered this
 * connector until named.
 *
 * Both go through the same visibility filtering as everything else — the scan
 * is literally `scanVisibleNotes`, shared with `search_notes` — so this
 * dialect discloses nothing the ordinary one would not.
 *
 * A note has no public URL the gateway can name, so `url` is a
 * `context://note/...` URI: stable, unique per result as the contract wants,
 * resolving nowhere on purpose.
 *
 * An owner can now mint an unlisted link to one note from their console, so
 * "there is no public URL" — what this comment used to say — is no longer the
 * reason. The reason is stronger: that link is a 64-hex token the owner handed
 * to somebody deliberately, this connection is not told which notes have one,
 * and putting one here would republish it into every search result. An https
 * URL invented for a note that has no link would imply a page that does not
 * exist.
 */
function noteUrl(path) {
  return `context://note/${encodeURI(path)}`;
}

/** The first heading if the note has one, else its filename. */
async function toolOpenAiSearch(store, scope, rules, overrides, query) {
  if (!query || typeof query !== "string") return toolError("query required");
  const { hits } = await searchVisibleNotes(store, scope, rules, overrides, query, "");
  // Titles come from the text already fetched for the snippets, so a result
  // costs no read of its own. This used to spend a second GET per hit, which
  // doubled the most expensive part of the old scan.
  const results = hits.map(({ key, title, snippets }) => ({
    id: key,
    title,
    text: (snippets.length ? snippets.join(" … ") : title).slice(0, 400),
    url: noteUrl(key),
  }));
  return toolText(JSON.stringify({ results }));
}

async function toolOpenAiFetch(store, scope, rules, overrides, idArg) {
  const path = normalizePath(idArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid id");
  if (isPlumbing(path)) return toolError("not found");
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  const text = await obj.text();
  return toolText(
    JSON.stringify({
      id: path,
      title: noteTitle(path, text),
      text,
      url: noteUrl(path),
      metadata: { etag: obj.etag },
    })
  );
}

async function toolArchiveNote(store, scope, rules, overrides, pathArg, expectedEtag) {
  const path = normalizePath(pathArg);
  if (!path) return toolError("invalid path");
  if (!canSee(path, scope, rules, overrides)) return toolError("not found");
  // The destination is `4-archive/`, and that folder is the owner's to have or
  // not have. On a context whose manifest declares one — every PARA scaffold —
  // this works exactly as it always did. On a custom layout it used to invent
  // the folder, which is the same layout assumption `save_context` and the
  // connect instructions were purged of: an agent "tidying up" would create a
  // top-level folder the owner deliberately did not choose, in a bucket they
  // also see in Obsidian. Refusing is honest and loses nothing: `move_note`
  // reaches whatever folder this context actually uses for inactive material,
  // and the front page says which that is.
  if (!manifestHasArchive(rules)) {
    return toolError(
      "this context has no 4-archive folder — its layout is its owner's, and archiving must " +
        "not invent one. Use move_note to the folder this context keeps inactive material in " +
        "(orient and the front page state its conventions), or ask the owner to add a " +
        "4-archive rule to privacy.md."
    );
  }
  if (path.startsWith("4-archive/")) return toolText("already archived");
  const obj = await store.get(path);
  if (!obj) return toolError("not found");
  if (scope !== "private" && !expectedEtag) {
    return toolError("expected_etag is required when a team connection archives a note; read the note and retry");
  }
  if (expectedEtag && obj.etag !== expectedEtag) {
    return toolError(
      `conflict: note changed since you read it (current etag ${obj.etag}); re-read and retry`
    );
  }
  const stamp = timestampSlug();
  const dest = `4-archive/${stamp}/${path}`;
  const destinationVisibility = scope === "private" ? "private" : "team";
  if (scope !== "private" && visibilityOf(dest, rules) !== "team") {
    return writePermissionError("archive destination");
  }
  if (await store.get(dest)) return toolError("conflict: archive destination already exists");
  const body = await obj.arrayBuffer();
  await store.put(`${HISTORY_PREFIX}${path}.${stamp}.archive.md`, body);
  if (destinationVisibility === "private") {
    await persistExactVisibility(store, dest, "private", rules);
  }
  await store.put(dest, body);
  if (destinationVisibility === "team") {
    await persistExactVisibility(store, dest, "team", rules);
  }
  await store.delete(path);
  await clearExactVisibility(store, path);
  await recordChange(store, "archive_note", scope, [path, dest], {
    visibility: destinationVisibility,
    team_visible: destinationVisibility === "team",
  });
  return toolText(`archived: ${path} → ${dest}\nvisibility: ${destinationVisibility}`);
}

async function toolMoveNote(store, scope, rules, overrides, sourceArg, destinationArg, expectedSourceEtag) {
  const source = normalizePath(sourceArg);
  const destination = normalizePath(destinationArg);
  if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
    return toolError("invalid path (source and destination must end in .md)");
  }
  if (source === destination) return toolText("source and destination are the same");
  if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
  if (!canSee(source, scope, rules, overrides)) return toolError("not found");
  if (scope !== "private" && visibilityOf(destination, rules) !== "team") {
    return writePermissionError("move destination");
  }
  if (scope === "team" && hasOverride(overrides, destination)) {
    return writePermissionError("move destination");
  }

  const sourceObject = await store.get(source);
  if (!sourceObject) return toolError("not found");
  if (expectedSourceEtag && sourceObject.etag !== expectedSourceEtag) {
    return toolError(
      `conflict: source changed since you read it (current etag ${sourceObject.etag}); re-read and retry`
    );
  }
  if (await store.get(destination)) return toolError("conflict: destination already exists");

  const body = await sourceObject.arrayBuffer();
  const sourceVisibility = effectiveVisibility(source, rules, overrides);
  const destinationVisibility =
    sourceVisibility === "private" || visibilityOf(destination, rules) === "private"
      ? "private"
      : "team";
  const stamp = timestampSlug();
  await store.put(`${HISTORY_PREFIX}${source}.${stamp}.move.md`, body);
  if (destinationVisibility === "private") {
    await persistExactVisibility(store, destination, "private", rules);
  }
  const put = await store.put(destination, body);
  if (destinationVisibility === "team") {
    await persistExactVisibility(store, destination, "team", rules);
  }
  await store.delete(source);
  await clearExactVisibility(store, source);
  await recordChange(store, "move_note", scope, [source, destination], {
    etag: put.etag,
    visibility: destinationVisibility,
    team_visible: sourceVisibility === "team" && destinationVisibility === "team",
  });
  return toolText(
    `moved: ${source} → ${destination} (etag ${put.etag})\nvisibility: ${destinationVisibility}`
  );
}

async function toolMoveNotes(store, scope, rules, overrides, movesArg, dryRun) {
  if (!Array.isArray(movesArg) || movesArg.length < 1) return toolError("moves must be a non-empty array");
  if (movesArg.length > BATCH_MOVE_CAP) {
    return toolError(`batch has more than ${BATCH_MOVE_CAP} moves; split it into smaller batches`);
  }

  const moves = [];
  for (const raw of movesArg) {
    const source = normalizePath(raw?.source);
    const destination = normalizePath(raw?.destination);
    if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
      return toolError("invalid path (every source and destination must end in .md)");
    }
    if (source === destination) return toolError(`source and destination are the same: ${source}`);
    if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
    moves.push({ source, destination, expectedSourceEtag: raw.expected_source_etag });
  }

  const sources = new Set(moves.map((move) => move.source));
  const destinations = new Set(moves.map((move) => move.destination));
  if (sources.size !== moves.length) return toolError("batch contains a duplicate source");
  if (destinations.size !== moves.length) return toolError("batch contains a duplicate destination");
  if (moves.some((move) => sources.has(move.destination))) {
    return toolError("batch destinations cannot also be batch sources; split cycles or chains into separate moves");
  }
  if (!dryRun && moves.some((move) => !move.expectedSourceEtag)) {
    return toolError(
      "expected_source_etag is required for every applied batch move. Run with dry_run=true to obtain current etags."
    );
  }

  const preflight = [];
  for (const move of moves) {
    if (!canSee(move.source, scope, rules, overrides)) return toolError(`not found: ${move.source}`);
    if (scope !== "private" && visibilityOf(move.destination, rules) !== "team") {
      return writePermissionError(`move destination ${move.destination}`);
    }
    if (scope === "team" && hasOverride(overrides, move.destination)) {
      return writePermissionError("move destination");
    }
    const sourceObject = await store.get(move.source);
    if (!sourceObject) return toolError(`not found: ${move.source}`);
    if (move.expectedSourceEtag && sourceObject.etag !== move.expectedSourceEtag) {
      return toolError(
        `conflict: ${move.source} changed since it was read (current etag ${sourceObject.etag})`
      );
    }
    const sourceVisibility = effectiveVisibility(move.source, rules, overrides);
    const destinationFolderVisibility = visibilityOf(move.destination, rules);
    const destinationVisibility =
      sourceVisibility === "private" || destinationFolderVisibility === "private"
        ? "private"
        : "team";
    const fastArchiveCandidate =
      move.source.startsWith("4-archive/") &&
      move.destination.startsWith("4-archive/") &&
      !hasOverride(overrides, move.source) &&
      sourceVisibility === destinationFolderVisibility;
    const destinationObject = await store.get(move.destination);
    let preloadedBody = null;
    if (destinationObject) {
      const [sourceText, destinationText] = await Promise.all([
        sourceObject.text(),
        destinationObject.text(),
      ]);
      if (destinationText !== sourceText) {
        return toolError(`conflict: destination already exists with different content: ${move.destination}`);
      }
      if (fastArchiveCandidate) preloadedBody = sourceText;
    } else if (fastArchiveCandidate) {
      preloadedBody = await sourceObject.arrayBuffer();
    }
    preflight.push({
      ...move,
      etag: sourceObject.etag,
      visibility: destinationVisibility,
      destinationExists: Boolean(destinationObject),
      fastArchiveCandidate,
      body: preloadedBody,
    });
  }

  const planText = preflight
    .map(
      (move) =>
        `- ${move.source} (etag ${move.etag}) → ${move.destination} [${move.visibility}]`
    )
    .join("\n");
  if (dryRun) return toolText(`preflight ok: ${preflight.length} moves\n${planText}`);

  const fastArchiveRelocation = preflight.every((move) => move.fastArchiveCandidate);
  if (!fastArchiveRelocation) {
    for (const move of preflight) {
      const sourceObject = await store.get(move.source);
      if (!sourceObject || sourceObject.etag !== move.etag) {
        return toolError(`conflict: source changed during batch preflight: ${move.source}`);
      }
      move.body = await sourceObject.arrayBuffer();
    }
  }

  const stamp = timestampSlug();
  if (!fastArchiveRelocation) {
    try {
      for (const move of preflight) {
        await store.put(`${HISTORY_PREFIX}${move.source}.${stamp}.batch-move.md`, move.body);
      }
    } catch (error) {
      return toolError(`batch move aborted before copying destinations: history snapshot failed: ${error.message}`);
    }
  }

  const copied = [];
  const preparedAcls = [];
  try {
    for (const move of preflight) {
      if (!fastArchiveRelocation && move.visibility === "private") {
        await persistExactVisibility(store, move.destination, "private", rules);
        preparedAcls.push(move.destination);
      }
      if (!move.destinationExists) {
        await store.put(move.destination, move.body);
        // Recorded the moment it exists, and BEFORE the visibility write that
        // can throw. The other order makes the one destination whose persist
        // failed the one destination the rollback below cannot see — so the
        // abort message says "aborted before deleting sources" over a copy that
        // is still there. Only a CAS exhaustion reaches it — a folded-twin
        // backstop briefly made it caller-reachable, and that backstop is not
        // in this change. The ordering is kept anyway: it is correct either
        // way, and it is what the refusals will need when they return.
        copied.push(move.destination);
      }
      if (!fastArchiveRelocation && move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
      }
    }
  } catch (error) {
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    for (const key of preparedAcls) await clearExactVisibility(store, key).catch(() => {});
    return toolError(`batch move aborted before deleting sources: ${error.message}`);
  }

  try {
    for (const move of preflight) await store.delete(move.source);
  } catch (error) {
    for (const move of preflight) await store.put(move.source, move.body).catch(() => {});
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    // `copied` holds only destinations this batch CREATED. A destination that
    // already existed got a private ACL written for it and is not in that list,
    // so without this loop a "rolled back" move leaves a pre-existing team note
    // un-shared, silently. The catch above already did this; this one did not.
    for (const key of preparedAcls) await clearExactVisibility(store, key).catch(() => {});
    return toolError(`batch move rolled back after a source-delete failure: ${error.message}`);
  }

  if (!fastArchiveRelocation) {
    for (const move of preflight) await clearExactVisibility(store, move.source).catch(() => {});
  }

  await recordChange(
    store,
    "move_notes",
    scope,
    preflight.flatMap((move) => [move.source, move.destination]),
    {
      count: preflight.length,
      history_snapshot: !fastArchiveRelocation,
      visibilities: preflight.map((move) => ({ path: move.destination, visibility: move.visibility })),
      team_visible: preflight.every((move) => move.visibility === "team"),
    }
  );
  return toolText(`moved notes: ${preflight.length}\n${planText}`);
}

async function toolMoveFolder(store, scope, rules, overrides, sourceArg, destinationArg, dryRun) {
  const source = normalizePath(sourceArg)?.replace(/\/+$/, "");
  const destination = normalizePath(destinationArg)?.replace(/\/+$/, "");
  if (!source || !destination) return toolError("invalid folder path");
  if (source === destination) return toolText("source and destination are the same");
  if (
    isPlumbing(source) ||
    isPlumbing(destination) ||
    source.startsWith(destination + "/") ||
    destination.startsWith(source + "/")
  ) {
    return toolError("source and destination folders must be separate, non-reserved trees");
  }

  const sourcePrefix = `${source}/`;
  const destinationPrefix = `${destination}/`;
  // Invisible content is filtered out, not refused on.
  //
  // Refusing the whole move because the tree contains something this
  // connection cannot see reports a fact about content the connection is not
  // allowed to know exists. With dry_run it costs nothing to ask, so a team
  // caller could walk the tree and separate "folder I can move" from "folder
  // with a private note in it" from "folder that does not exist" — localising
  // every private note to its containing folder without reading one. SECURITY.md
  // counts inference as a privacy-tier bypass in its own right.
  //
  // Filtering is also what `move_notes` already does with the same paths: a
  // team caller naming each visible note explicitly moves exactly these
  // objects and leaves the private ones behind. move_folder is the bulk
  // spelling of that operation, so it behaves the same way rather than
  // becoming the one tool that answers a question the others refuse.
  const allObjects = (await listAllKeys(store, sourcePrefix))
    .filter(({ key }) => !isPlumbing(key))
    .filter(({ key }) => canSee(key, scope, rules, overrides));
  // A folder holding nothing this caller can see is "not found" — byte-identical
  // to a folder that was never there.
  if (!allObjects.length) return toolError("not found");
  if (allObjects.length > FOLDER_MOVE_CAP) {
    return toolError(`folder has more than ${FOLDER_MOVE_CAP} objects; split it into smaller moves`);
  }

  const moves = allObjects.map(({ key }) => {
    const destinationPath = destinationPrefix + key.slice(sourcePrefix.length);
    const sourceVisibility = effectiveVisibility(key, rules, overrides);
    const destinationVisibility =
      sourceVisibility === "private" || visibilityOf(destinationPath, rules) === "private"
        ? "private"
        : "team";
    return { source: key, destination: destinationPath, visibility: destinationVisibility };
  });
  if (
    scope !== "private" &&
    moves.some(({ destination: path }) => visibilityOf(path, rules) !== "team")
  ) {
    return writePermissionError("folder move destination");
  }
  if (scope === "team" && moves.some(({ destination: path }) => hasOverride(overrides, path))) {
    return writePermissionError("folder move destination");
  }
  for (const move of moves) {
    if (await store.get(move.destination)) {
      return toolError(`conflict: destination already exists: ${move.destination}`);
    }
  }

  if (dryRun) {
    return toolText(
      `preflight ok: folder ${source}/ → ${destination}/ (${moves.length} objects)\n` +
        moves
          .map((move) => `- ${move.source} → ${move.destination} [${move.visibility}]`)
          .join("\n")
    );
  }

  const copied = [];
  const preparedAcls = [];
  const sourceBodies = [];
  try {
    for (const move of moves) {
      const obj = await store.get(move.source);
      if (!obj) throw new Error(`source changed during move: ${move.source}`);
      const body = await obj.arrayBuffer();
      sourceBodies.push({ ...move, body });
      if (move.visibility === "private") {
        await persistExactVisibility(store, move.destination, "private", rules);
        preparedAcls.push(move.destination);
      }
      await store.put(move.destination, body);
      // Before the visibility write that can throw — see `move_notes` above.
      copied.push(move.destination);
      if (move.visibility === "team") {
        await persistExactVisibility(store, move.destination, "team", rules);
      }
    }
  } catch (error) {
    for (const key of copied) {
      await store.delete(key).catch(() => {});
      await clearExactVisibility(store, key).catch(() => {});
    }
    for (const key of preparedAcls) await clearExactVisibility(store, key).catch(() => {});
    return toolError(`move aborted before deleting sources: ${error.message}`);
  }

  const stamp = timestampSlug();
  for (const item of sourceBodies) {
    await store.put(`${HISTORY_PREFIX}${item.source}.${stamp}.move.md`, item.body);
  }
  for (const { source: path } of moves) await store.delete(path);
  for (const { source: path } of moves) await clearExactVisibility(store, path).catch(() => {});
  await recordChange(store, "move_folder", scope, [source, destination], {
    count: moves.length,
    visibilities: moves.map((move) => ({ path: move.destination, visibility: move.visibility })),
    team_visible: moves.every((move) => move.visibility === "team"),
  });
  return toolText(`moved folder: ${source}/ → ${destination}/ (${moves.length} objects)`);
}

/* -------------------------------- inbox ---------------------------------- */

async function handleInbox(request, env, store, session) {
  // The grant's own context, and no other. This path takes no `context`
  // argument, and the store it is handed was built without an opener at all —
  // so the credential that sits unattended on a laptop reaches exactly one
  // context, which is the whole of what makes a capture-only grant cheap.
  store.actor = actorFor(session);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }

  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }
  const raw = new TextDecoder().decode(rawBytes);

  let capture = { title: "capture", text: "", source: "inbox" };
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_json" }, 400);
    }
    capture = {
      title: body.title || "capture",
      text: body.text ?? body.content ?? body.notes ?? "",
      source: body.source || "inbox",
      externalId: body.external_id ?? body.id ?? "",
      sourceUrl: body.source_url ?? body.url ?? "",
      sourceCreatedAt: body.source_created_at ?? body.created_at ?? "",
      attendees: body.attendees,
      metadata: body.metadata ?? null,
    };
  } else {
    capture.text = raw;
  }
  if (!String(capture.text).trim()) return json({ error: "empty" }, 400);

  // A capture-only grant records as "inbox"; a full connection that happens to
  // POST a capture records as itself, so the audit trail distinguishes an
  // automation drop from a person filing something by hand.
  const actorScope = hasScope(session, SCOPE_READ) ? session.scope : "inbox";
  const result = await writeInboxCapture(store, capture, { actorScope });
  return json({ ok: true, ...result });
}

async function writeInboxCapture(store, capture, { actorScope = "inbox", replaceExisting = false } = {}) {
  const now = new Date();
  const title = singleLine(capture.title || "capture");
  const text = String(capture.text ?? "");
  const source = singleLine(capture.source || "inbox");
  const externalId = singleLine(capture.externalId || "");
  const sourceUrl = singleLine(capture.sourceUrl || "");
  const sourceCreatedAt = singleLine(capture.sourceCreatedAt || "");
  const attendees = normalizeInboxAttendees(capture.attendees);
  const metadata = capture.metadata ?? null;
  const sourceSlug = safeSlug(source, 30);
  let key;
  if (externalId) {
    const fingerprint = await sha256Hex(`${source}\0${externalId}`);
    key = `0-inbox/${sourceSlug}/${fingerprint.slice(0, 24)}.md`;
  } else {
    const titleSlug = safeSlug(title, 40);
    key = `0-inbox/${now.toISOString().slice(0, 19).replace(/[:]/g, "-")}-${titleSlug}.md`;
  }

  const existing = await store.get(key);
  if (existing && !replaceExisting) return { path: key, duplicate: true };

  const frontmatter = [
    "---",
    `captured: ${JSON.stringify(now.toISOString())}`,
    `source: ${JSON.stringify(source)}`,
    "status: unprocessed",
  ];
  if (externalId) frontmatter.push(`external-id: ${JSON.stringify(externalId)}`);
  if (sourceCreatedAt) frontmatter.push(`source-created-at: ${JSON.stringify(sourceCreatedAt)}`);
  if (sourceUrl) frontmatter.push(`source-url: ${JSON.stringify(sourceUrl)}`);
  frontmatter.push("---");

  const bodyParts = [`# ${title}`, ""];
  if (sourceUrl) bodyParts.push(`Source: <${sourceUrl}>`, "");
  if (attendees.length) {
    bodyParts.push("## Attendees", "", ...attendees.map((attendee) => `- ${attendee}`), "");
  }
  bodyParts.push(text.trim(), "");
  if (metadata !== null && metadata !== "") {
    const metadataText =
      typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2);
    bodyParts.push("## Capture metadata", "", "```json", metadataText, "```", "");
  }

  const note = `${frontmatter.join("\n")}\n\n${bodyParts.join("\n")}`;
  if (existing) {
    const previous = await existing.text();
    if (previous === note) return { path: key, duplicate: true };
    await store.put(`${HISTORY_PREFIX}${key}.${timestampSlug()}.inbox.md`, previous);
  }
  await store.put(key, note);
  await recordChange(store, existing ? "inbox_update" : "inbox_capture", actorScope, [key], { source });
  return { path: key, duplicate: false, updated: Boolean(existing) };
}

function singleLine(value) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function safeSlug(value, maxLength) {
  return singleLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength) || "capture";
}

function normalizeInboxAttendees(value) {
  if (Array.isArray(value)) {
    return value.map(formatInboxAttendee).filter(Boolean).slice(0, 200);
  }
  if (typeof value === "string") {
    return value.split(/[\n,;]+/).map(singleLine).filter(Boolean).slice(0, 200);
  }
  return [];
}

function formatInboxAttendee(value) {
  if (value && typeof value === "object") {
    const name = singleLine(value.name || "");
    const email = singleLine(value.email || "");
    if (name && email) return `${name} <${email}>`;
    return name || email;
  }
  return singleLine(value);
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* --------------------------- Granola webhooks ---------------------------- */

async function handleGranolaWebhook(request, env, store, ctx) {
  if (!env.GRANOLA_WEBHOOK_SECRET) return json({ error: "not_configured" }, 503);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const raw = new TextDecoder().decode(rawBytes);

  const signatureOk = await verifyGranolaSignature(request.headers, raw, env.GRANOLA_WEBHOOK_SECRET);
  if (!signatureOk) return json({ error: "invalid_signature" }, 401);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const eventId = singleLine(event?.event_id || "");
  const eventType = singleLine(event?.event_type || "");
  const noteId = singleLine(event?.note_id || "");
  if (
    !eventId ||
    !/^not_[a-zA-Z0-9]{14}$/.test(noteId) ||
    !["note.generated", "note.edited", "note.access_granted"].includes(eventType)
  ) {
    return json({ error: "invalid_event" }, 400);
  }

  const completedKey = `${GRANOLA_COMPLETED_PREFIX}${safeSlug(eventId, 80)}.json`;
  if (await store.get(completedKey)) return json({ ok: true, duplicate: true });

  const pendingKey = `${GRANOLA_PENDING_PREFIX}${safeSlug(eventId, 80)}.json`;
  await store.put(pendingKey, JSON.stringify({ ...event, received_at: new Date().toISOString() }));
  const work = processGranolaEventSafely(env, store, pendingKey);
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return json({ ok: true, accepted: true }, 202);
}

async function verifyGranolaSignature(headers, rawBody, signingSecret) {
  if (!signingSecret.startsWith("whsec_")) return false;
  const webhookId = headers.get("webhook-id") || "";
  const timestampText = headers.get("webhook-timestamp") || "";
  const signatureHeader = headers.get("webhook-signature") || "";
  const timestamp = Number(timestampText);
  if (!webhookId || !Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > GRANOLA_WEBHOOK_MAX_AGE_SECONDS) return false;

  let keyBytes;
  try {
    keyBytes = decodeBase64(signingSecret.slice("whsec_".length));
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signedContent = `${webhookId}.${timestampText}.${rawBody}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent))
  );
  const expected = encodeBase64(signature);
  return signatureHeader.split(/\s+/).some((candidate) => {
    const [version, provided = ""] = candidate.split(",");
    return version === "v1" && timingSafeEqual(provided, expected);
  });
}

/**
 * Constant-time string comparison, for the webhook HMAC above.
 *
 * The only remaining secret comparison in this worker. Access tokens are not
 * compared here at all — they are hashed and resolved by the control plane —
 * which is why this lives beside its one caller instead of in a shared auth
 * section that no longer exists.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i] ^ bb[i];
  return diff === 0;
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function processGranolaEventSafely(env, store, pendingKey) {
  try {
    await processGranolaEvent(env, store, pendingKey);
  } catch (error) {
    const pending = await store.get(pendingKey);
    if (!pending) return;
    let event = {};
    try {
      event = JSON.parse(await pending.text());
    } catch {}
    await store.put(
      pendingKey,
      JSON.stringify({
        ...event,
        attempts: Number(event.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: singleLine(error?.message || "Granola sync failed").slice(0, 300),
      })
    );
  }
}

async function processGranolaEvent(env, store, pendingKey) {
  if (!env.GRANOLA_API_KEY) throw new Error("GRANOLA_API_KEY is not configured");
  const pending = await store.get(pendingKey);
  if (!pending) return;
  const event = JSON.parse(await pending.text());
  const response = await fetch(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(event.note_id)}`, {
    headers: { Authorization: `Bearer ${env.GRANOLA_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Granola Get Note returned ${response.status}`);
  const note = await response.json();
  const text = note.summary_markdown || note.summary_text || "";
  if (!String(text).trim()) throw new Error("Granola note has no generated summary yet");

  await writeInboxCapture(
    store,
    {
      title: note.title || "Granola meeting",
      text,
      source: "granola",
      externalId: note.id || event.note_id,
      sourceUrl: note.web_url || "",
      sourceCreatedAt: note.created_at || event.occurred_at || "",
      attendees: note.attendees || [],
      metadata: {
        event_type: event.event_type,
        event_id: event.event_id,
        updated_at: note.updated_at || null,
        owner: note.owner || null,
        calendar_event: note.calendar_event || null,
        folders: note.folder_membership || [],
      },
    },
    { actorScope: "granola", replaceExisting: true }
  );

  const eventSlug = safeSlug(event.event_id, 80);
  await store.put(
    `${GRANOLA_COMPLETED_PREFIX}${eventSlug}.json`,
    JSON.stringify({ event_id: event.event_id, note_id: event.note_id, completed_at: new Date().toISOString() })
  );
  await store.delete(pendingKey);
}

async function processPendingGranolaEvents(env, store) {
  if (!env.GRANOLA_API_KEY) return;
  const pending = (await listAllKeys(store, GRANOLA_PENDING_PREFIX)).slice(0, 100);
  await Promise.all(pending.map(({ key }) => processGranolaEventSafely(env, store, key)));
}

/* ------------------------------- calendar --------------------------------- */

async function syncCalendar(env, store) {
  if (!env.CALENDAR_ICS_URL) return;
  const res = await fetch(env.CALENDAR_ICS_URL);
  if (!res.ok) return;
  const ics = await res.text();
  const now = Date.now();
  const horizon = now + 14 * 24 * 3600 * 1000;
  const events = expandCalendarEvents(
    parseIcs(ics),
    new Date(now - 24 * 3600 * 1000),
    new Date(horizon)
  );
  const upcoming = events
    .filter((e) => e.start && e.start.getTime() >= now - 24 * 3600 * 1000 && e.start.getTime() <= horizon)
    .sort((a, b) => a.start - b.start);

  const byDay = new Map();
  for (const e of upcoming) {
    const day = e.start.toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  let md = `---\nupdated: ${new Date().toISOString()}\nsource: calendar-cron\n---\n\n# Calendar — next 14 days\n\n`;
  md += `> Auto-generated from the calendar feed. Times are UTC unless the event was all-day.\n> Common recurring-event rules are expanded; unusually complex rules may be under-represented.\n\n`;
  if (!byDay.size) md += "_No events in the next 14 days._\n";
  for (const [day, list] of byDay) {
    md += `## ${day}\n`;
    for (const e of list) {
      const time = e.allDay ? "all day" : e.start.toISOString().slice(11, 16);
      md += `- ${time} — ${e.summary}${e.location ? ` @ ${e.location}` : ""}\n`;
    }
    md += "\n";
  }
  await store.put("2-areas/calendar/next-14-days.md", md);
  await recordChange(store, "calendar_sync", "system", ["2-areas/calendar/next-14-days.md"], {
    count: upcoming.length,
  });
}

function parseIcs(ics) {
  // Unfold continuation lines (RFC 5545 §3.1)
  const lines = ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const nameAndParams = line.slice(0, idx);
      const value = line.slice(idx + 1);
      const name = nameAndParams.split(";")[0];
      if (name === "SUMMARY") cur.summary = unescapeIcs(value);
      else if (name === "LOCATION") cur.location = unescapeIcs(value);
      else if (name === "UID") cur.uid = value;
      else if (name === "STATUS") cur.status = value;
      else if (name === "RRULE") cur.rrule = value;
      else if (name === "RECURRENCE-ID") cur.recurrenceId = parseIcsDate(value);
      else if (name === "EXDATE") {
        cur.exdates ||= [];
        cur.exdates.push(...value.split(",").map(parseIcsDate).filter(Boolean));
      } else if (name === "RDATE") {
        cur.rdates ||= [];
        cur.rdates.push(...value.split(",").map((v) => parseIcsDate(v.split("/")[0])).filter(Boolean));
      }
      else if (name === "DTSTART") {
        cur.allDay = nameAndParams.includes("VALUE=DATE") || /^\d{8}$/.test(value);
        cur.start = parseIcsDate(value);
      }
    }
  }
  return events;
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function expandCalendarEvents(events, windowStart, windowEnd) {
  const exceptions = new Map();
  for (const event of events) {
    if (!event.uid || !event.recurrenceId) continue;
    if (!exceptions.has(event.uid)) exceptions.set(event.uid, new Map());
    exceptions.get(event.uid).set(event.recurrenceId.getTime(), event);
  }

  const usedExceptions = new Set();
  const expanded = [];
  for (const event of events) {
    if (!event.start || event.recurrenceId || event.status === "CANCELLED") continue;
    const starts = event.rrule
      ? expandRecurrenceStarts(event, windowStart, windowEnd)
      : [event.start];
    for (const rdate of event.rdates || []) starts.push(rdate);

    const seenStarts = new Set();
    for (const recurrenceStart of starts.sort((a, b) => a - b)) {
      const recurrenceTime = recurrenceStart.getTime();
      if (seenStarts.has(recurrenceTime)) continue;
      seenStarts.add(recurrenceTime);
      if ((event.exdates || []).some((date) => date.getTime() === recurrenceTime)) continue;

      const exception = event.uid ? exceptions.get(event.uid)?.get(recurrenceTime) : null;
      if (exception) usedExceptions.add(exception);
      if (exception?.status === "CANCELLED") continue;

      const actualStart = exception?.start || recurrenceStart;
      if (actualStart < windowStart || actualStart > windowEnd) continue;
      expanded.push({
        ...event,
        ...exception,
        start: actualStart,
        summary: exception?.summary ?? event.summary,
        location: exception?.location ?? event.location,
        allDay: exception?.allDay ?? event.allDay,
        rrule: undefined,
        recurrenceId: undefined,
      });
    }
  }

  // A moved exception can land inside the window even when its original
  // occurrence is outside it, so include any such unconsumed exception.
  for (const event of events) {
    if (
      event.recurrenceId &&
      !usedExceptions.has(event) &&
      event.status !== "CANCELLED" &&
      event.start &&
      event.start >= windowStart &&
      event.start <= windowEnd
    ) {
      expanded.push({ ...event, recurrenceId: undefined });
    }
  }

  return expanded;
}

function expandRecurrenceStarts(event, windowStart, windowEnd) {
  const rule = parseRrule(event.rrule);
  if (!rule || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.freq)) {
    return [event.start];
  }

  const start = event.start;
  const until = rule.until || windowEnd;
  const scanEnd = until < windowEnd ? until : windowEnd;
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const lastDay = new Date(Date.UTC(scanEnd.getUTCFullYear(), scanEnd.getUTCMonth(), scanEnd.getUTCDate()));
  const matches = [];

  while (cursor <= lastDay) {
    const candidate = new Date(Date.UTC(
      cursor.getUTCFullYear(),
      cursor.getUTCMonth(),
      cursor.getUTCDate(),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds()
    ));
    if (candidate >= start && candidate <= until && matchesRecurrenceDate(candidate, start, rule)) {
      matches.push(candidate);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const positioned = applyBySetPos(matches, rule);
  const counted = rule.count ? positioned.slice(0, rule.count) : positioned;
  return counted.filter((date) => date >= windowStart && date <= windowEnd);
}

function parseRrule(text) {
  if (!text) return null;
  const values = {};
  for (const part of text.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) values[part.slice(0, idx)] = part.slice(idx + 1);
  }
  if (!values.FREQ) return null;
  const until = values.UNTIL ? parseIcsDate(values.UNTIL) : null;
  if (until && /^\d{8}$/.test(values.UNTIL)) until.setUTCHours(23, 59, 59, 999);
  const weekStart = WEEKDAYS.indexOf(values.WKST || "MO");
  return {
    freq: values.FREQ,
    interval: Math.max(1, Number.parseInt(values.INTERVAL || "1", 10) || 1),
    count: Math.max(0, Number.parseInt(values.COUNT || "0", 10) || 0),
    until,
    byday: parseByDay(values.BYDAY),
    bymonthday: parseNumberList(values.BYMONTHDAY),
    bymonth: parseNumberList(values.BYMONTH),
    bysetpos: parseNumberList(values.BYSETPOS),
    wkst: weekStart < 0 ? 1 : weekStart,
  };
}

function parseNumberList(value) {
  if (!value) return [];
  return value.split(",").map((item) => Number.parseInt(item, 10)).filter(Number.isFinite);
}

function parseByDay(value) {
  if (!value) return [];
  return value.split(",").map((item) => {
    const match = item.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
    return match
      ? { ordinal: Number.parseInt(match[1] || "0", 10), weekday: WEEKDAYS.indexOf(match[2]) }
      : null;
  }).filter(Boolean);
}

function matchesRecurrenceDate(candidate, start, rule) {
  const dayMs = 24 * 3600 * 1000;
  const dayDiff = Math.floor((startOfUtcDay(candidate) - startOfUtcDay(start)) / dayMs);
  const monthDiff =
    (candidate.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    candidate.getUTCMonth() - start.getUTCMonth();
  const yearDiff = candidate.getUTCFullYear() - start.getUTCFullYear();

  if (rule.bymonth.length && !rule.bymonth.includes(candidate.getUTCMonth() + 1)) return false;
  if (rule.bymonthday.length && !matchesMonthDay(candidate, rule.bymonthday)) return false;
  if (rule.byday.length && !matchesByDay(candidate, rule.byday, rule.freq, rule.bymonth.length > 0)) return false;

  if (rule.freq === "DAILY") return dayDiff % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const weekDiff = Math.floor(
      (startOfWeek(candidate, rule.wkst) - startOfWeek(start, rule.wkst)) / (7 * dayMs)
    );
    const allowedDays = rule.byday.length
      ? rule.byday.map((item) => item.weekday)
      : [start.getUTCDay()];
    return weekDiff % rule.interval === 0 && allowedDays.includes(candidate.getUTCDay());
  }
  if (rule.freq === "MONTHLY") {
    if (monthDiff % rule.interval !== 0) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  if (rule.freq === "YEARLY") {
    if (yearDiff % rule.interval !== 0) return false;
    if (!rule.bymonth.length && candidate.getUTCMonth() !== start.getUTCMonth()) return false;
    if (!rule.bymonthday.length && !rule.byday.length) {
      return candidate.getUTCDate() === start.getUTCDate();
    }
    return true;
  }
  return false;
}

function matchesMonthDay(date, values) {
  const day = date.getUTCDate();
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return values.some((value) => value > 0 ? day === value : day === daysInMonth + value + 1);
}

function matchesByDay(date, values, frequency, hasByMonth) {
  return values.some(({ ordinal, weekday }) => {
    if (date.getUTCDay() !== weekday) return false;
    if (!ordinal || frequency === "DAILY" || frequency === "WEEKLY") return true;
    if (frequency === "MONTHLY" || (frequency === "YEARLY" && hasByMonth)) {
      const ordinals = weekdayOrdinalsInMonth(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    if (frequency === "YEARLY") {
      const ordinals = weekdayOrdinalsInYear(date);
      return ordinal > 0 ? ordinal === ordinals.positive : ordinal === ordinals.negative;
    }
    return true;
  });
}

function weekdayOrdinalsInMonth(date) {
  const daysInMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  return {
    positive: Math.ceil(date.getUTCDate() / 7),
    negative: -Math.ceil((daysInMonth - date.getUTCDate() + 1) / 7),
  };
}

function weekdayOrdinalsInYear(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const nextYear = Date.UTC(date.getUTCFullYear() + 1, 0, 1);
  const dayOfYear = Math.floor((startOfUtcDay(date) - yearStart) / (24 * 3600 * 1000)) + 1;
  const daysInYear = Math.floor((nextYear - yearStart) / (24 * 3600 * 1000));
  return {
    positive: Math.ceil(dayOfYear / 7),
    negative: -Math.ceil((daysInYear - dayOfYear + 1) / 7),
  };
}

function applyBySetPos(matches, rule) {
  if (!rule.bysetpos.length) return matches;
  const groups = new Map();
  for (const date of matches) {
    const key = recurrencePeriodKey(date, rule);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(date);
  }
  const selected = [];
  for (const dates of groups.values()) {
    for (const position of rule.bysetpos) {
      const index = position > 0 ? position - 1 : dates.length + position;
      if (dates[index]) selected.push(dates[index]);
    }
  }
  return [...new Map(selected.map((date) => [date.getTime(), date])).values()].sort((a, b) => a - b);
}

function recurrencePeriodKey(date, rule) {
  if (rule.freq === "YEARLY") return `${date.getUTCFullYear()}`;
  if (rule.freq === "MONTHLY") return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
  if (rule.freq === "WEEKLY") return `${startOfWeek(date, rule.wkst)}`;
  return `${startOfUtcDay(date)}`;
}

function startOfUtcDay(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfWeek(date, weekStart) {
  const dayStart = startOfUtcDay(date);
  const offset = (date.getUTCDay() - weekStart + 7) % 7;
  return dayStart - offset * 24 * 3600 * 1000;
}

function parseIcsDate(v) {
  let mm = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (mm) {
    // Treat non-UTC (TZID) timestamps as UTC — approximate but predictable.
    return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]));
  }
  mm = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (mm) return new Date(Date.UTC(+mm[1], +mm[2] - 1, +mm[3]));
  return null;
}

function unescapeIcs(s) {
  return s.replace(/\\n/g, " · ").replace(/\\([,;\\])/g, "$1");
}

/* -------------------------------- helpers --------------------------------- */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      // GET is here for the two discovery documents, which a browser-based
      // client fetches cross-origin before it holds any credential at all.
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcErrorObj(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcError(id, code, message, status = 200) {
  return json(jsonRpcErrorObj(id, code, message), status);
}
