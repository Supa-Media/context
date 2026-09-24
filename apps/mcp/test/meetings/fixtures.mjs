/**
 * Shared fixtures for `test/meetings/*.test.mjs`, split out of the original
 * meetings.test.mjs — see meetings.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import worker from "../../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";
import {
  LIMITS,
  MEETING_PREFIX,
  assertSessionWithinLimits,
  MeetingRefusal,
  conflictSafeWrites,
  writeSession,
} from "../../src/meetings/state.js";
import { SessionRefusal, sessionForContext, splitWorkspacePath } from "../../src/session.js";
import { handleMeetings } from "../../src/meetings/ingest.js";
import { MEETING_TRANSITIONS } from "../../../../packages/meetings/src/protocol.js";

export {
  worker,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
  createWorkerCtx,
  LIMITS,
  MEETING_PREFIX,
  assertSessionWithinLimits,
  MeetingRefusal,
  conflictSafeWrites,
  writeSession,
  SessionRefusal,
  sessionForContext,
  splitWorkspacePath,
  handleMeetings,
  MEETING_TRANSITIONS,
};

export const S3_ENDPOINT = "https://s3.example-meetings.test";

/** A transcription service that does not exist, answered by the fetch layer. */
export const TRANSCRIBE_ORIGIN = "https://transcribe.example-meetings.test";
export const TRANSCRIBE_SECRET = "fake-transcribe-secret-not-a-real-one";

export const TOKEN_OWNER = `cat_meet_owner_${"0".repeat(24)}`;
export const TOKEN_NEIGHBOUR = `cat_meet_neighbour_${"0".repeat(22)}`;
/** An owner whose grant was never given write. */
export const TOKEN_READ_ONLY = `cat_meet_readonly_${"0".repeat(22)}`;
/** A full-scope grant held by somebody whose role in this context is `member`. */
export const TOKEN_MEMBER = `cat_meet_member_${"0".repeat(24)}`;
/** An editor: write, but team tier — no private content, ever. */
export const TOKEN_EDITOR = `cat_meet_editor_${"0".repeat(24)}`;
/** An editor in a context whose meetings folder defaults to `team`, so it CAN finalize. */
export const TOKEN_SHARED = `cat_meet_shared_${"0".repeat(24)}`;
/** An owner whose bucket accepts a conditional write and ignores it. */
export const TOKEN_LAST_WRITER = `cat_meet_lastwriter_${"0".repeat(20)}`;

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
export const claimed = new Set();
export const idOf = (letter) => {
  if (claimed.has(letter)) {
    throw new Error(`the meeting-id character ${letter} is already bound to a fixture`);
  }
  claimed.add(letter);
  return `mtg_${letter.repeat(20)}`;
};
export const SESSION_MAIN = idOf("a");
export const SESSION_NEVER_ISSUED = idOf("b");
export const SESSION_STORAGE_FAILURE = idOf("c");
export const SESSION_CONFLICT = idOf("d");
export const SESSION_TEAM = idOf("e");
export const SESSION_FORGED = idOf("g");
/**
 * Never opened: the id a refused transcription engine is offered under.
 *
 * A digit rather than a letter because every letter in `MEETING_ID_ALPHABET`
 * is already bound. It used to be `m`, which `SESSION_IN_FLIGHT` also holds —
 * and that one *is* opened, in the same store, so "never opened" was only true
 * of this fixture because the check above it happens to run first.
 */
