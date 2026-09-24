/**
 * Shared fixtures for `test/forms/*.test.mjs`, split out of the original
 * forms.test.mjs — see forms.test.mjs for the module overview and the
 * sabotage-testing record.
 */

import worker from "../../src/index.js";
import { readDocument, replaceText } from "@context/collaboration";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";
import {
  newResponseId,
  parseFormBlocks,
  parseResponsesFile,
  renderFormBlock,
  renderResponsesFile,
  responseStamp,
  validateSubmission,
} from "../../src/forms.js";

export {
  worker,
  readDocument,
  replaceText,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createWorkerCtx,
  newResponseId,
  parseFormBlocks,
  parseResponsesFile,
  renderFormBlock,
  renderResponsesFile,
  responseStamp,
  validateSubmission,
};

export const OWNER_TOKEN = `cat_forms_owner_${"0".repeat(16)}`;
export const EDITOR_TOKEN = `cat_forms_editor_${"0".repeat(15)}`;
export const MEMBER_TOKEN = `cat_forms_member_${"0".repeat(15)}`;
export const READONLY_TOKEN = `cat_forms_readonly_${"0".repeat(13)}`;
export const OUTSIDER_TOKEN = `cat_forms_outsider_${"0".repeat(13)}`;
export const NAMELESS_TOKEN = `cat_forms_nameless_${"0".repeat(13)}`;
/** A guest in somebody else's PERSONAL context. See `personalNameFor`. */
export const GUEST_TOKEN = `cat_forms_guest_${"0".repeat(16)}`;

export const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  3-resources: team\n\n" +
  "note_overrides:\n  3-resources/private-notes.md: private\n" +
  // Held to a named group, and nothing else in this file touches it. A group's
  // *name* is membership structure, so it is the sharpest thing a rule can
  // carry and the one a refusal must not read back.
  "  2-areas/leads-answers.md: @supa-leads\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export const BUGS_NOTE = [
  "Found something broken? Log it here.",
  "",
  "```form",
  "id: bugs",
  "responses: 3-resources/bugs.responses.md",
  "layout: sections",
  "submit: member",
  "edit_own: true",
  "votes: named",
  "fields:",
  "  - { name: summary, type: line, max: 120, required: true }",
  "  - { name: severity, type: select, options: [blocker, major, minor] }",
  "  - { name: steps, type: text, max: 4000 }",
  "```",
].join("\n");

export const REQUESTS_NOTE = [
  "```form",
  "id: requests",
  "responses: 3-resources/requests.responses.md",
  "layout: table",
  "submit: member",
  "edit_own: false",
  "show_responses: true",
  "votes: named",
  "fields:",
  "  - { name: title, type: line, max: 120, required: true }",
  "  - { name: area, type: select, options: [mcp, app, search] }",
  "```",
].join("\n");

export const STAFF_NOTE = [
  "```form",
  "id: staff",
  "responses: 3-resources/staff.responses.md",
  "layout: table",
  "submit: editor",
  "votes: off",
  "fields:",
  "  - { name: note, type: line, max: 80 }",
  "```",
].join("\n");

