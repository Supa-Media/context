/**
 * Shared fixtures for `test/searchIntegration/*.test.mjs`, split out of the
 * original searchIntegration.test.mjs — see searchIntegration.test.mjs for
 * the module overview and the sabotage-testing record.
 */

import worker from "../../src/index.js";
import { R2Store } from "../../src/store/r2.js";
import {
  NOTE_INDEX_CHAR_CAP,
  SEARCH_INDEX_KEY,
  createSearchBudget,
  defaultIsIndexable,
  syncIndex,
} from "../../src/search/maintain.js";
import {
  MANIFEST_KEY,
  loadIndexManifest,
  parseManifest,
  parseShard,
  serializeManifest,
  shardKey,
  syncShardedIndex,
} from "../../src/search/shards.js";
import { searchIndex } from "../../src/search/query.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";

/** Mirrors `SEARCH_SUBREQUEST_BUDGET` / `SEARCH_RESULT_LIMIT` in src/index.js. */
export const SEARCH_SUBREQUEST_BUDGET = 40;
export const SEARCH_RESULT_LIMIT = 10;
/** Mirrors `MAX_RESULTS` in src/search/query.js, asserted below rather than trusted. */
export const RANK_CAP = 50;
/**
 * Every tool call reads `privacy.md` before it dispatches, and that read is not
 * the search's to spend. Counted separately so the budget assertions are about
 * the budget rather than about how many things happen to touch the bucket.
 */
export const PRIVACY_MANIFEST_READ = 1;
/** Cloudflare's per-invocation ceiling on the free tier — the real limit. */
export const SUBREQUEST_LIMIT = 50;

export const OWNER_TOKEN = `cat_searchidx_owner_${"0".repeat(16)}`;
export const TEAM_TOKEN = `cat_searchidx_member_${"0".repeat(15)}`;
export const BIG_TOKEN = `cat_searchidx_big_${"0".repeat(18)}`;
export const BROKEN_TOKEN = `cat_searchidx_broken_${"0".repeat(15)}`;
export const DEEP_TOKEN = `cat_searchidx_deep_${"0".repeat(17)}`;

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  1-projects/vault: private\n" +
  "  2-areas: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object the way R2 and S3 both do, and counts every call.
 *
 * The hooks are how the failure modes get reached without monkey-patching the
 * modules under test: `failGetKeys` makes one key unreadable (a storage error
 * mid-sync), and `onBeforePut` is what lets a conditional write lose a race it
 * really ran.
 */
export function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, head: 0, put: 0, list: 0, noteGets: [] };
  const failGetKeys = new Set();
  let onBeforePut = null;

  const api = {
    objects,
    counts,
    failGetKeys,
    /** Off for the Dropbox-shaped backend, whose listings carry no etag. */
    listEtags: true,
    setBeforePut(hook) {
      onBeforePut = hook;
    },
    resetCounts() {
      counts.get = 0;
      counts.head = 0;
      counts.put = 0;
      counts.list = 0;
      counts.noteGets = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.head + counts.put + counts.list;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      if (key.endsWith(".md") && key !== "privacy.md") counts.noteGets.push(key);
      if (failGetKeys.has(key)) throw new Error("storage backend refused the read");
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async head(key) {
      counts.head += 1;
      const stored = objects.get(key);
      return stored
        ? { etag: stored.etag, size: new TextEncoder().encode(stored.body).byteLength }
        : null;
    },
    async put(key, value, options = {}) {
      counts.put += 1;
      if (onBeforePut) onBeforePut(key, options);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      counts.list += 1;
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
          page.push({
            key,
            size: stored.body.length,
            uploaded: stored.uploaded,
            ...(api.listEtags ? { etag: stored.etag } : {}),
          });
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
  return api;
}

export async function callTool(env, token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
  const result = (await response.json())?.result;
  // The worker finishes the search index after its response, on the same
  // subrequest counter the answer spent from. Settling here is what makes an
  // op count a count of one whole invocation rather than of whatever part of
  // the deferred pass happened to have run.
  await settle();
  return result;
}

export async function searchText(env, token, args) {
  return (await callTool(env, token, "search_notes", args))?.content?.[0]?.text;
}

/**
 * The gateway answers from the sharded index now, so "what did the worker
 * build" is a manifest plus its shard objects rather than one parsed blob —
 * which is what the three helpers below read. The v1 module checks further
 * down still drive `syncIndex` directly and read its object by key, because
 * they are checks about that module rather than about the gateway.
 */
export function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  return raw ? parseManifest(raw.body) : null;
}

/** Every doc path the stored v2 index holds, across every shard it names. */
export function indexedPaths(bucket) {
  const manifest = storedManifest(bucket);
  if (!manifest) return null;
  const paths = [];
  for (let id = 0; id < manifest.shardCount; id += 1) {
    const raw = bucket.objects.get(shardKey(id));
    const shard = raw ? parseShard(raw.body) : null;
    if (shard) paths.push(...shard.docs.keys());
  }
  return paths;
}

/** Every v2 object gone, which is what "nothing has indexed this bucket" means. */
export function removeV2Index(bucket) {
  for (const key of [...bucket.objects.keys()]) {
    if (key.startsWith(".context/search/v2/")) bucket.remove(key);
  }
}

/**
 * The v2 sync run to convergence, standing in for the many searches a real
 * context would spend getting there. The fixtures below use it wherever they
 * need the *whole* bucket indexed before a worker search asks a question about
 * ranking or about counts.
 */
export async function convergeV2(store) {
  let pass = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    pass = await syncShardedIndex(store, { budget: createSearchBudget(300) });
    if (pass.pending === 0) break;
  }
  return pass;
}

