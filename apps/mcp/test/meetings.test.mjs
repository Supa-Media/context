/**
 * Meeting ingestion, end to end: the routes three devices send a meeting to,
 * the note it becomes in the customer's own bucket, and the ways all of that is
 * supposed to fail.
 *
 * The arrangement is the one where a mistake actually leaks: two workspaces on
 * the same S3 endpoint with adjacent bucket names, a session id issued in the
 * first, and a connection to the second that knows that id. Everything in the
 * isolation section is that neighbour trying to read it, write to it, finalize
 * it, and merely find out whether it exists — which is the one an existence
 * oracle gives away for free if the refusals are not identical.
 *
 * Offline and framework-free like the rest of the suite: a real control plane
 * stub over HTTP, a real S3 backend in memory, the real `S3Store` signing real
 * requests to it, and one `fetch` layer of our own on top that can fail a write
 * on demand — because "storage broke halfway through finalize" is not a
 * hypothetical for a product whose entire job is not to lose a meeting.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured
 * rather than as expected:
 *
 * 1. **The control plane hands the neighbour *our* binding**
 *    (`flags.bindingWorkspaceId = "ws_recorder"`, a control plane that resolved
 *    the wrong tenant) — 4 checks failed. This is the sabotage that matters
 *    here, because it is the only way a meeting route can reach another
 *    workspace's bucket at all: tenancy in this module is the *store* it is
 *    handed, never a key it builds, so there is no path prefix to get wrong.
 *    The gateway's own two-party check refuses and the isolation checks see it.
 * 2. **`notFound()` answers 403 instead of 404** — 3 checks failed. Worth
 *    recording precisely: the byte-identical-refusal check still *passed*,
 *    because both answers still come out of one code path. It is the status
 *    that carries the existence signal, and it is the status that caught it.
 * 3. **The meeting scope gate asks for `context:read` on every method** —
 *    4 checks failed: a read-only grant and a `member` role both wrote.
 * 4. **`finalizeSession` loses its "already complete" branch** — 5 checks
 *    failed, and not the ones expected. No second file appeared (the retry
 *    reuses the claimed path) — instead the second finalize re-rendered the
 *    note from the completion receipt, which by design holds no transcript and
 *    no notes, and *emptied a finished meeting*. Idempotency here is not a
 *    tidiness property; it is what stops a client's retry destroying the note.
 * 5. **`writeSession` drops `onlyIf` on a store that honours it** — 2 checks
 *    failed: the conflict a lost race must produce stopped being produced, and
 *    the second write stopped guarding the read it came from.
 * 6. **A meeting note is written at `team` whatever the connection's tier** —
 *    4 checks failed, all of them a private meeting reaching a team connection.
 * 7. **The team-connection destination check is removed from
 *    `publishMeetingNote`** — 5 checks failed: a team connection filed a
 *    meeting into a folder whose default is private, and the extra note it left
 *    behind failed three unrelated counts, which is what a stray write looks
 *    like from the rest of the suite.
 * 8. **`matchMeetingRoute` accepts any id shape** — 1 check failed.
 * 9. **`read_meeting` returns the whole file regardless of the argument** —
 *     3 checks failed: the transcript came back uninvited, with nothing said
 *     about it.
 * 10. **The client-event allow-list is removed, so a client may send
 *     `written`** — 2 checks failed. The first version of this check proved
 *     nothing and is worth recording: it forged the event against a *recording*
 *     session, which the transition table refuses on its own, so the guard
 *     could be deleted with the suite still green. Ending the session first
 *     makes `finalizing -> complete` a legal move and the allow-list the only
 *     thing standing between a client and a meeting marked finished that was
 *     never written.
 * 11. **`listSessions` ignores its limit** — 1 check failed.
 * 12. **`normalizeTranscription` coerces an unknown engine to `null` instead of
 *     refusing** — 2 checks failed: the refusal, and the session it then opened
 *     for an engine nobody has heard of. The note that meeting would become
 *     says `transcription: none` about audio that may well have left the
 *     device, which is the one direction this field is not allowed to be wrong
 *     in.
 * 13. **`withTranscription` lets a client rewrite the engine a session was
 *     opened with** — 2 checks failed. Deleting the call to it altogether fails
 *     1 instead: an unknown engine is still refused at `createSession`, so what
 *     the later-body path adds is exactly the refusal of a *rewrite*.
 * 14. **`completionReceipt` drops `transcription` with the transcript** —
 *     1 check failed. Cheap to get wrong, because the receipt is deliberately
 *     the place where almost everything is dropped; the note has the answer,
 *     but the receipt is what a client lists without opening one.
 * 15. **`finalizeSession` ignores `body.folder` and builds the inbox path from
 *     the module constant** — the defect §16 exists to close, put back — 9
 *     checks failed.
 * 16. **The folder is honoured on every finalize rather than only on the one
 *     that claims the path** (`if (!next.notePath)` relaxed to always
 *     recompute) — 3 checks failed, and they are the ones worth having: a
 *     retry after a failed note write, naming a second folder, wrote a
 *     **second note** and left the meeting in two places. The
 *     already-complete finalize did not fork, because that path returns before
 *     the claim — which is why the interesting test is the storage-failure
 *     retry and not the easy double-finalize.
 * 17. **A refused folder fails the finalize instead of falling back** —
 *     5 checks failed. `meeting_invalid` is the code a client does not retry,
 *     so this is somebody's forty minutes parked over one bad string.
 * 18. **The fallback happens and the ack never says so** — 2 checks failed.
 *     This is the sabotage that reads as harmless and is not: it is the
 *     original defect exactly, a destination control that appears to work and
 *     does nothing.
 * 19. **The ack reads the refused folder back to whoever sent it** — 1 check
 *     failed.
 * 20. **`folderRejected` means only "the string was malformed" again**, rather
 *     than "the folder you named is not where this note is" — 2 checks failed,
 *     both of them a client that asked for one folder, got another, and was
 *     answered 200 with nothing said. That is §18's defect surviving in the one
 *     shape §18 did not cover.
 * 21. **A claim is never released** (`releaseClaim` returns immediately) — 3
 *     checks failed: a team connection that named a folder its tier may not
 *     write stayed parked on that path, so even `finalize {}` was refused
 *     forever. That is the wedge `body.folder` introduced.
 * 22. **A claim is released on every failure, transient included** (both guards
 *     in `releaseClaim` removed) — 4 checks failed, and they are the crash-retry
 *     property: the retry after a failed note write stopped landing on the path
 *     the first finalize claimed and wrote a second note. Removing *only* the
 *     status check fails 1 — `a 503 refusal keeps the claim` — and removing
 *     *only* the `instanceof` check fails 0, because a thrown storage error
 *     carries no status either way. That last row is why the release table
 *     drives `handleMeetings` directly: the two failure shapes that decide this
 *     were both unreachable from the worker-level fixtures, and a first draft
 *     of the fix that released on a `MeetingRefusal(503)` went green.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import {
  LIMITS,
  MEETING_PREFIX,
  assertSessionWithinLimits,
  MeetingRefusal,
  conflictSafeWrites,
  writeSession,
} from "../src/meetings/state.js";
import { SessionRefusal, sessionForContext, splitWorkspacePath } from "../src/session.js";
import { handleMeetings } from "../src/meetings/ingest.js";

const S3_ENDPOINT = "https://s3.example-meetings.test";

const TOKEN_OWNER = `cat_meet_owner_${"0".repeat(24)}`;
const TOKEN_NEIGHBOUR = `cat_meet_neighbour_${"0".repeat(22)}`;
/** An owner whose grant was never given write. */
const TOKEN_READ_ONLY = `cat_meet_readonly_${"0".repeat(22)}`;
/** A full-scope grant held by somebody whose role in this context is `member`. */
const TOKEN_MEMBER = `cat_meet_member_${"0".repeat(24)}`;
/** An editor: write, but team tier — no private content, ever. */
const TOKEN_EDITOR = `cat_meet_editor_${"0".repeat(24)}`;
/** An editor in a context whose meetings folder defaults to `team`, so it CAN finalize. */
const TOKEN_SHARED = `cat_meet_shared_${"0".repeat(24)}`;
/** An owner whose bucket accepts a conditional write and ignores it. */
const TOKEN_LAST_WRITER = `cat_meet_lastwriter_${"0".repeat(20)}`;

/**
 * Ids in the contract's shape: `mtg_` plus 20 lowercase base32 characters.
 *
 * **Every character is claimed at most once, and this refuses a second claim.**
 *
 * Three of them were double-bound before the guard existed: `m` named both
 * `SESSION_BAD_ENGINE` and `SESSION_IN_FLIGHT` in the same store, and two
 * merges each added an inline `idOf(...)` for a letter that was free in the
 * branch it was written on — `y` beside `SESSION_RETITLED`, `f` beside
 * `SESSION_DOTTED`. Every one of those was harmless *only* because the request
 * using the second binding was refused and therefore wrote no record. The day
 * one of them becomes a success — a scope widened, a bound raised, a fixture
 * reused — the fixture that shares its id silently finds an existing session
 * and asserts against somebody else's meeting instead of failing.
 *
 * Nothing was watching for it, on this branch or on `main`. A `Set` is.
 *
 * The alphabet is Crockford's base32 without `i`, `l`, `o` and `u`
 * (`MEETING_ID_ALPHABET`), and all twenty-two of its letters are spoken for, so
 * a new fixture takes a digit. `isMeetingId` accepts those exactly as happily.
 */
const claimed = new Set();
const idOf = (letter) => {
  if (claimed.has(letter)) {
    throw new Error(`the meeting-id character ${letter} is already bound to a fixture`);
  }
  claimed.add(letter);
  return `mtg_${letter.repeat(20)}`;
};
const SESSION_MAIN = idOf("a");
const SESSION_NEVER_ISSUED = idOf("b");
const SESSION_STORAGE_FAILURE = idOf("c");
const SESSION_CONFLICT = idOf("d");
const SESSION_TEAM = idOf("e");
const SESSION_FORGED = idOf("g");
/**
 * Never opened: the id a refused transcription engine is offered under.
 *
 * A digit rather than a letter because every letter in `MEETING_ID_ALPHABET`
 * is already bound. It used to be `m`, which `SESSION_IN_FLIGHT` also holds —
 * and that one *is* opened, in the same store, so "never opened" was only true
 * of this fixture because the check above it happens to run first.
 */
