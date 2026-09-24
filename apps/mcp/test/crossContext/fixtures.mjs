/**
 * Shared constants, stubs, request helpers and the harness for
 * `test/crossContext/*.test.mjs`, split out of the single
 * `crossContext.test.mjs` this file used to be part of.
 */

import { gatewaySourceFiles, soleSource } from "../gatewaySource.mjs";

import worker from "../../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";

export const S3_ENDPOINT = "https://s3.example-cross-context.test";

export const TOKEN_OWNER = `cat_cross_owner_${"0".repeat(24)}`;
export const TOKEN_EDITOR = `cat_cross_editor_${"0".repeat(24)}`;
/**
 * Somebody whose *home* context is the one they were invited into.
 *
 * They connected their client to a workspace shared with them, so the grant's own
 * context is one they are only a `member` of — and they are an `editor`
 * somewhere else. This is the fixture that catches re-clamping an
 * already-clamped scope set: the intersection of two roles takes write away
 * from a context where they really have it, which fails closed and looks
 * exactly like a permission bug in the other direction.
 */
export const TOKEN_GUEST = `cat_cross_guest_${"0".repeat(24)}`;
/** A grant that was never given write, anywhere. */
export const TOKEN_READ_ONLY = `cat_cross_readonly_${"0".repeat(22)}`;
/**
 * A read-only grant belonging to somebody who is an `editor` elsewhere.
 *
 * The role says write, the grant says no, and the two are intersected — so this
 * is the fixture that catches an orientation describing another context from
 * the role alone. It is the direction that costs a person an attempt: told
 * "you can read and write team notes there", an agent tries, and the write
 * gate refuses it for a reason orientation never mentioned.
 */
export const TOKEN_READ_ONLY_EDITOR = `cat_cross_ro_editor_${"0".repeat(21)}`;
/**
 * Connected at a context they are only a `member` of, while owning another.
 *
 * The one shape `readsPrivateAnywhere`'s cross-context arm exists for: the
 * default session reads at `team`, so `hasScope` alone answers no, and the
 * scan over `workspaces` is the only thing that can offer an owner-only tool
 * to somebody who owns one of the contexts they reach.
 */
export const TOKEN_VISITOR = `cat_cross_visitor_${"0".repeat(23)}`;
export const TOKEN_OWNER_BOTH = `cat_cross_owner_both_${"0".repeat(20)}`;
/** Somebody in more contexts than one orientation is willing to open. */
export const TOKEN_MANY = `cat_cross_many_${"0".repeat(26)}`;

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * The same, with the front page published to the team.
 *
 * The scaffolded manifest starts everything private, `index.md` included — so a
 * context whose owner has not shared it shows a member no front page at all,
 * which is the correct answer and the boring one. This is the manifest of a
 * context whose owner did share it.
 */