export {
  worker,
  R2Store,
  NOTE_INDEX_CHAR_CAP,
  SEARCH_INDEX_KEY,
  createSearchBudget,
  defaultIsIndexable,
  syncIndex,
  MANIFEST_KEY,
  loadIndexManifest,
  parseManifest,
  parseShard,
  serializeManifest,
  shardKey,
  syncShardedIndex,
  searchIndex,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createWorkerCtx,
};

/**
 * The arrange phase shared by every section: a control-plane stub, the four
 * buckets the original function built inline, their workspaces and grants,
 * and the env that wires them together. Seeding each bucket's contents is
 * left to the sections, since each scenario seeds differently.
 */
export async function createSearchIntegrationHarness() {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  const bucket = createBucket();
  const big = createBucket();
  const broken = createBucket();
  // Its own bucket, so the per-note cap's fixtures cannot disturb the counts
  // the shared one is asserted on.
  const deep = createBucket();

  for (const [workspace, slug, binding] of [
    ["ws_search", "search", "SEARCH_BUCKET"],
    ["ws_search_big", "searchbig", "BIG_BUCKET"],
    ["ws_search_broken", "searchbroken", "BROKEN_BUCKET"],
    ["ws_search_deep", "searchdeep", "DEEP_BUCKET"],
  ]) {
    controlPlane.addWorkspace(workspace, slug, {
      provider: "r2-binding",
      bindingName: binding,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
  }
  for (const [token, workspace, role, scopes, client, user] of [
    [OWNER_TOKEN, "ws_search", "owner", ["context:read", "context:write", "context:private"], "owner", "u_owner"],
    [TEAM_TOKEN, "ws_search", "editor", ["context:read"], "member", "u_member"],
    [BIG_TOKEN, "ws_search_big", "owner", ["context:read", "context:private"], "big", "u_big"],
    [BROKEN_TOKEN, "ws_search_broken", "owner", ["context:read", "context:private"], "broken", "u_broken"],
    [DEEP_TOKEN, "ws_search_deep", "owner", ["context:read", "context:private"], "deep", "u_deep"],
  ]) {
    await controlPlane.addGrant({
      accessToken: token,
      workspaceId: workspace,
      role,
      scopes,
      clientId: `mcp_client_searchidx_${client}`,
      userId: user,
    });
  }

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "SEARCH_BUCKET,BIG_BUCKET,BROKEN_BUCKET,DEEP_BUCKET",
    SEARCH_BUCKET: bucket,
    BIG_BUCKET: big,
    BROKEN_BUCKET: broken,
    DEEP_BUCKET: deep,
  };

  return { controlPlane, restore, bucket, big, broken, deep, env };
}