const SESSION_BAD_ENGINE = idOf("3");
/** A meeting nobody recorded: typed notes, and no `start` event ever sent. */
const SESSION_TYPED_ONLY = idOf("h");
/** Opened while a workspace calls itself `meetings`. It must still be ours. */
const SESSION_SHADOWED = idOf("j");
/** Recorded into a bucket whose backend ignores `If-Match`. */
const SESSION_DEGRADED = idOf("k");
/** Still recording while a team-tier connection goes looking for it. */
const SESSION_IN_FLIGHT = idOf("m");
/** Finalized by a team connection, in a context whose meetings folder is team. */
const SESSION_SHARED = idOf("n");
/** Filed where the person pointed it, rather than into the inbox. */
const SESSION_FILED = idOf("p");
/** Finalized with a folder that tries to leave the bucket. */
const SESSION_ESCAPING = idOf("q");
/** Its first finalize claims a path and the write fails; the retry names another folder. */
const SESSION_RECLAIMED = idOf("r");
/** An editor aiming at a folder its tier may not write to. */
const SESSION_TEAM_FOLDER = idOf("s");
/** Aimed at the gateway's own plumbing. */
const SESSION_PLUMBING = idOf("t");
/** An owner filing into a team folder: the folder must not widen the note. */
const SESSION_TEAM_DEFAULT = idOf("v");
/** An editor filing into a folder its tier may actually write to. */
const SESSION_TEAM_ALLOWED = idOf("w");
/** The same claim window as `SESSION_RECLAIMED`, with the *title* renamed instead. */
const SESSION_RETITLED = idOf("y");
/** A team connection naming a folder its tier may not write, in a context whose default it can. */
const SESSION_WEDGED = idOf("x");
/** Aimed at a folder with `..` inside a segment: legal to `normalizeRoot`, refused by `normalizePath`. */
const SESSION_DOTTED = idOf("f");
/**
 * The id a read-only grant tries to open a session under, and must not.
 *
 * Named rather than inline, and its own character rather than `f`. Sharing
 * `SESSION_DOTTED`'s id was harmless only for as long as this request stays a
 * 403 that writes nothing: the day a read-only grant could open a session, the
 * `..`-in-a-segment finalize would be running against a session opened here
 * with a different title and start time.
 */
const SESSION_READ_ONLY_DENIED = idOf("4");
/**
 * Opened one attendee over the ceiling, in the bounds fixture's own store.
 *
 * Named rather than inline, and its own character rather than `y`. It is in a
 * different store from `SESSION_RETITLED` today, which is the only reason
 * sharing an id cost nothing — and "a different store" is a property of the
 * block it sits in rather than of the id, so it is not a thing to rely on.
 */
const SESSION_CROWDED = idOf("5");

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true },
    status: "active",
  };
}

async function meetingRequest(env, token, path, { method = "POST", body, raw } = {}) {
  const { ctx, settle } = createWorkerCtx();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (raw !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = raw;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await worker.fetch(new Request(`https://mcp.context.test${path}`, init), env, ctx);
  const text = await response.text();
  await settle();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

/** One tool's advertised definition, exactly as a connected client is handed it. */
async function toolDefinition(env, token, name) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return (body?.result?.tools || []).find((tool) => tool.name === name) || null;
}

async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return body?.result?.content?.[0]?.text || "";
}

const segment = (id, startMs, text, speaker = "Ada Lovelace") => ({
  id,
  startMs,
  endMs: startMs + 3_000,
  text,
  speaker,
  channel: "mic",
  confidence: 0.9,
});

/** Keys in one of the in-memory buckets, so a test can look at what was written. */
function keysIn(bucket, prefix) {
  return [...bucket.keys()].filter((key) => key.startsWith(prefix)).sort();
}

/**
 * A store that is not a bucket: enough of the interface for the state layer,
 * and a record of what every `put` was asked to guarantee.
 *
 * It exists for one property that no S3 fixture can show, because the S3
 * adapter always claims the capability: what this gateway does on a backend
 * that **cannot** do a conditional write. B2 and Wasabi accept `If-Match` and
 * ignore it, and the rule is that the guarantee is never silently dropped.
 */
function fakeStore({ conditionalWrite }) {
  const objects = new Map();
  const puts = [];
  let counter = 0;
  return {
    capabilities: { conditionalWrite },
    puts,
    objects,
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return { etag: entry.etag, text: async () => entry.body, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    async put(key, body, options = {}) {
      puts.push({ key, onlyIf: options?.onlyIf ?? null });
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const etag = `f${++counter}`;
      objects.set(key, { body, etag });
      return { etag };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key, size: objects.get(key).body.length, uploaded: new Date() })),
        truncated: false,
      };
    },
  };
}