export const PRIVACY_MANIFEST_SHARED_INDEX =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  index.md: team\n```\n\n" +
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
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
      serverSideCopy: "same-store",
    },
    status: "active",
  };
}

export async function callTool(env, tokenValue, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
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
  return body?.result;
}

export const textOf = (result) => result?.content?.[0]?.text || "";

/** The tool names one connection is offered. */
export async function toolNamesFor(env, tokenValue) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }),
    }),
    env,
    ctx
  );
  const names = (JSON.parse(await response.text())?.result?.tools || []).map((tool) => tool.name);
  await settle();
  return names;
}

export {
  gatewaySourceFiles,
  soleSource,
  worker,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
  createWorkerCtx,
};

/**
 * The workspaces, grants and buckets every section runs against: one person
 * owning a context and a member of others, a stranger's context beside them,
 * and an S3 backend whose requests a section can hook. Moved verbatim from the
 * top of `runCrossContextChecks`; what later sections read is returned.
 */
export async function createCrossContextHarness() {
  const s3 = createS3Backend(S3_ENDPOINT);
  const hooks = [];
  const originalHandle = s3.handle;
  s3.handle = async (url, init = {}) => {
    for (const hook of [...hooks]) await hook(url, init);
    return originalHandle(url, init);
  };
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_own", "mine", s3Binding("cross-mine", "AA"));
  controlPlane.addWorkspace("ws_shared", "theirs", s3Binding("cross-theirs", "BB"));
  controlPlane.addWorkspace("ws_stranger", "stranger", s3Binding("cross-stranger", "CC"));
  // A context this person is a member of whose owner never shared its front
  // page — the common case for a freshly scaffolded workspace.
  controlPlane.addWorkspace("ws_quiet", "quiet", s3Binding("cross-quiet", "DD"));
  // Seven more, all pointing at one bucket: this test is about how many
  // contexts orientation opens, not about what is in them.
  for (let n = 1; n <= 7; n += 1) {
    controlPlane.addWorkspace(`ws_extra_${n}`, `extra-${n}`, s3Binding("cross-extra", "EE"));
  }

  // One person, two memberships: owner of their own workspace, plain `member` of
  // somebody else's. The third context exists and is nothing to do with them.
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross",
    userId: "user_cross",
    alsoMemberOf: [
      { workspaceId: "ws_shared", role: "member" },
      { workspaceId: "ws_quiet", role: "member" },
    ],
  });
  // The same shape one rung up, for the write half.
  await controlPlane.addGrant({
    accessToken: TOKEN_EDITOR,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross_editor",
    userId: "user_cross_editor",
    alsoMemberOf: [{ workspaceId: "ws_shared", role: "editor" }],
  });
  // A stranger to `user_cross` is not a stranger to everybody: this person is
  // an editor there, and a plain member of the context they connected from.
  await controlPlane.addGrant({
    accessToken: TOKEN_GUEST,
    workspaceId: "ws_shared",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_cross_guest",
    userId: "user_cross_guest",
    alsoMemberOf: [{ workspaceId: "ws_stranger", role: "editor" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_VISITOR,
    workspaceId: "ws_shared",
    role: "member",
    scopes: ["context:read", "context:private"],
    clientId: "mcp_client_cross_visitor",
    userId: "user_cross",
    alsoMemberOf: [{ workspaceId: "ws_own", role: "owner" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_READ_ONLY,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read"],
    clientId: "mcp_client_cross_readonly",
    userId: "user_cross",
    alsoMemberOf: [{ workspaceId: "ws_shared", role: "member" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_READ_ONLY_EDITOR,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:private"],
    clientId: "mcp_client_cross_readonly_editor",
    userId: "user_cross",
    alsoMemberOf: [{ workspaceId: "ws_shared", role: "editor" }],
  });
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER_BOTH,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross_owner_both",
    userId: "user_cross_owner_both",
    alsoMemberOf: [{ workspaceId: "ws_stranger", role: "owner" }],
  });

  // Somebody in more contexts than one orientation opens.
  const EXTRA = Array.from({ length: 7 }, (_, n) => ({
    workspaceId: `ws_extra_${n + 1}`,
    role: "member",
  }));
  await controlPlane.addGrant({
    accessToken: TOKEN_MANY,
    workspaceId: "ws_own",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_cross_many",
    userId: "user_cross_many",
    alsoMemberOf: EXTRA,
  });

  const mine = s3.bucketFor("cross-mine");
  const theirs = s3.bucketFor("cross-theirs");
  const stranger = s3.bucketFor("cross-stranger");
  mine.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "m0" });
  mine.set("index.md", { body: "MINE-INDEX-MARKER", etag: "mi" });
  mine.set("1-projects/shared-name.md", { body: "MINE-MARKER", etag: "m1" });
  theirs.set("privacy.md", { body: PRIVACY_MANIFEST_SHARED_INDEX, etag: "t0" });
  theirs.set("index.md", { body: "THEIRS-INDEX-MARKER", etag: "ti" });
  theirs.set("1-projects/shared-name.md", { body: "THEIRS-MARKER", etag: "t1" });
  theirs.set("2-areas/kept-private.md", { body: "THEIRS-PRIVATE-MARKER", etag: "t2" });
  // A plugin in somebody else's workspace. `.obsidian/` sits outside the privacy
  // manifest's reach entirely — `isPlumbing` hides it from `read_note`,
  // `list_notes` and search for every role — so `list_plugins` is the only read
  // path into it, and the question is who may take it.
  theirs.set(
    ".obsidian/plugins/theirs-only/manifest.json",
    {
      body: JSON.stringify({
        id: "theirs-only",
        name: "THEIRS-PLUGIN-MARKER",
        version: "1.0.0",
        author: "their-owner",
      }),
      etag: "tp0",
    }
  );

  mine.set(
    ".obsidian/plugins/mine-only/manifest.json",
    {
      body: JSON.stringify({
        id: "mine-only",
        name: "MINE-PLUGIN-MARKER",
        version: "1.0.0",
        author: "me",
      }),
      etag: "mp0",
    }
  );

  const quiet = s3.bucketFor("cross-quiet");
  quiet.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "q0" });
  quiet.set("index.md", { body: "QUIET-PRIVATE-INDEX-MARKER", etag: "q1" });
  const extra = s3.bucketFor("cross-extra");
  extra.set("privacy.md", { body: PRIVACY_MANIFEST_SHARED_INDEX, etag: "e0" });
  extra.set("index.md", { body: "EXTRA-INDEX-MARKER", etag: "e1" });
  stranger.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "s0" });
  stranger.set("1-projects/shared-name.md", { body: "STRANGER-MARKER", etag: "s1" });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
  };

  return { hooks, restoreS3, controlPlane, restoreControlPlane, mine, theirs, stranger, env };
}
