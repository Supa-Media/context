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
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { MEETING_PREFIX, conflictSafeWrites, writeSession } from "../src/meetings/state.js";
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

/** Ids in the contract's shape: `mtg_` plus 20 lowercase base32 characters. */
const idOf = (letter) => `mtg_${letter.repeat(20)}`;
const SESSION_MAIN = idOf("a");
const SESSION_NEVER_ISSUED = idOf("b");
const SESSION_STORAGE_FAILURE = idOf("c");
const SESSION_CONFLICT = idOf("d");
const SESSION_TEAM = idOf("e");
const SESSION_FORGED = idOf("g");
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

  const receipt = rawRecord();
  check("the in-flight record becomes a completion receipt", receipt.state === "complete");
  check("naming the note it wrote", receipt.notePath === notePath);
  check("keeping the count", receipt.segmentCount === 3);
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
    body: { id: idOf("f"), startedAt: "2026-09-01T09:00:00.000Z" },
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

  restoreFailures();
  restoreControlPlane();
  restoreS3();
}