export async function runMeetingChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  /**
   * One `fetch` layer above both, so a single storage write can be made to
   * fail. Installed last, so it sees the request first and hands everything it
   * is not interested in down the chain.
   */
  let failPut = null;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    if (failPut && method === "PUT") {
      const verdict = failPut(url);
      if (verdict) return new Response("", { status: verdict });
    }
    return previousFetch(input, init);
  };
  const restoreFailures = () => {
    globalThis.fetch = previousFetch;
  };

  controlPlane.addWorkspace("ws_recorder", "recorder", s3Binding("meet-recorder", "AA"));
  controlPlane.addWorkspace("ws_neighbour", "neighbour", s3Binding("meet-neighbour", "BB"));

  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_recorder",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_meet_phone",
    userId: "user_meet_owner",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_NEIGHBOUR,
    workspaceId: "ws_neighbour",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_meet_neighbour",
    userId: "user_meet_neighbour",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_READ_ONLY,
    workspaceId: "ws_recorder",
    role: "owner",
    scopes: ["context:read", "context:private"],
    clientId: "mcp_client_meet_readonly",
    userId: "user_meet_owner",
  });
  // A full-scope grant that the *role* cannot back up. `effectiveScopes`
  // intersects the two, so this connection reads and never writes.
  await controlPlane.addGrant({
    accessToken: TOKEN_MEMBER,
    workspaceId: "ws_recorder",
    role: "member",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_meet_member",
    userId: "user_meet_colleague",
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_EDITOR,
    workspaceId: "ws_recorder",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_meet_editor",
    userId: "user_meet_editor",
  });

  const recorder = s3.bucketFor("meet-recorder");
  const neighbour = s3.bucketFor("meet-neighbour");
  recorder.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "r0" });
  neighbour.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "n0" });

  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

  /* ------------------------- 1. opening a session -------------------------- */

  const opened = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_MAIN,
      title: "Roadmap review",
      startedAt: "2026-09-01T09:00:00.000Z",
      source: { kind: "zoom", app: "Zoom" },
      device: { platform: "ios", name: "Test Phone" },
      // A phone on the paid tier: the audio left the device. The note has to
      // say so, and this is where the only party that knows says it.
      transcription: "cloud",
      attendees: [
        { name: "Ada Lovelace", email: "ada@example.test", self: true, via: "manual" },
        { name: "Grace Hopper", email: "grace@example.test", via: "calendar" },
      ],
      events: [{ type: "start", at: "2026-09-01T09:00:00.000Z" }],
    },
  });
  check("a session opens", opened.status === 200 && opened.body?.sessionId === SESSION_MAIN);
  check("and reports the state the client's own log put it in", opened.body?.state === "recording");
  check("with no segments and no note yet", opened.body?.segmentCount === 0 && opened.body?.notePath === null);
  check("and says whether this bucket can do a conflict-safe write", opened.body?.conflictSafe === true);
  check(
    "the in-flight session is in the customer's bucket, under a plumbing prefix",
    keysIn(recorder, MEETING_PREFIX).length === 1
  );

  const rawRecord = () => JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_MAIN}.json`).body);

  const reopened = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, events: [{ type: "start", at: "2026-09-01T09:00:00.000Z" }] },
  });
  check("re-sending the same log is idempotent", reopened.status === 200 && reopened.body?.state === "recording");
  check("and does not erase metadata the body did not carry", rawRecord().title === "Roadmap review");

  /* --------------------------- 2. malformed input -------------------------- */

  const notJson = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { raw: "{not json" });
  check("a malformed body is refused", notJson.status === 400);
  check("with the contract's invalid code", notJson.body?.error === "meeting_invalid");

  const noId = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { body: { title: "no id" } });
  check("a session with no id is refused", noId.status === 400 && noId.body?.error === "meeting_invalid");

  const badArray = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { raw: "[1,2,3]" });
  check("a JSON array is not a session", badArray.status === 400 && badArray.body?.error === "meeting_invalid");

  const badEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_BAD_ENGINE, transcription: "quantum" },
  });
  check(
    "an engine nobody has heard of is refused rather than stored",
    badEngine.status === 400 && badEngine.body?.error === "meeting_invalid"
  );
  check("...and opens no session for it", keysIn(recorder, `${MEETING_PREFIX}${SESSION_BAD_ENGINE}`).length === 0);

  /*
    And it cannot be rewritten on a session that already declared one. Audio
    that has been streamed to a service cannot un-leave the machine, so a client
    talking a note out of saying `cloud` is refused rather than obeyed — which
    is the only direction this field can be wrong in that costs anybody
    anything.
  */
  const rewrittenEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, transcription: "on-device" },
  });
  check(
    "a client may not rewrite the engine a meeting was opened with",
    rewrittenEngine.status === 400 && rewrittenEngine.body?.error === "meeting_invalid"
  );
  check("and the stored session still says where its audio went", rawRecord().transcription === "cloud");
  const sameEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, transcription: "cloud" },
  });
  check("while re-sending the same answer is the no-op a replay needs", sameEngine.status === 200);

  const badId = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions/not-an-id/segments", { body: {} });
  check("a path that is not a meeting id is no route at all", badId.status === 404);

  const wrongMethod = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "DELETE",
  });
  check(
    "a known route with the wrong method is a 405 carrying a meeting code",
    wrongMethod.status === 405 && wrongMethod.body?.error === "meeting_invalid"
  );

  const noToken = await meetingRequest(env, null, "/meetings/sessions", { body: { id: SESSION_MAIN } });
  check("and no token is a 401 before any of that", noToken.status === 401);

  /* ------------------------ 3. segments, sent twice ------------------------ */

  const firstBatch = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-1", 0, "Shall we start with the roadmap."),
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
      ],
    },
  });
  check("a batch of segments is accepted", firstBatch.status === 200 && firstBatch.body?.segmentCount === 2);

  const resent = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-1", 0, "Shall we start with the roadmap."),
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
      ],
    },
  });
  check("a phone that lost signal and re-sent duplicates nothing", resent.body?.segmentCount === 2);

  const overlapping = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
        segment("seg-3", 9_000, "Then we cut the third milestone."),
      ],
    },
  });
  check("an overlapping batch adds only what is new", overlapping.body?.segmentCount === 3);
  check(
    "and the transcript is stored in order, once each",
    rawRecord().transcript.map((row) => row.id).join(",") === "seg-1,seg-2,seg-3"
  );

  const unusable = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        { id: "seg-4", startMs: 20_000, endMs: 1_000, text: "backwards clock", speaker: null, channel: "mic" },
        { id: "", startMs: 21_000, endMs: 22_000, text: "no id", speaker: null, channel: "mic" },
      ],
    },
  });
  check("a row the merge cannot use is counted rather than swallowed", unusable.body?.rejected === 2);
  check("and changes nothing", unusable.body?.segmentCount === 3);

  /*
    An id is a merge key and nothing bounded its length. Text is capped at
    `segmentTextChars` and a request at `requestBytes`, but the size of the
    stored record is never checked — so an oversized id was the one field a
    `context:write` grant could use to inflate a session past what those caps
    imply, in a record `isPlumbing` hides from every note surface at every tier
    including the owner's. Refused at the merge, and counted like any other
    unusable row rather than swallowed.
  */
  const longId = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        { id: "x".repeat(5_000), startMs: 30_000, endMs: 31_000, text: "padded", speaker: null, channel: "mic" },
      ],
    },
  });
  check("a segment whose id is oversized is refused", longId.body?.rejected === 1);
  check("and no such row reaches the record", longId.body?.segmentCount === 3);

  const tooMany = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: Array.from({ length: 1_001 }, (_, n) => segment(`bulk-${n}`, n * 10, "spam")) },
  });
  check("a batch beyond the cap is refused, not truncated", tooMany.status === 400);
  check("and the transcript is untouched", rawRecord().transcript.length === 3);

  const notAnArray = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: "seg-1" },
  });
  check("segments must be an array", notAnArray.status === 400 && notAnArray.body?.error === "meeting_invalid");

  /* ---------------------------- 4. the human's notes ----------------------- */

  const notes = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/notes`, {
    body: { notes: "- ship the first half\n- **decide** on the third milestone" },
  });
  check("the human's notes are stored", notes.status === 200);
  check("verbatim", rawRecord().notes.includes("**decide** on the third milestone"));

  const replaced = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/notes`, {
    body: { notes: "- ship the first half\n- decided: cut milestone three" },
  });
  check("and replaced wholesale, because they are the human's", replaced.status === 200);
  check("with the previous text gone", !rawRecord().notes.includes("**decide**"));

  /* ------------------------- 5. reading a session back --------------------- */

  const read = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}`, { method: "GET" });
  check("a session reads back", read.status === 200 && read.body?.session?.id === SESSION_MAIN);
  check("with its counts", read.body?.session?.segmentCount === 3);
  check(
    "and with the engine its words came from, so a client need not open the note",
    read.body?.session?.transcription === "cloud"
  );
  check("and without the transcript, unless it is asked for", read.body?.transcript === undefined);

  const readFull = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}?transcript=true`, {
    method: "GET",
  });
  check("which it can be", readFull.body?.transcript?.length === 3);

  const listed = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { method: "GET" });
  check("and the recent list names it", (listed.body?.sessions || []).some((row) => row.id === SESSION_MAIN));

  // The two other doors onto the same routes: a context named in the URL, and
  // the token-in-path fallback for clients that cannot set a header. Both are
  // transports for the same grant and neither is a boundary — the point of
  // checking them is that they reach the same context and no other.
  const bySlug = await meetingRequest(env, TOKEN_OWNER, `/@recorder/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check("naming your own context in the URL reaches it", bySlug.status === 200);
  const byPathToken = await meetingRequest(env, null, `/t/${TOKEN_OWNER}/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check("and so does the token-in-path fallback", byPathToken.status === 200);

  /*
    The event a client must never be able to send.

    `written` is what moves a session to `complete`, and the gateway is the only
    party that can know a note exists. The interesting shape is not a recording
    session — the transition table refuses `recording -> complete` on its own —
    but one the client has already ended, where `finalizing -> complete` is a
    legal move. A client that could make it would mark its own meeting finished,
    pointing at a note nobody wrote, and the recording would be lost in silence.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FORGED,
      title: "Forge attempt",
      startedAt: "2026-09-05T14:00:00.000Z",
      events: [
        { type: "start", at: "2026-09-05T14:00:00.000Z" },
        { type: "end", at: "2026-09-05T14:30:00.000Z" },
      ],
    },
  });
  const forgeable = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FORGED}.json`).body);
  check("a client can end its own session", forgeable.state === "finalizing");
  const forged = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: "written", notePath: "1-projects/forged.md" }] },
  });
  check(
    "and cannot send the event that says a note was written",
    forged.status === 400 && forged.body?.error === "meeting_invalid"
  );
  const stillFinalizing = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FORGED}.json`).body);
  check(
    "so nothing marks a meeting finished that was never written out",
    stillFinalizing.state === "finalizing" && stillFinalizing.notePath === null
  );

  /* ------------------------------ 6. finalize ------------------------------ */

  /*
    A moment the wearer marked. It arrives on the session route like the rest of
    the session's own fields, on a request that is *not* the one that created the
    session — which is the case that was accepted with a 200 and dropped on the
    floor until `foldMetadata` learned to fold flags.
  */
  const flagged = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_MAIN,
      flags: [
        { at: 4_000, label: "come back to this" },
        { at: 4_000, label: "the same press" },
        // A row the core cannot read. Skipped like an unusable segment, because
        // `meeting_invalid` is the code a client does not retry: refusing the
        // request would park the whole meeting over one bad number.
        { at: "four seconds in" },
      ],
    },
  });
  check("a flag sent after the session was opened is accepted", flagged.status === 200);
  check("and lands in the record, deduped on its offset", rawRecord().flags.length === 1);
  check(
    "...carrying the label the wearer's watch sent",
    rawRecord().flags[0].label === "come back to this"
  );
  check(
    "...and a flag row the core cannot read costs that row, not the request",
    flagged.body?.state === "recording" && rawRecord().flags.length === 1
  );

  const finalized = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/finalize`, {
    body: {
      endedAt: "2026-09-01T09:42:00.000Z",
      enhanced: "Agreed to cut milestone three and ship the first half.",
      templateId: "default",
    },
  });
  check("finalize writes the note", finalized.status === 200 && finalized.body?.state === "complete");
  const notePath = finalized.body?.notePath || "";
  check(
    "at a path derived from the meeting's own UTC date",
    notePath.startsWith("0-inbox/meetings/2026/09/2026-09-01-") && notePath.endsWith(".md")
  );
  check("and hands back the note's etag", typeof finalized.body?.etag === "string" && finalized.body.etag !== "");

  const noteBody = recorder.get(notePath)?.body || "";
  check("the note is one file, with the transcript appended to it", noteBody.includes("## Transcript"));
  check("carrying the summary the client generated", noteBody.includes("cut milestone three and ship the first half"));
  check("the human's own notes", noteBody.includes("decided: cut milestone three"));
  check("and what was said", noteBody.includes("Shall we start with the roadmap"));
  check("and the moment the wearer marked, beside the turn they marked it during", noteBody.includes("> [!flag] 00:04 — come back to this"));
  check("with the meeting id in its frontmatter", noteBody.includes(`meeting-id: ${SESSION_MAIN}`));
  check("and a status that says the meeting is over, not mid-write", noteBody.includes("status: complete"));
  /*
    The decision's own check, by its own name: "Every note records how it was
    made ... A person reading a meeting from eight months ago can tell whether
    its audio ever left their laptop, which is not a question they should have
    to reconstruct from their billing history."

    This is the end of that promise rather than the middle of it: not that a
    session field exists, but that the file in the customer's bucket — the only
    artifact left once the receipt drops everything else — says the word.
  */
  check(
    "a finalized note names the engine that produced it",
    noteBody.includes("transcription: cloud")
  );
  check(
    "...and the device that recorded it, beside it",
    noteBody.includes('device: "Test Phone (ios)"')
  );

  const receipt = rawRecord();
  check("the in-flight record becomes a completion receipt", receipt.state === "complete");
  check("naming the note it wrote", receipt.notePath === notePath);
  check("keeping the count", receipt.segmentCount === 3);
  check("and keeping the disclosure, which is one word and is not in the transcript", receipt.transcription === "cloud");
  check("and keeping no second copy of the flags either, because they are in the note", receipt.flags.length === 0);
  check(
    "and keeping no second copy of what was said",
    receipt.transcript.length === 0 &&
      !JSON.stringify(receipt).includes("Shall we start with the roadmap") &&
      receipt.notes === ""
  );

  const finalizedAgain = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/finalize`, {
    body: {},
  });
  check("finalizing twice answers with the note that already exists", finalizedAgain.body?.notePath === notePath);
  check(
    "and never writes a second one",
    keysIn(recorder, "0-inbox/meetings/").length === 1
  );

  const lateSegments = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: [segment("seg-late", 60_000, "one more thing")] },
  });
  check(
    "a segment arriving after finalize is refused rather than silently dropped",
    lateSegments.status === 400 && lateSegments.body?.error === "meeting_invalid"
  );
  const lateUpsert = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, title: "Renamed after the fact" },
  });
  check("while a metadata re-send is a no-op ack, not an error", lateUpsert.status === 200);
  check("that does not rewrite a finished meeting", rawRecord().title === "Roadmap review");

  /* -------------------------------- 7. audit ------------------------------- */

  const auditKeys = keysIn(recorder, ".audit/");
  const auditEntries = auditKeys.map((key) => JSON.parse(recorder.get(key).body));
  const written = auditEntries.find((entry) => entry.action === "meeting_note");
  check("writing a meeting is an audited event", Boolean(written));
  check("naming the acting identity, not just the tier", written?.actor_user_id === "user_meet_owner");
  check("and the client that acted", written?.actor_client_id === "mcp_client_meet_phone");
  check("and the context it happened in", written?.workspace_id === "ws_recorder");
  check("it records the path it wrote", written?.paths?.[0] === notePath);
  /*
    The audit entry minus the path it names. The path is what an audit record is
    *for* and it is checked above — and it carries a slug of the title, exactly
    as every note path in this gateway does, so it is taken out before asking
    the question this check actually asks: does anything else in the record
    carry what was said, who said it, or what the meeting was called.
  */
  const auditRest = JSON.stringify({ ...written, paths: undefined });
  check(
    "and no note content: not the transcript, not the title, not the attendees",
    !auditRest.includes("roadmap") &&
      !auditRest.includes("Roadmap review") &&
      !auditRest.includes("Lovelace")
  );

  /* ------------------------------- 8. the tools ---------------------------- */

  const list = await callTool(env, TOKEN_OWNER, "list_meetings");
  check("list_meetings finds the meeting", list.includes(notePath));
  check("with its title", list.includes("Roadmap review"));
  check("and who was there", list.includes("Ada Lovelace"));

  const summaryOnly = await callTool(env, TOKEN_OWNER, "read_meeting", { path: notePath });
  check("read_meeting returns the note", summaryOnly.includes("decided: cut milestone three"));
  check(
    "without the transcript by default",
    !summaryOnly.includes("Shall we start with the roadmap") && !summaryOnly.includes("## Transcript")
  );
  check("saying that there is one, and how to ask for it", summaryOnly.includes("transcript: true"));
  check("and how much was left behind", /transcript omitted: \d+ characters/.test(summaryOnly));

  const withTranscript = await callTool(env, TOKEN_OWNER, "read_meeting", { path: notePath, transcript: true });
  check("and returns it when asked", withTranscript.includes("Shall we start with the roadmap"));
  check("with the section heading it is filed under", withTranscript.includes("## Transcript"));

  const missing = await callTool(env, TOKEN_OWNER, "read_meeting", { path: "0-inbox/meetings/nope.md" });
  check("a meeting note that does not exist is 'not found'", missing === "not found");

  /* ------------------------------ 9. privacy ------------------------------- */

  check("a personal connection's meeting is private", summaryOnly.includes("visibility: private"));
  const memberRead = await callTool(env, TOKEN_MEMBER, "read_meeting", { path: notePath });
  check("so a team-tier connection cannot read it", memberRead === "not found");
  const memberList = await callTool(env, TOKEN_MEMBER, "list_meetings");
  check("and cannot learn it exists by listing", !memberList.includes(notePath));
  check("being told only that there is nothing it may see", memberList.includes("no meetings recorded yet"));

  /*
    The same two refusals, asked of the HTTP surface instead of the tool surface.

    `read_meeting` and `list_meetings` above filter with `canSee`, so a team-tier
    connection is told "not found" about a private meeting. The ingestion routes
    read `.meetings/sessions/<id>.json` straight out of the store, and that
    record is the same meeting: its title, who was in the room, the path of the
    private note it became, and — while it is still recording — every word of
    the transcript. A boundary that holds on one of the two surfaces exposing a
    thing is not a boundary.

    The finalized meeting first. Its receipt keeps the summary for good, so this
    half of the disclosure is permanent rather than a window during the call.
  */
  const memberSessionRead = await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check(
    "a team-tier connection cannot read a private meeting's session record either",
    memberSessionRead.status === 404 && memberSessionRead.body?.error === "meeting_forbidden"
  );
  const memberSessionList = await meetingRequest(env, TOKEN_MEMBER, "/meetings/sessions", { method: "GET" });
  const listedForMember = JSON.stringify(memberSessionList.body ?? {});
  check("and cannot learn the private note's path by listing sessions", !listedForMember.includes(notePath));
  check("nor its title and who was in the room", !listedForMember.includes("Ada Lovelace"));
  // The count is part of the listing: reporting the raw scan width would hand a
  // team connection an exact number of the private meetings it was filtered out
  // of, which is the same disclosure arriving as an integer.
  check(
    "nor a count of the meetings it was filtered out of",
    memberSessionList.body?.scanned === (memberSessionList.body?.sessions || []).length
  );

  /*
    Now a meeting that is still recording, which is where the transcript lives:
    a receipt has already dropped it, so the finalized session above understates
    what an in-flight one discloses.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_IN_FLIGHT,
      title: "Compensation review",
      startedAt: "2026-09-03T11:00:00.000Z",
      events: [{ type: "start", at: "2026-09-03T11:00:00.000Z" }],
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_IN_FLIGHT}/segments`, {
    body: { segments: [segment("seg-live", 0, "we are raising her band to four")] },
  });

  const memberLiveRead = await meetingRequest(
    env,
    TOKEN_MEMBER,
    `/meetings/sessions/${SESSION_IN_FLIGHT}?transcript=true`,
    { method: "GET" }
  );
  check(
    "a meeting still recording is not readable by a team-tier connection",
    memberLiveRead.status === 404 && memberLiveRead.body?.error === "meeting_forbidden"
  );
  check(
    "so what was said in the room does not leave it",
    !JSON.stringify(memberLiveRead.body ?? {}).includes("raising her band")
  );

  /*
    And the integrity half, which is worse than the disclosure. An editor holds
    `context:write` at the team tier, so the scope gate lets it through, and the
    notes route replaces the human's Markdown — the body of the private note
    this meeting is about to become. Finding the id is the listing above; this
    is what the id is worth.
  */
  const editorTampers = await meetingRequest(env, TOKEN_EDITOR, `/meetings/sessions/${SESSION_IN_FLIGHT}/notes`, {
    body: { notes: "TAMPERED BY AN EDITOR" },
  });
  check(
    "a team-tier editor cannot rewrite a private meeting's notes",
    editorTampers.status === 404 && editorTampers.body?.error === "meeting_forbidden"
  );
  // Read the record out of the bucket rather than off the ack: `sessionSummary`
  // does not carry `notes`, so a response that looks clean is not evidence the
  // stored meeting is.
  const tamperedRecord = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_IN_FLIGHT}.json`).body);
  check("and the stored meeting is untouched by the attempt", tamperedRecord.notes !== "TAMPERED BY AN EDITOR");

  /*
    And an upsert of the same id, which is the dangerous shape of the same move.

    A session the caller may not see reads as absent, so an upsert would take
    `null` for "no such session", open a fresh one and write it with no etag —
    an unconditional put over the owner's in-flight meeting. Withholding a
    record and then letting somebody create over it is worse than showing it:
    the transcript would be gone rather than read.
  */
  const editorUpserts = await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_IN_FLIGHT,
      title: "Hijacked",
      startedAt: "2026-09-03T11:00:00.000Z",
    },
  });
  check(
    "a team-tier connection cannot create over a private meeting it cannot see",
    editorUpserts.status === 404 && editorUpserts.body?.error === "meeting_forbidden"
  );
  const survivingRecord = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_IN_FLIGHT}.json`).body);
  check(
    "so the meeting it could not read is still the meeting that was recorded",
    survivingRecord.title === "Compensation review" && survivingRecord.transcript.length === 1
  );
  const ownerChecksBack = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_IN_FLIGHT}`, {
    method: "GET",
  });
  check(
    "while the owner still reads their own meeting in full",
    ownerChecksBack.status === 200 && JSON.stringify(ownerChecksBack.body ?? {}).includes("Compensation review")
  );

  // A team connection that *can* write is still refused this destination: the
  // meetings folder inherits `private`, and a team connection may not create
  // private content. Its session is opened first, so the refusal is the write
  // and not the ingestion.
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM,
      title: "Editor's meeting",
      startedAt: "2026-09-02T10:00:00.000Z",
      events: [{ type: "start", at: "2026-09-02T10:00:00.000Z" }],
    },
  });
  const editorFinalize = await meetingRequest(env, TOKEN_EDITOR, `/meetings/sessions/${SESSION_TEAM}/finalize`, {
    body: {},
  });
  check(
    "a team connection cannot file a meeting into a private folder",
    editorFinalize.status === 403 && editorFinalize.body?.error === "meeting_forbidden"
  );
  check("and no note is written when it tries", keysIn(recorder, "0-inbox/meetings/").length === 1);

  /* --------------------------- 10. scope and role -------------------------- */

  const readOnlyWrite = await meetingRequest(env, TOKEN_READ_ONLY, "/meetings/sessions", {
    body: { id: SESSION_READ_ONLY_DENIED, startedAt: "2026-09-01T09:00:00.000Z" },
  });
  check(
    "a read-only grant cannot open a session",
    readOnlyWrite.status === 403 && readOnlyWrite.body?.error === "meeting_forbidden"
  );
  check("and is told which scope it is missing", readOnlyWrite.body?.scope?.[0] === "context:write");
  const readOnlyRead = await meetingRequest(env, TOKEN_READ_ONLY, "/meetings/sessions", { method: "GET" });
  check("while reading is still allowed", readOnlyRead.status === 200);

  const memberWrite = await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: [segment("seg-member", 0, "let me in")] },
  });
  check(
    "a full-scope grant whose role is `member` cannot write either",
    memberWrite.status === 403 && memberWrite.body?.error === "meeting_forbidden"
  );
  check("and the refusal happens before anything is read", memberWrite.body?.scope?.[0] === "context:write");

  /* ------------------------ 11. cross-tenant isolation --------------------- */

  const neighbourReads = await meetingRequest(env, TOKEN_NEIGHBOUR, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  const neighbourReadsGhost = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_NEVER_ISSUED}`,
    { method: "GET" }
  );
  check("another workspace cannot read a session id issued in this one", neighbourReads.status === 404);
  check("and it carries the contract's forbidden code", neighbourReads.body?.error === "meeting_forbidden");
  check(
    "byte-identical to an id nobody has ever issued, so nothing leaks by existence",
    neighbourReads.text === neighbourReadsGhost.text && neighbourReads.status === neighbourReadsGhost.status
  );

  const neighbourWrites = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_MAIN}/segments`,
    { body: { segments: [segment("seg-intruder", 0, "INTRUDER-MARKER")] } }
  );
  check("nor write to it", neighbourWrites.status === 404);
  check(
    "and the attempt reaches nothing: not the record, not the note",
    !JSON.stringify(rawRecord()).includes("INTRUDER-MARKER") &&
      !(recorder.get(notePath)?.body || "").includes("INTRUDER-MARKER")
  );
  check(
    "and does not create the session in the attacker's own bucket either",
    keysIn(neighbour, MEETING_PREFIX).length === 0
  );

  const neighbourFinalizes = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_MAIN}/finalize`,
    { body: {} }
  );
  check("nor finalize it", neighbourFinalizes.status === 404);
  check("writing no note anywhere", keysIn(neighbour, "0-inbox/meetings/").length === 0);
  check("and leaving the original alone", keysIn(recorder, "0-inbox/meetings/").length === 1);

  const neighbourList = await meetingRequest(env, TOKEN_NEIGHBOUR, "/meetings/sessions", { method: "GET" });
  check(
    "and the neighbour's own listing enumerates nothing of ours",
    (neighbourList.body?.sessions || []).length === 0
  );

  const neighbourBySlug = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/@recorder/meetings/sessions/${SESSION_MAIN}`,
    { method: "GET" }
  );
  check("naming the context in the URL does not help", neighbourBySlug.status === 403);
  const neighbourByGhostSlug = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    "/@no-such-context/meetings/sessions/" + SESSION_MAIN,
    { method: "GET" }
  );
  check(
    "and a context that exists refuses exactly as one that does not",
    neighbourBySlug.status === neighbourByGhostSlug.status
  );

  /* --------------------- 12. storage failure and conflict ------------------ */

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_STORAGE_FAILURE,
      title: "Doomed write",
      startedAt: "2026-09-03T11:00:00.000Z",
      events: [{ type: "start", at: "2026-09-03T11:00:00.000Z" }],
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_STORAGE_FAILURE}/segments`, {
    body: { segments: [segment("fail-1", 0, "this should survive the outage")] },
  });

  // The bucket refuses exactly the note write, which is the interesting moment:
  // the session has been claimed, and the note has not been written.
  failPut = (url) => (url.includes("/meet-recorder/0-inbox/meetings/") ? 500 : null);
  const brokenFinalize = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_STORAGE_FAILURE}/finalize`,
    { body: {} }
  );
  check(
    "a storage failure mid-finalize is reported as retryable",
    brokenFinalize.status === 503 && brokenFinalize.body?.error === "meeting_unavailable"
  );
  check("and no note is left behind", keysIn(recorder, "0-inbox/meetings/").length === 1);

  failPut = null;
  const retried = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_STORAGE_FAILURE}/finalize`,
    { body: {} }
  );
  check("the retry succeeds", retried.status === 200 && retried.body?.state === "complete");
  check("writing exactly one note for that meeting", keysIn(recorder, "0-inbox/meetings/").length === 2);
  check(
    "and the transcript that was in flight survived the outage",
    (recorder.get(retried.body.notePath)?.body || "").includes("this should survive the outage")
  );

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_CONFLICT,
      title: "Contended",
      startedAt: "2026-09-04T12:00:00.000Z",
      events: [{ type: "start", at: "2026-09-04T12:00:00.000Z" }],
    },
  });
  // Every conditional write on that record loses, which is what a session two
  // devices are writing to at once looks like from one of them.
  failPut = (url) => (url.includes(`${MEETING_PREFIX}${SESSION_CONFLICT}.json`) ? 412 : null);
  const contended = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_CONFLICT}/segments`, {
    body: { segments: [segment("contended-1", 0, "who wins")] },
  });
  check(
    "a write that keeps losing its conditional put is a conflict, not a silent overwrite",
    contended.status === 409 && contended.body?.error === "meeting_conflict"
  );
  failPut = null;

  const bounded = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions?limit=2", { method: "GET" });
  check("the recent list honours a limit", (bounded.body?.sessions || []).length === 2);
  check(
    "and answers newest meeting first",
    String(bounded.body.sessions[0].startedAt) > String(bounded.body.sessions[1].startedAt)
  );
  check(
    "reporting what it scanned as a floor rather than a total",
    typeof bounded.body?.scanned === "number" && bounded.body.scanned >= 2
  );

  /*
    A meeting nobody recorded: typed notes, no `start`, no audio. The transition
    table used to refuse `idle -> finalizing`, so this route answered 400 for a
    client that had done nothing wrong — and the only thing that meeting held
    was the half nobody can regenerate.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_TYPED_ONLY,
      title: "Notes only",
      startedAt: "2026-09-01T14:00:00.000Z",
      device: { platform: "ios" },
      notes: "- they said yes",
    },
  });
  const typedOnly = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TYPED_ONLY}/finalize`,
    { body: {} }
  );
  check(
    "a meeting nobody recorded finalizes without a forged start",
    typedOnly.status === 200 && typedOnly.body?.state === "complete"
  );
  const typedNote = recorder.get(typedOnly.body?.notePath || "")?.body || "";
  check("...writing the words the person actually typed", typedNote.includes("- they said yes"));
  check(
    "...and saying plainly that there was no transcript",
    typedNote.includes("_No transcript was captured._")
  );

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

  /* -------------------- 15. a backend that cannot do any of that ----------- */

  const safe = fakeStore({ conditionalWrite: true });
  const unsafe = fakeStore({ conditionalWrite: false });
  check("a store that honours a conditional write says so", conflictSafeWrites(safe) === true);
  check("and one that does not, does not", conflictSafeWrites(unsafe) === false);

  /*
    A bucket that honours `If-Match` but has not been probed yet.

    `withProbedCapabilities` lowers a store's declared capability to the one the
    binding was *probed* for, and the control plane "starts a binding at `false`,
    and only a real probe may turn it on" — so unproven is every bucket's
    opening state, not a legacy edge. That answer is the right one to *report*
    on the ack and the wrong one to gate the write on: the header costs nothing
    to send, a backend that ignores it ignores it either way, and the existing
    sabotage for this ("`writeSession` drops `onlyIf`") only ever ran against
    stores that declare `true`. The population the guard covers was the thing
    left unchecked.
  */
  const unprobed = fakeStore({ conditionalWrite: false });
  // Carries a tier: `writeSession` refuses a record without one, which is the
  // guard that stops a fresh object literal silently downgrading a meeting.
  const bare = { id: SESSION_MAIN, scope: "private", transcript: [], attendees: [], appliedAt: {} };
  const firstEtag = await writeSession(unprobed, { ...bare, notes: "first" }, null);
  await writeSession(unprobed, { ...bare, notes: "somebody else" }, firstEtag);
  const staleWrite = await writeSession(unprobed, { ...bare, notes: "mine, from a stale read" }, firstEtag);
  check("a write guards the read it came from even before the bucket is probed", staleWrite === false);
  check(
    "so a meeting is not overwritten by a writer holding a stale etag",
    JSON.parse(unprobed.objects.get(`${MEETING_PREFIX}${SESSION_MAIN}.json`).body).notes === "somebody else"
  );

  /* ------------------- every size bound, driven to its edge ------------------ */

  /*
    NINE OF THE TEN BOUNDS ON THIS PATH WERE PROVED BY NOTHING.

    `LIMITS` is what stops a `context:write` grant growing an unbounded hidden
    object in somebody else's bucket — the record is refused by `isPlumbing` at
    every tier including the owner's, so nothing in the product ever shows it.
    Measured by replacing each check's condition with `false` in turn and
    running the suite. Against the tree before this block, only
    `segmentsPerRequest` reddened; the other nine were live in production and
    exercised by nothing. With this block all ten redden, and re-running that
    measurement is how you check the block still earns its place.

    Each case reads its number out of `LIMITS` rather than copying it: a suite
    written relative to its own constant cannot catch a bad value, but it can
    catch a deleted check, which is what these are for.

    ONE CHECK PER BOUND, NAMED. An earlier draft rolled six of them into a
    single `admitted.length === 0`, which would have gone green with a case
    refused for the wrong reason — and one of them was, because the segment
    shape was wrong and `normalizeSegment` dropped it before any bound saw it.
  */
  const boundStore = fakeStore({ conditionalWrite: true });
  const boundSession = { scope: "private", workspaceId: "ws_bounds" };
  // Nothing in this block finalizes, so this is never invoked; it is here to
  // fail loudly rather than write a note if that ever stops being true.
  const refuseToPublish = async () => {
    throw new Error("the bounds fixture never finalizes");
  };
  const BOUND_SESSION = idOf("z");

  const sendTo = async (path, body, headers = {}) =>
    handleMeetings(
      new Request(`https://mcp.context.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      path,
      boundStore,
      boundSession,
      { publishNote: refuseToPublish }
    );

  await sendTo("/meetings/sessions", {
    id: BOUND_SESSION,
    startedAt: "2026-09-05T13:00:00.000Z",
  });

  const segmentsPath = `/meetings/sessions/${BOUND_SESSION}/segments`;
  const notesPath = `/meetings/sessions/${BOUND_SESSION}/notes`;
  // The shape `normalizeSegment` accepts. Getting this wrong is how a bound
  // test passes on a row that was discarded before the bound was consulted.
  const seg = (i, text = "a") => ({ id: `s${i}`, startMs: i * 10, endMs: i * 10 + 5, text });
  // Distinct `at`, because `withFlag` dedupes on it: a batch of identical
  // flags folds to ONE, and a comment claiming otherwise is arithmetic nobody
  // checked. It was, for one round of review.
  const flags = (n) => Array.from({ length: n }, (_, i) => ({ type: "flag", at: i }));

  /*
    EACH BOUND IS A PAIR: the payload exactly at the limit is accepted and the
    payload one past it is refused. The refusal alone is not evidence — an
    earlier draft posted the three event bounds to `/meetings/sessions/:id/events`,
    a route that does not exist, and all three went green on the 404. A pair
    cannot do that: no wrong reason refuses one and admits the other.
  */
  const atBatch = await sendTo(segmentsPath, {
    segments: Array.from({ length: LIMITS.segmentsPerRequest }, (_, i) => seg(i)),
  });
  check("a full per-request batch of segments is accepted", atBatch.status === 200);
  const tooManySegments = await sendTo(segmentsPath, {
    segments: Array.from({ length: LIMITS.segmentsPerRequest + 1 }, (_, i) => seg(i)),
  });
  check("one segment over the per-request batch is refused", tooManySegments.status >= 400);

  const atSegmentText = await sendTo(segmentsPath, {
    segments: [seg(0, "a".repeat(LIMITS.segmentTextChars))],
  });
  check("a segment exactly at the text bound is accepted", atSegmentText.status === 200);
  const tooLongSegment = await sendTo(segmentsPath, {
    segments: [seg(0, "a".repeat(LIMITS.segmentTextChars + 1))],
  });
  check("one character over the per-segment text bound is refused", tooLongSegment.status >= 400);

  /*
    The three event bounds. A client's replay log arrives as `events` on the
    upsert body and on finalize — `foldLog(next, body.events)` at both — so the
    upsert is the surface that reaches `eventsPerRequest` and, through it,
    `assertEventWithinLimits` on every event in the batch. There is no separate
    events route to post to; `SUB_ROUTES` has segments, notes and finalize.
  */
  const replay = async (events) => sendTo("/meetings/sessions", { id: BOUND_SESSION, events });

  const atEvents = await replay(flags(LIMITS.eventsPerRequest));
  check("a full replay batch of events is accepted", atEvents.status === 200);
  // Folded, not discarded, and *asserted* rather than assumed: a fixture that
  // quietly folded to one flag would leave the `flags` ceiling unreachable and
  // this pair proving nothing about the record it claims to have grown.
  const afterReplay = JSON.parse(
    boundStore.objects.get(`${MEETING_PREFIX}${BOUND_SESSION}.json`).body
  );
  check(
    "and every event in it lands on the record",
    afterReplay.flags.length === LIMITS.eventsPerRequest
  );
  const tooManyEvents = await replay(flags(LIMITS.eventsPerRequest + 1));
  check("one event over the per-replay bound is refused", tooManyEvents.status >= 400);

  const atNotes = await sendTo(notesPath, { notes: "a".repeat(LIMITS.notesChars) });
  check("notes exactly at the bound are accepted", atNotes.status === 200);
  const tooLongNotes = await sendTo(notesPath, { notes: "a".repeat(LIMITS.notesChars + 1) });
  check("notes one character over the bound are refused", tooLongNotes.status >= 400);

  const atEnhanced = await replay([
    { type: "enhanced", at: 1, markdown: "a".repeat(LIMITS.enhancedChars) },
  ]);
  check("an enhanced note exactly at the bound is accepted", atEnhanced.status === 200);
  const tooLongEnhanced = await replay([
    { type: "enhanced", at: 1, markdown: "a".repeat(LIMITS.enhancedChars + 1) },
  ]);
  check("an enhanced note one character over the bound is refused", tooLongEnhanced.status >= 400);

  /*
    `requestBytes`, both halves, and they are NOT the same guard. `Content-Length`
    is a header the caller controls and a chunked request carries none at all,
    so `Number(null || 0)` is `0` and sails past the declared check — the
    byteLength check is the only real bound and the declared one is the
    courtesy that stops us buffering first.

    Which is why the declared half is driven by a body that LIES: a truthfully
    oversized body is refused by the byte check whether the declared one exists
    or not, so deleting the declared check reddens nothing and the pair proves
    one guard twice. A small body under a huge `Content-Length` is the only
    payload that isolates it — and it is the case the guard is for, since the
    header is the only thing we know before we buffer. The oversized body below is one
    long string field rather than a segments array, and both cases assert `413`
    exactly: `readJsonBody` is the only thing in the meetings path that returns
    that status, so neither can be satisfied by a refusal from anywhere else.
  */
  const declaredTooBig = await sendTo(segmentsPath, JSON.stringify({ notes: "small" }), {
    "Content-Length": String(LIMITS.requestBytes + 1),
  });
  check("a body that only claims to be too large is refused unread", declaredTooBig.status === 413);
  const huge = JSON.stringify({ notes: "a".repeat(LIMITS.requestBytes + 1) });
  const chunkedTooBig = await sendTo(segmentsPath, huge);
  check(
    "and one that declares nothing is refused on what it actually weighs",
    chunkedTooBig.status === 413
  );

  /*
    THE WHOLE-RECORD CEILINGS, asserted on the function that enforces them.

    `segmentsPerSession` is 20,000 and `flags` is 2,000, reached over many
    requests rather than in one; driving 20,000 segments through the handler
    would re-serialise the record on every batch and cost more than the check is
    worth.

    `attendees` is asymmetric between the two upsert paths, which is worth
    saying out loud: `foldMetadata` *truncates* with `slice(0, LIMITS.attendees)`
    when the session already exists, but `createSession` only dedupes, so a
    session OPENED over the ceiling reaches `assertSessionWithinLimits` and is
    refused. Both bound it; only one is a refusal, and that half is driven
    through the handler below. An earlier draft of this comment claimed the
    ceiling was unreachable through the handler at all, and skipped that check
    on the strength of it.

    So the ceilings are driven directly at `assertSessionWithinLimits`, which is
    the function all three live in and which `ingest.js` calls on every write
    that can grow one of them — the upsert, the segment append and the finalize
    claim. `replaceNotes` does not call it, and does not need to: it folds a
    `notes` event and touches none of these three lists. ("At every write" is
    what this said until review; it is one word wider than the code.)
  */
  const atCeiling = {
    transcript: Array.from({ length: LIMITS.segmentsPerSession }, (_, i) => seg(i)),
    attendees: Array.from({ length: LIMITS.attendees }, (_, i) => ({ name: `a${i}` })),
    flags: Array.from({ length: LIMITS.flags }, (_, i) => ({ at: i })),
  };
  let ceilingHeld = true;
  try {
    assertSessionWithinLimits(atCeiling);
  } catch {
    ceilingHeld = false;
  }
  check("a session exactly at every ceiling is allowed", ceilingHeld);

  const overBy = (field, extra) => {
    try {
      assertSessionWithinLimits({ ...atCeiling, [field]: [...atCeiling[field], extra] });
      return false;
    } catch {
      return true;
    }
  };
  check(
    "one segment past the session ceiling is refused",
    overBy("transcript", seg(LIMITS.segmentsPerSession))
  );
  check("one attendee past the ceiling is refused", overBy("attendees", { name: "one more" }));
  check("one flag past the ceiling is refused", overBy("flags", { at: 1 }));

  const crowded = await sendTo("/meetings/sessions", {
    id: SESSION_CROWDED,
    startedAt: "2026-09-05T13:00:00.000Z",
    attendees: Array.from({ length: LIMITS.attendees + 1 }, (_, i) => ({ name: `a${i}` })),
  });
  check("and a session opened one attendee over it is refused too", crowded.status >= 400);

  const fakeSession = { scope: "private", workspaceId: "ws_fake" };
  const publishNever = async () => {
    throw new Error("this fixture never finalizes");
  };
  const openOn = async (store, id) =>
    handleMeetings(
      new Request("https://mcp.context.test/meetings/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, startedAt: "2026-09-05T13:00:00.000Z" }),
      }),
      "/meetings/sessions",
      store,
      fakeSession,
      { publishNote: publishNever }
    );

  const ackSafe = await (await openOn(safe, SESSION_MAIN)).json();
  const ackUnsafe = await (await openOn(unsafe, SESSION_MAIN)).json();
  check("the ack tells a client its bucket is conflict-safe", ackSafe.conflictSafe === true);
  check(
    "and tells it plainly when it is not, rather than dropping the guarantee quietly",
    ackUnsafe.conflictSafe === false
  );

  await openOn(safe, SESSION_MAIN);
  await openOn(unsafe, SESSION_MAIN);
  check(
    "a second write to a conflict-safe store guards the read it came from",
    safe.puts.length === 2 && safe.puts[0].onlyIf === null && safe.puts[1].onlyIf !== null
  );
  /*
    This assertion used to read "a store that cannot guard one is never asked to
    pretend", and required `onlyIf` to be absent from every write to a store
    declaring `conditionalWrite: false`. It was correct while that flag meant
    "this adapter does not send `If-Match`". It stopped being correct when
    `withProbedCapabilities` made the flag mean "no probe has confirmed this
    backend honours `If-Match`" — a set that includes every freshly bound
    bucket, because the control plane starts each one at `false`.

    Under the old rule those buckets got no guard at all: a lost race was not
    reported, the retry never fired, and a stale writer overwrote a live meeting
    in silence. Nothing was "pretending" — a backend that ignores the header
    ignores it and the write succeeds either way — so the header was free and
    the rule was costing exactly the guarantee it was written to protect.

    What the author was defending is real and is still asserted, two checks
    above: the *ack* tells the client `conflictSafe: false`. That is where
    honesty about the backend belongs. Whether the guard is attempted is a
    different question from what the client is promised.
  */
  check(
    "a bucket that has not been probed is still guarded, not silently unguarded",
    unsafe.puts.length === 2 && unsafe.puts[0].onlyIf === null && unsafe.puts[1].onlyIf !== null
  );
  check(
    "while the ack still refuses to promise a guarantee the backend may not keep",
    ackUnsafe.conflictSafe === false
  );

  /*
    And the stamp is enforced where it can be checked rather than asserted where
    it cannot. `completionReceipt` builds a fresh object literal and once
    dropped the tier, which read back as `private` and locked a team connection
    out of the meeting it had just finished. A comment saying "every write goes
    through `updateSession`" is what failed; this is the version that cannot.
  */
  let refusedUnstamped = false;
  try {
    await writeSession(unprobed, { id: SESSION_MAIN, transcript: [], attendees: [], appliedAt: {} }, null);
  } catch {
    refusedUnstamped = true;
  }
  check("a record carrying no tier is refused rather than written at a downgraded one", refusedUnstamped);

  /* ------------ 16. the folder the person picked, end to end --------------- */

  /*
    A phone can ask where a meeting's notes should go, and until now the gateway
    built the inbox path from a module constant and consulted nothing: a person
    who picked a folder got the inbox anyway, silently. Everything below is that
    control actually reaching the bucket, and the four ways it must not misfire.
  */

  check(
    "a finalize that names no folder says nothing about one",
    finalized.body?.folderRejected === undefined && notePath.startsWith("0-inbox/meetings/")
  );

  const openFor = (id, title, startedAt) =>
    meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: { id, title, startedAt, events: [{ type: "start", at: startedAt }] },
    });

  await openFor(SESSION_FILED, "Filed by hand", "2026-09-06T10:00:00.000Z");
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/notes`, {
    body: { notes: "- filed where the person pointed it" },
  });
  const filed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/finalize`, {
    body: { folder: "2-areas/team" },
  });
  const filedPath = filed.body?.notePath || "";
  check("a finalize can name the folder the person picked", filed.status === 200 && filed.body?.state === "complete");
  check(
    "...and the note lands there, with the date folders still under it",
    filedPath === `2-areas/team/2026/09/2026-09-06-filed-by-hand-${SESSION_FILED.slice(-8)}.md`
  );
  check("...carrying what the person typed", (recorder.get(filedPath)?.body || "").includes("filed where the person pointed it"));
  check("...and the ack claims nothing was refused", filed.body?.folderRejected === undefined);
  check(
    "...and nothing was filed into the inbox on the way",
    !keysIn(recorder, "0-inbox/meetings/").includes(filedPath)
  );

  /*
    THE IDEMPOTENCY CHECK. The note path is claimed into the session record
    under a conditional write and reused by every retry, so the folder is an
    input to the *claim* and the claim happens once. A second finalize naming
    somewhere else is a client retrying, not a person moving a note.
  */
  const filedAgain = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/finalize`, {
    body: { folder: "1-projects/somewhere-else" },
  });
  check(
    "finalizing again with a different folder answers with the note that already exists",
    filedAgain.status === 200 && filedAgain.body?.notePath === filedPath
  );
  check("...writing nothing at the folder the retry named", keysIn(recorder, "1-projects/somewhere-else/").length === 0);
  check("...so the meeting is still exactly one note", keysIn(recorder, "2-areas/team/").length === 1);
  /*
    And it SAYS so. Answering 200 with the first note's path and no flag is
    correct about the meeting and silent about the request: the client asked for
    `1-projects/somewhere-else` and got `2-areas/team`, which is the same
    "appears to work and does nothing" the destination control was built to end,
    one layer down. `folderRejected` is the field for exactly that sentence, so
    it means "the folder you named is not where this note is" rather than the
    narrower "the string you sent was malformed".
  */
  check("...and the client is told the folder it named is not where the note is", filedAgain.body?.folderRejected === true);
  check("...without reading its value back", !filedAgain.text.includes("somewhere-else"));

  /*
    And the same property through the path that is not a no-op: a first finalize
    whose note write fails has *claimed* a path without writing it, which is the
    one window where a second folder could fork a meeting into two notes.
  */
  await openFor(SESSION_RECLAIMED, "Half written", "2026-09-06T11:00:00.000Z");
  failPut = (url) => (url.includes("/meet-recorder/2-areas/archive/") ? 500 : null);
  const claimed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RECLAIMED}/finalize`, {
    body: { folder: "2-areas/archive" },
  });
  check(
    "a note write that fails under a chosen folder is retryable, like any other",
    claimed.status === 503 && claimed.body?.error === "meeting_unavailable"
  );
  failPut = null;
  const reclaimed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RECLAIMED}/finalize`, {
    body: { folder: "3-resources/inbox" },
  });
  check(
    "the retry lands on the path the first finalize claimed, not the folder it just named",
    reclaimed.status === 200 && reclaimed.body?.notePath?.startsWith("2-areas/archive/")
  );
  check("...leaving nothing behind at the second folder", keysIn(recorder, "3-resources/").length === 0);
  check("...and exactly one note at the first", keysIn(recorder, "2-areas/archive/").length === 1);
  /*
    A *transient* failure keeps the claim, which is the property the claim
    exists for — and the client is still told that the folder it named on the
    retry is not where the note went. The two are not in tension: the claim
    decides where the note goes, the flag says whether the request got what it
    asked for.
  */
  check("...and the retry is told its folder was not the one used", reclaimed.body?.folderRejected === true);

  /*
    THE TRAP THE IDEMPOTENCY SECTION NAMES, WHICH NOTHING WAS CHECKING.

    `docs/decisions/meetings.md` states it in so many words: "if the bucket path
    is derived from the title, and the human renames the meeting between a
    failed finalize and its retry, a title-derived path produces a *second* note
    and both look correct" — and it then cited a check called `a re-finalize
    with a changed title rewrites one note rather than adding a second` that had
    never been written. The folder cases above are the same window entered by a
    different door and do not cover it: `slugifyTitle` is what puts the title
    into the key, so a rename is the one input that changes the *filename*
    rather than the folder, and a claim read out of the record is the only thing
    stopping it. Both notes would look correct, which is what makes it the trap.
  */
  await openFor(SESSION_RETITLED, "Standup", "2026-09-06T13:00:00.000Z");
  failPut = (url) => (url.includes("/meet-recorder/0-inbox/meetings/") ? 500 : null);
  const halfNamed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RETITLED}/finalize`, {});
  check(
    "a finalize whose note write fails has claimed a path under the first title",
    halfNamed.status === 503 && halfNamed.body?.error === "meeting_unavailable"
  );
  failPut = null;
  const inboxBeforeRetitle = keysIn(recorder, "0-inbox/meetings/").length;
  const renamed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RETITLED}/finalize`, {
    body: { title: "Quarterly planning with the whole team" },
  });
  check(
    "a re-finalize with a changed title rewrites one note rather than adding a second",
    renamed.status === 200 &&
      renamed.body?.notePath === `0-inbox/meetings/2026/09/2026-09-06-standup-${SESSION_RETITLED.slice(-8)}.md`
  );
  check(
    "...so the rename adds no second key to the bucket",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeRetitle + 1
  );
  check(
    "...and nothing is filed under the new title's slug",
    !keysIn(recorder, "0-inbox/meetings/").some((key) => key.includes("quarterly-planning"))
  );

  /*
    A refused folder must not lose the meeting. `meeting_invalid` is the code a
    client does not retry, so failing the request over one bad string would park
    forty minutes of somebody's meeting for good — the same argument that makes
    an unusable flag row cost that row rather than the request. It falls back,
    and the ack says so, because a fallback nobody is told about is the silent
    wrong destination this whole change exists to close.
  */
  const inboxBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_ESCAPING, "Aimed outside", "2026-09-06T12:00:00.000Z");
  const escaping = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_ESCAPING}/finalize`, {
    body: { folder: "../../shhh-2026" },
  });
  check(
    "a folder that tries to leave the bucket does not lose the meeting",
    escaping.status === 200 && escaping.body?.state === "complete"
  );
  check("...it is filed at the default instead", escaping.body?.notePath?.startsWith("0-inbox/meetings/") === true);
  check("...and exactly one note appears there", keysIn(recorder, "0-inbox/meetings/").length === inboxBefore + 1);
  check("...the client is told its folder was not used", escaping.body?.folderRejected === true);
  check(
    "...and is not read its own value back",
    !escaping.text.includes("shhh-2026")
  );
  check(
    "...and no key anywhere in the bucket took the folder it asked for",
    ![...recorder.keys()].some((key) => key.includes("shhh-2026") || key.includes(".."))
  );

  await openFor(SESSION_PLUMBING, "Aimed at the plumbing", "2026-09-06T13:00:00.000Z");
  const plumbing = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_PLUMBING}/finalize`, {
    body: { folder: ".meetings" },
  });
  check(
    "a folder naming a dot-prefixed path is refused the same way",
    plumbing.body?.folderRejected === true && plumbing.body?.notePath?.startsWith("0-inbox/meetings/") === true
  );
  check(
    "...so no meeting is filed where `isPlumbing` would hide it from its own owner",
    keysIn(recorder, ".meetings/2026/").length === 0
  );

  /*
    `..` INSIDE a segment, which is a different thing from traversal and used to
    behave like nothing else in this list.

    `normalizeMeetingFolder` delegated to `normalizeRoot`, which refuses a
    segment that *equals* `.` or `..`. `normalizePath` — the gateway's own rule
    for a key — refuses `..` anywhere in the string. So `1-projects/foo..bar`
    passed validation, the claim wrote `1-projects/foo..bar/2026/09/….md` into
    the session record under a conditional write, and every finalize from then
    on answered 400 `meeting_invalid`: the code a client does not retry, on a
    path nothing clears. Only a `null` from the folder validator reaches the
    fallback above, so this class bypassed it completely — a meeting parked for
    good over a folder name a real vault could have.
  */
  const dottedBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_DOTTED, "Aimed at a dotted name", "2026-09-06T16:00:00.000Z");
  const dotted = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_DOTTED}/finalize`, {
    body: { folder: "1-projects/foo..bar" },
  });
  check(
    "a folder with `..` inside a segment does not wedge the meeting",
    dotted.status === 200 && dotted.body?.state === "complete"
  );
  check(
    "...it falls back like every other folder this gateway will not file into",
    dotted.body?.notePath?.startsWith("0-inbox/meetings/") === true &&
      keysIn(recorder, "0-inbox/meetings/").length === dottedBefore + 1
  );
  check("...and the client is told", dotted.body?.folderRejected === true);
  check(
    "...with nothing left anywhere at the name it asked for",
    ![...recorder.keys()].some((key) => key.includes("foo..bar"))
  );

  /*
    THE TIER IS THE PATH'S, AND A CLIENT-NAMED FOLDER DOES NOT BUY A WIDER ONE.
    `1-projects` defaults to `team` in this context's manifest, so a folder
    argument is now a way to ask for a destination whose folder rule differs
    from the inbox's. A personal connection's meeting is still private, with the
    exact override written before the content — the note's tier is decided by
    `privacy.md` and the connection's scope, exactly as `write_note`'s is.
  */
  await openFor(SESSION_TEAM_DEFAULT, "Filed in a team folder", "2026-09-06T14:00:00.000Z");
  const inTeamFolder = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TEAM_DEFAULT}/finalize`,
    { body: { folder: "1-projects/notes" } }
  );
  const teamFolderPath = inTeamFolder.body?.notePath || "";
  check("a personal connection can file into a team-default folder", inTeamFolder.status === 200);
  check(
    "...and the note is still private, because the tier is the connection's and not the folder's",
    (await callTool(env, TOKEN_OWNER, "read_meeting", { path: teamFolderPath })).includes("visibility: private")
  );
  check(
    "...so a team connection cannot read a meeting filed into its own folder",
    (await callTool(env, TOKEN_MEMBER, "read_meeting", { path: teamFolderPath })) === "not found"
  );

  /*
    And the other direction: a team connection may only create team content, in
    a folder whose default is already team. That refusal is unchanged, and the
    folder argument is now the way such a connection reaches a destination it
    *can* write — which is the same rule `toolWriteNote` obeys, not a new one.
  */
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM_FOLDER,
      title: "An editor files properly",
      startedAt: "2026-09-06T15:00:00.000Z",
      events: [{ type: "start", at: "2026-09-06T15:00:00.000Z" }],
    },
  });
  const editorPrivateFolder = await meetingRequest(
    env,
    TOKEN_EDITOR,
    `/meetings/sessions/${SESSION_TEAM_FOLDER}/finalize`,
    { body: { folder: "2-areas/private-by-default" } }
  );
  check(
    "a team connection still cannot name a folder whose default is private",
    editorPrivateFolder.status === 403 && editorPrivateFolder.body?.error === "meeting_forbidden"
  );
  check("...and no note is written when it tries", keysIn(recorder, "2-areas/private-by-default/").length === 0);
  /*
    A second session rather than a retry of that one, because in *this* context
    the default meetings folder is private as well — so a retry could only be
    refused again, for a reason that has nothing to do with the folder it named.

    **The claim that refusal leaves behind is released now, and the sentence
    that used to stand here is corrected rather than dropped.** It said a team
    connection naming a destination its tier may not write "parks that session
    on that path", and called that "the pre-existing behaviour of this route
    ... not something the folder argument introduces". That was false. Before
    `body.folder` existed a team connection could only ever aim at
    `MEETINGS_FOLDER`, so in a context whose default folder is team-visible
    there was no way to wedge at all, and in one whose default is private the
    very first finalize failed — nothing was lost that the person could
    otherwise have had. The folder argument is what made a deterministic
    post-claim refusal reachable in a context that would otherwise work, and a
    sticky claim is what made it permanent. `SESSION_WEDGED` below is that
    case, run in the one context in this file whose default folder a team
    connection *can* write.
  */
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM_ALLOWED,
      title: "An editor files properly",
      startedAt: "2026-09-06T15:30:00.000Z",
      events: [{ type: "start", at: "2026-09-06T15:30:00.000Z" }],
    },
  });
  const editorTeamFolder = await meetingRequest(
    env,
    TOKEN_EDITOR,
    `/meetings/sessions/${SESSION_TEAM_ALLOWED}/finalize`,
    { body: { folder: "1-projects/shared" } }
  );
  check(
    "...while a folder its tier may write is accepted",
    editorTeamFolder.status === 200 && editorTeamFolder.body?.notePath?.startsWith("1-projects/shared/") === true
  );
  check(
    "...and lands at the tier that path earns",
    (await callTool(env, TOKEN_EDITOR, "read_meeting", { path: editorTeamFolder.body.notePath })).includes(
      "visibility: team"
    )
  );

  /*
    A REFUSAL THAT WILL NEVER SUCCEED DOES NOT KEEP THE PATH IT CLAIMED.

    `TOKEN_SHARED` is a team connection in a context whose `0-inbox` default is
    team-visible, so it can finish a meeting — the mainline shared-workspace
    flow. Point it at a folder its tier may not write and the finalize is
    refused at the note write, by which time the claim has already reserved
    that path in the session record. The claim is deliberately sticky across a
    retry, so the sequence was: `finalize {folder}` → 403, `finalize {folder}`
    → 403, **`finalize {}` → 403** — a meeting that could be recorded, could be
    typed into, and could never be written out, over one string the person
    picked in a sheet.

    The claim exists so that a *retryable* failure lands on the same note. A
    refusal that will never succeed has written nothing, so holding the path
    buys nothing and costs the meeting. So a deterministic refusal from the
    note write releases the claim, and only a deterministic one: the storage
    failure two blocks up still keeps it, which is what `the retry lands on the
    path the first finalize claimed` asserts.
  */
  await meetingRequest(env, TOKEN_SHARED, "/meetings/sessions", {
    body: {
      id: SESSION_WEDGED,
      title: "Aimed somewhere its tier cannot reach",
      startedAt: "2026-09-06T17:00:00.000Z",
      events: [{ type: "start", at: "2026-09-06T17:00:00.000Z" }],
    },
  });
  const shared = s3.bucketFor("meet-shared");
  const wedge = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_WEDGED}/finalize`, {
    body: { folder: "2-areas/private-here" },
  });
  check(
    "a team connection naming a folder its tier may not write is still refused",
    wedge.status === 403 && wedge.body?.error === "meeting_forbidden"
  );
  check("...and writes nothing there", keysIn(shared, "2-areas/private-here/").length === 0);
  const unwedged = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_WEDGED}/finalize`, {
    body: {},
  });
  check(
    "...but the meeting is not parked on the path that refusal claimed",
    unwedged.status === 200 && unwedged.body?.state === "complete"
  );
  check(
    "...it finalizes into the default folder its tier can write",
    unwedged.body?.notePath?.startsWith("0-inbox/meetings/") === true
  );
  check(
    "...and the note is really there, with exactly one written for it",
    typeof shared.get(unwedged.body.notePath)?.body === "string" &&
      keysIn(shared, "0-inbox/meetings/").filter((key) => key.includes(SESSION_WEDGED.slice(-8))).length === 1
  );

  /*
    WHICH FAILURES GIVE THE PATH BACK, as a table rather than as one example.

    The refusal above is a 403 and the storage failure further up is a thrown
    `Error`, so between them the suite covers two of the four shapes a note
    write can fail in — and the two it missed are the two that decide whether
    the crash-retry property survives. Measured: a `releaseClaim` with its
    status check deleted, which releases on a `MeetingRefusal(503)` too, went
    green against the whole suite.

    So this drives `handleMeetings` directly with a programmable `publishNote`.
    The rule being pinned: a refusal that will never succeed (400, 403) gives
    the claimed path back, and anything that might work next time (503, a
    thrown storage error) keeps it.
  */
  const releaseCases = [
    { name: "a 400 refusal", error: () => new MeetingRefusal(400, "invalid", "not a note path"), released: true },
    { name: "a 403 refusal", error: () => new MeetingRefusal(403, "forbidden", "not at this tier"), released: true },
    { name: "a 503 refusal", error: () => new MeetingRefusal(503, "unavailable", "the manifest could not be read"), released: false },
    { name: "a storage error", error: () => new Error("the bucket said no"), released: false },
  ];
  for (const [index, releaseCase] of releaseCases.entries()) {
    const store = fakeStore({ conditionalWrite: true });
    const id = `mtg_${"c".repeat(19)}${index}`;
    let refuse = true;
    const publish = async (_store, _scope, { path }) => {
      if (refuse) throw releaseCase.error();
      return { path, etag: "e1", visibility: "private" };
    };
    const call = (path, body) =>
      handleMeetings(
        new Request(`https://mcp.context.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        path,
        store,
        { scope: "private", workspaceId: "ws_release" },
        { publishNote: publish }
      );

    await call("/meetings/sessions", { id, title: "Claimed once", startedAt: "2026-09-06T18:00:00.000Z" });
    await call(`/meetings/sessions/${id}/finalize`, { folder: "2-areas/first" });
    refuse = false;
    const second = await (await call(`/meetings/sessions/${id}/finalize`, {})).json();
    const landed = String(second.notePath || "");
    check(
      releaseCase.released
        ? `${releaseCase.name} gives the claimed path back, so a bare finalize still lands`
        : `${releaseCase.name} keeps the claim, because it might work next time`,
      releaseCase.released
        ? landed.startsWith("0-inbox/meetings/")
        : landed.startsWith("2-areas/first/")
    );
  }

  /*
    The one consequence worth stating rather than discovering. `list_meetings`
    reads the default folder off the bucket, because there is no meetings index
    to consult and nothing records where a meeting was filed — so a meeting the
    person pointed elsewhere is not listed, which is exactly what already
    happens to a meeting its owner *moves*. It is still a note, and every other
    tool reaches it.
  */
  const listAfterFiling = await callTool(env, TOKEN_OWNER, "list_meetings", { limit: 25 });
  check("list_meetings still lists what is in the default folder", listAfterFiling.includes(notePath));
  check(
    "and does not claim a meeting filed elsewhere, the same as one its owner moved",
    !listAfterFiling.includes(filedPath)
  );
  check(
    "...which is still a note, and read_meeting reads it at its own path",
    (await callTool(env, TOKEN_OWNER, "read_meeting", { path: filedPath })).includes(
      "filed where the person pointed it"
    )
  );

  /*
    **And the model is told, because the model is the only one who can act on
    it.** The three checks above prove the behaviour; none of them reads the
    sentence a connected client is actually handed, and for a while that
    sentence said `list_meetings` lists "the meetings the user recorded" — full
    stop, no qualification. An assistant reading that has no reason to look
    further when a meeting is missing, so a meeting somebody deliberately filed
    elsewhere silently did not exist to any client. A tool description is not
    prose about the tool; it is the whole of what the model knows, and a wrong
    one is a defect of the same kind as a wrong return value.

    Asserted on the shape of the claim rather than on the exact wording — the
    folder it names, that it is not everything, and where to go instead — so
    the sentence may be rewritten but not quietly re-broadened.
  */
  const listDefinition = await toolDefinition(env, TOKEN_OWNER, "list_meetings");
  const listedDescription = listDefinition?.description || "";
  check("the tool's own description names the folder it reads", listedDescription.includes("0-inbox/meetings"));
  check(
    "...says it is not every meeting",
    /not necessarily every meeting|does not appear here|not every meeting/i.test(listedDescription)
  );
  check("...and points somewhere for the ones it does not list", listedDescription.includes("search_notes"));

  restoreFailures();
  restoreControlPlane();
  restoreS3();
}