export const SESSION_BAD_ENGINE = idOf("3");
/** A meeting nobody recorded: typed notes, and no `start` event ever sent. */
export const SESSION_TYPED_ONLY = idOf("h");
/** Opened while a workspace calls itself `meetings`. It must still be ours. */
export const SESSION_SHADOWED = idOf("j");
/** Recorded into a bucket whose backend ignores `If-Match`. */
export const SESSION_DEGRADED = idOf("k");
/** Still recording while a team-tier connection goes looking for it. */
export const SESSION_IN_FLIGHT = idOf("m");
/** Finalized by a team connection, in a context whose meetings folder is team. */
export const SESSION_SHARED = idOf("n");
/** Filed where the person pointed it, rather than into the inbox. */
export const SESSION_FILED = idOf("p");
/** Finalized with a folder that tries to leave the bucket. */
export const SESSION_ESCAPING = idOf("q");
/** Its first finalize claims a path and the write fails; the retry names another folder. */
export const SESSION_RECLAIMED = idOf("r");
/** An editor aiming at a folder its tier may not write to. */
export const SESSION_TEAM_FOLDER = idOf("s");
/** Aimed at the gateway's own plumbing. */
export const SESSION_PLUMBING = idOf("t");
/** An owner filing into a team folder: the folder must not widen the note. */
export const SESSION_TEAM_DEFAULT = idOf("v");
/** An editor filing into a folder its tier may actually write to. */
export const SESSION_TEAM_ALLOWED = idOf("w");
/** The same claim window as `SESSION_RECLAIMED`, with the *title* renamed instead. */
export const SESSION_RETITLED = idOf("y");
/** A team connection naming a folder its tier may not write, in a context whose default it can. */
export const SESSION_WEDGED = idOf("x");
/** Aimed at a folder with `..` inside a segment: legal to `normalizeRoot`, refused by `normalizePath`. */
export const SESSION_DOTTED = idOf("f");
export const SESSION_ENCODED = idOf("6");
export const SESSION_SPACED = idOf("7");
/**
 * The id a read-only grant tries to open a session under, and must not.
 *
 * Named rather than inline, and its own character rather than `f`. Sharing
 * `SESSION_DOTTED`'s id was harmless only for as long as this request stays a
 * 403 that writes nothing: the day a read-only grant could open a session, the
 * `..`-in-a-segment finalize would be running against a session opened here
 * with a different title and start time.
 */
export const SESSION_READ_ONLY_DENIED = idOf("4");
/**
 * Opened one attendee over the ceiling, in the bounds fixture's own store.
 *
 * Named rather than inline, and its own character rather than `y`. It is in a
 * different store from `SESSION_RETITLED` today, which is the only reason
 * sharing an id cost nothing — and "a different store" is a property of the
 * block it sits in rather than of the id, so it is not a thing to rely on.
 */
export const SESSION_CROWDED = idOf("5");
/** The meeting the transcription route is exercised against. */
export const SESSION_TRANSCRIBE = idOf("8");

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

export async function meetingRequest(env, token, path, { method = "POST", body, raw } = {}) {
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
export async function toolDefinition(env, token, name) {
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

export async function callTool(env, token, name, args = {}) {
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

export const segment = (id, startMs, text, speaker = "Ada Lovelace") => ({
  id,
  startMs,
  endMs: startMs + 3_000,
  text,
  speaker,
  channel: "mic",
  confidence: 0.9,
});

/** Keys in one of the in-memory buckets, so a test can look at what was written. */
export function keysIn(bucket, prefix) {
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
export function fakeStore({ conditionalWrite }) {
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
/**
 * Builds the shared fixture every meetings section runs against: a real S3
 * backend and control-plane stub over HTTP, a "recorder" workspace and a
 * "neighbour" workspace on the same endpoint (so isolation checks have an
 * actual adjacent tenant to fail against), and one `fetch` layer above both
 * that can be told to fail a single write or answer the transcription
 * service.
 *
 * `harness.failPut` and `harness.transcribeAnswer` are plain mutable
 * properties — a section sets them for the duration of one check and resets
 * them to `null` afterwards — read by the installed fetch shim below on every
 * call, exactly as the `let failPut` / `let transcribeAnswer` locals they
 * replace were.
 *
 * Call `harness.restoreAll()` once, after every section has run, to restore
 * `globalThis.fetch` and uninstall the control-plane and S3 stubs in the same
 * order the original single-function suite did.
 */
export async function createMeetingHarness() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  const harness = {
    s3,
    controlPlane,
    /**
     * One `fetch` layer above both, so a single storage write can be made to
     * fail. Installed last, so it sees the request first and hands everything
     * it is not interested in down the chain.
     */
    failPut: null,
    /**
     * The transcription service, when a check has configured one.
     *
     * Every request to it is recorded, so "nothing was forwarded" is an
     * assertion rather than a hope — which is the whole point for the checks
     * about refusals: a refusal that still bought the inference it was
     * refusing is not a refusal.
     */
    transcribeCalls: [],
    transcribeAnswer: null,
  };

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init?.method || "GET").toUpperCase();
    if (url.startsWith(TRANSCRIBE_ORIGIN)) {
      harness.transcribeCalls.push({ url, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? "{}") });
      return harness.transcribeAnswer
        ? harness.transcribeAnswer()
        : new Response(JSON.stringify({ segments: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
    }
    if (harness.failPut && method === "PUT") {
      const verdict = harness.failPut(url);
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

  harness.recorder = recorder;
  harness.neighbour = neighbour;
  harness.env = env;
  harness.restoreAll = () => {
    restoreFailures();
    restoreControlPlane();
    restoreS3();
  };
  return harness;
}