/** An in-memory bucket honouring the conditional writes forms require. */
export function createBucket() {
  const objects = new Map();
  let etags = 0;
  /*
    Storage round trips, counted.

    A refusal that reads the same and costs a different number of trips to
    produce is still two answers. Counted rather than timed, so it is
    deterministic; the number is not the invariant, the equality is.
  */
  let trips = 0;
  const bucket = {
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    trips: () => trips,
    /** Fires once, on the next get of this key, before the value is returned. */
    interceptGet: null,
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    async get(key) {
      trips += 1;
      const stored = objects.get(key);
      if (!stored) return null;
      // The snapshot is taken FIRST and the interleaving write runs after it,
      // which is the only ordering that models the race: this caller has read
      // version N, somebody else lands version N+1, and this caller's write is
      // still holding N. Firing the hook before the read would hand this caller
      // the other response already merged in, and the conditional write would
      // never be exercised at all.
      const snapshot = { body: stored.body, etag: stored.etag };
      if (bucket.interceptGet && bucket.interceptGet.key === key) {
        const fire = bucket.interceptGet;
        bucket.interceptGet = null;
        await fire.run(bucket);
      }
      return {
        etag: snapshot.etag,
        text: async () => snapshot.body,
        arrayBuffer: async () => new TextEncoder().encode(snapshot.body).buffer,
      };
    },
    async put(key, value, options = {}) {
      trips += 1;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key, options = {}) {
      trips += 1;
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      trips += 1;
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
  return bucket;
}

export async function rpc(env, token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const body = await response.json();
  await settle();
  return body;
}

export async function call(env, token, name, args = {}) {
  const body = await rpc(env, token, "tools/call", { name, arguments: args });
  return {
    text: body?.result?.content?.[0]?.text ?? "",
    isError: body?.result?.isError === true,
  };
}

export const pairs = (object) => Object.entries(object).map(([field, value]) => ({ field, value }));

/**
 * Builds the shared fixture the "permissions, through the worker" sections
 * run against: a real control-plane stub, two workspaces (one shared, one
 * for an outsider tenant), personal workspaces for every caller so each has
 * a username to be recorded under, and the grants each section's checks
 * need — including the guest-in-somebody-else's-personal-context and
 * no-handle cases `personalNameFor` has to get right on the write side too.
 *
 * Call `harness.restoreAll()` once, after every section has run, to
 * uninstall the control-plane stub in the same place the original
 * single-function suite's `finally` did.
 */
export async function createFormsHarness() {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();

  const bucket = createBucket();
  const otherBucket = createBucket();

  controlPlane.addWorkspace(
    "ws_forms",
    "forms",
    {
      provider: "r2-binding",
      bindingName: "FORMS_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    },
    { kind: "shared" }
  );
  controlPlane.addWorkspace(
    "ws_other",
    "other",
    {
      provider: "r2-binding",
      bindingName: "OTHER_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    },
    { kind: "shared" }
  );
  // Personal workspaces, so every caller has a username to be recorded under.
  for (const [id, slug] of [
    ["ws_seyi", "seyi"],
    ["ws_ed", "ed"],
    ["ws_dan", "dan"],
    ["ws_ro", "ro"],
    ["ws_out", "out"],
    // A host's personal context, and a guest's own. See `GUEST_TOKEN`.
    ["ws_host", "host"],
    ["ws_guest", "guest"],
  ]) {
    controlPlane.addWorkspace(id, slug, {
      provider: "r2-binding",
      bindingName: "FORMS_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
  }

  await controlPlane.addGrant({
    accessToken: OWNER_TOKEN,
    workspaceId: "ws_forms",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_forms_owner",
    userId: "user_seyi",
    alsoMemberOf: [{ workspaceId: "ws_seyi", role: "owner" }],
  });
  await controlPlane.addGrant({
    accessToken: EDITOR_TOKEN,
    workspaceId: "ws_forms",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_forms_editor",
    userId: "user_ed",
    alsoMemberOf: [{ workspaceId: "ws_ed", role: "owner" }],
  });
  await controlPlane.addGrant({
    accessToken: MEMBER_TOKEN,
    workspaceId: "ws_forms",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_forms_member",
    userId: "user_dan",
    alsoMemberOf: [{ workspaceId: "ws_dan", role: "owner" }],
  });
  // The same membership, through a client its person connected read-only.
  await controlPlane.addGrant({
    accessToken: READONLY_TOKEN,
    workspaceId: "ws_forms",
    role: "member",
    scopes: ["context:read"],
    clientId: "mcp_client_forms_readonly",
    userId: "user_ro",
    alsoMemberOf: [{ workspaceId: "ws_ro", role: "owner" }],
  });
  await controlPlane.addGrant({
    accessToken: OUTSIDER_TOKEN,
    workspaceId: "ws_other",
    role: "owner",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_forms_outsider",
    userId: "user_out",
    alsoMemberOf: [{ workspaceId: "ws_out", role: "owner" }],
  });
  /*
    A caller the control plane gave no handle for — and the ONE dimension
    every other grant in this file holds constant.

    `ws_forms` is `kind: "shared"`, and the loop below it exists so that
    "every caller has a username to be recorded under", as its own comment
    says. Each grant above therefore carries an `alsoMemberOf` naming a
    personal context its person owns, and `personalNameFor` always answers.
    This one covers the shared context and nothing else, so it answers `null`
    — what a stale grant, a self-hosted deployment, or a person past
    `contextsForGrant`'s fifty-context cap looks like.

    It still reaches the form tools, which is the point: the grant asked for
    write and the role is non-empty, so `participatesInForms` is true and the
    write gate's exemption lets it straight through to
    `mutateFormResponses`.
  */
  /*
    A GUEST IN SOMEBODY ELSE'S PERSONAL CONTEXT, WHICH IS THE SHAPE A REAL
    DEFECT TOOK: a guest wore their host's handle, in the host's own note.

    `alsoMemberOf` is ordered, and the host's personal context comes first
    on purpose: the real control plane puts the context a grant was approved
    against at the head of the covered set, so a guest connected to
    `/@host/mcp` really does carry the host's personal context ahead of
    their own. `personalNameFor` must still answer `@guest`, and it is the
    `role === "owner"` clause that makes it — a personal context in the
    covered set is not evidence that it is this person's.

    This grant exists because that predicate decides more here than it does
    on a caret: `actor.name` is written into the response file as `by`, in
    the customer's bucket, permanently — and it is the same value the
    ownership test compares when somebody edits or withdraws a response. A
    predicate that named this guest `@host` would both misattribute their
    answer and hand them the host's.
  */
  await controlPlane.addGrant({
    accessToken: GUEST_TOKEN,
    workspaceId: "ws_forms",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_forms_guest",
    userId: "user_guest",
    alsoMemberOf: [
      { workspaceId: "ws_host", role: "member" },
      { workspaceId: "ws_guest", role: "owner" },
    ],
  });
  await controlPlane.addGrant({
    accessToken: NAMELESS_TOKEN,
    workspaceId: "ws_forms",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_forms_nameless",
    userId: "user_nameless",
    alsoMemberOf: [],
  });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "FORMS_BUCKET,OTHER_BUCKET",
    FORMS_BUCKET: bucket,
    OTHER_BUCKET: otherBucket,
  };

  bucket.seed("privacy.md", MANIFEST);
  bucket.seed("index.md", "# the forms workspace");
  otherBucket.seed("privacy.md", MANIFEST);

  return {
    controlPlane,
    bucket,
    otherBucket,
    env,
    restoreAll() {
      restore?.();
    },
  };
}
