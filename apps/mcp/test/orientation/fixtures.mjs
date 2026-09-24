/**
 * Shared fixtures for `test/orientation/*.test.mjs`, split out of the
 * original orientation.test.mjs — see orientation.test.mjs for the module
 * overview and the sabotage-testing record.
 */

import worker from "../../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";

export { worker, CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createWorkerCtx };

export const OWNER_TOKEN = `cat_orientation_owner_${"0".repeat(14)}`;
export const TEAM_TOKEN = `cat_orientation_member_${"0".repeat(13)}`;
export const BROKEN_TOKEN = `cat_orientation_broken_${"0".repeat(13)}`;
export const WIDE_TOKEN = `cat_orientation_wide_${"0".repeat(15)}`;
/** Where the person's context must have finished — `INSTRUCTIONS_SKETCH_BUDGET`. */
export const SKETCH_BUDGET = 3_500;
/** Where a Claude Code session was seen cutting this payload, 2026-09-23. */
export const OBSERVED_CLIENT_CUT = 4_083;

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  2-areas: team\n" +
  "  2-areas/vault: private\n  3-resources: team\n\n" +
  "note_overrides:\n  3-resources/refs/draft.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does.
 *
 * `limit` is spent on keys examined rather than rows returned — a collapsed
 * prefix costs a key, same as R2 — because a stub that pages more generously
 * than the real backend would let a budget bug through.
 */
export function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    objects,
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const from = cursor ? keys.findIndex((key) => key > cursor) : 0;
      if (from === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
      const page = [];
      const prefixes = new Set();
      let index = from;
      for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
        const key = keys[index];
        const remainder = key.slice(prefix.length);
        const slash = delimiter ? remainder.indexOf(delimiter) : -1;
        if (slash === -1) {
          const stored = objects.get(key);
          page.push({ key, size: stored.body.length, uploaded: stored.uploaded });
        } else {
          prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
        }
      }
      const truncated = index < keys.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        cursor: truncated ? keys[index - 1] : undefined,
      };
    },
  };
}

/** A bucket that is bound, reachable in the control plane, and answers nothing. */
export function createDeadBucket() {
  const fail = async () => {
    throw new Error("storage backend is unreachable");
  };
  return { get: fail, put: fail, delete: fail, list: fail };
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
  // The worker finishes the search index after its response; that work spends
  // the same subrequest counter, so a measurement taken before it lands is a
  // measurement of half an invocation.
  await settle();
  return { status: response.status, body };
}

export async function orientText(env, token) {
  const { body } = await rpc(env, token, "tools/call", { name: "orient", arguments: {} });
  return body?.result?.content?.[0]?.text || "";
}

/**
 * The arrange phase shared by every section: a control-plane stub, three
 * buckets and the workspaces/grants/env that wire them together. Seeding the
 * buckets' contents is left to the sections, since each scenario seeds
 * differently.
 */
export async function createOrientationHarness() {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  const bucket = createBucket();
  const dead = createDeadBucket();
  const wide = createBucket();

  for (const [workspace, slug, binding] of [
    ["ws_large", "large", "LARGE_BUCKET"],
    ["ws_dead", "dead", "DEAD_BUCKET"],
  ]) {
    controlPlane.addWorkspace(workspace, slug, {
      provider: "r2-binding",
      bindingName: binding,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
  }
  await controlPlane.addGrant({
    accessToken: OWNER_TOKEN,
    workspaceId: "ws_large",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_orientation_owner",
    userId: "user_orientation_owner",
  });
  await controlPlane.addGrant({
    accessToken: TEAM_TOKEN,
    workspaceId: "ws_large",
    role: "editor",
    scopes: ["context:read"],
    clientId: "mcp_client_orientation_member",
    userId: "user_orientation_member",
  });
  // The worst case the connect sketch has to fit: a long front page, a wide
  // root, and a person in more workspaces than anyone names in one line —
  // every name long enough to meet the per-name cap, so each line is limited
  // by its character budget rather than by its count.
  controlPlane.addWorkspace("ws_wide", "wide", {
    provider: "r2-binding",
    bindingName: "WIDE_BUCKET",
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  });
  const wideMemberships = [];
  for (let n = 1; n <= 30; n += 1) {
    const id = `ws_wide_member_${n}`;
    controlPlane.addWorkspace(id, `${"a-workspace-near-the-name-cap-".repeat(2)}${n}`, {
      provider: "r2-binding",
      bindingName: "WIDE_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    wideMemberships.push({ workspaceId: id, role: "member" });
  }
  await controlPlane.addGrant({
    accessToken: WIDE_TOKEN,
    workspaceId: "ws_wide",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_orientation_wide",
    userId: "user_orientation_wide",
    alsoMemberOf: wideMemberships,
  });
  await controlPlane.addGrant({
    accessToken: BROKEN_TOKEN,
    workspaceId: "ws_dead",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_orientation_broken",
    userId: "user_orientation_broken",
  });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "LARGE_BUCKET,DEAD_BUCKET,WIDE_BUCKET",
    LARGE_BUCKET: bucket,
    DEAD_BUCKET: dead,
    WIDE_BUCKET: wide,
  };

  return { controlPlane, restore, bucket, dead, wide, env };
}
