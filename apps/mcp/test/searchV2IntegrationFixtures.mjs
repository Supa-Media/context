/**
 * Shared fixtures for the v2 integration checks: buckets, tokens, the tool call and the stored index. See searchV2Integration.test.mjs for the checks they serve.
 */

import worker from "../src/index.js";
import { MANIFEST_KEY, parseManifest, parseShard, shardKey } from "../src/search/shards.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

/** Mirrors `SEARCH_SUBREQUEST_BUDGET` / `SEARCH_RESULT_LIMIT` in src/index.js. */
export const SEARCH_SUBREQUEST_BUDGET = 40;
export const SEARCH_RESULT_LIMIT = 10;
/** Every tool call reads `privacy.md` before it dispatches; not the search's to spend. */
export const PRIVACY_MANIFEST_READ = 1;
/** Cloudflare's per-invocation ceiling on the free tier — the real limit. */
export const SUBREQUEST_LIMIT = 50;

export const MAIN_OWNER_TOKEN = `cat_searchv2_owner_${"0".repeat(17)}`;
export const MAIN_TEAM_TOKEN = `cat_searchv2_member_${"0".repeat(16)}`;
// The same team member, connected through ChatGPT (the client name selects the dialect).
export const MAIN_TEAM_CHATGPT_TOKEN = `cat_searchv2_member_chatgpt_${"0".repeat(8)}`;
export const WIDE_TOKEN = `cat_searchv2_wide_${"0".repeat(18)}`;
export const SPREAD_TOKEN = `cat_searchv2_spread_${"0".repeat(16)}`;

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n  1-projects/vault: private\n" +
  "  2-areas: team\n  3-resources: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/**
 * An in-memory bucket that pages and delimits the way R2 does, reports an etag
 * per listed object as R2 and S3 both do, and counts every call.
 *
 * A local copy of the pattern in `searchIntegration.test.mjs` rather than an
 * import of it: a fixture shared between two files is a fixture neither file
 * can change, and this one counts deletes, which that one does not.
 */
export function createBucket() {
  const objects = new Map();
  let etags = 0;
  const counts = { get: 0, head: 0, put: 0, list: 0, delete: 0, puts: [], deletes: [], noteGets: [], getKeys: [] };
  const failGetKeys = new Set();

  const api = {
    objects,
    counts,
    failGetKeys,
    listEtags: true,
    resetCounts() {
      counts.get = 0;
      counts.head = 0;
      counts.put = 0;
      counts.list = 0;
      counts.delete = 0;
      counts.puts = [];
      counts.deletes = [];
      counts.noteGets = [];
      counts.getKeys = [];
    },
    /** Every store op one call spent, which is what the budget is about. */
    get ops() {
      return counts.get + counts.head + counts.put + counts.list + counts.delete;
    },
    seed(key, body, uploaded = new Date()) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded });
    },
    remove(key) {
      objects.delete(key);
    },
    async get(key) {
      counts.get += 1;
      counts.getKeys.push(key);
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
      counts.puts.push(key);
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      counts.delete += 1;
      counts.deletes.push(key);
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

export function storedManifest(bucket) {
  const raw = bucket.objects.get(MANIFEST_KEY);
  return raw ? parseManifest(raw.body) : null;
}

/** Every doc path the stored v2 index holds, across every shard the manifest names. */
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

/** The note paths a `search_notes` answer actually listed, in the order it listed them. */
export function pathsIn(text) {
  return (String(text).match(/^\S+\.md$/gm) || []).filter((line) => !line.startsWith("["));
}

/**
 * The count line a `search_notes` answer opens with, parsed the way a reader
 * meets it: the number, and whether it carries the census's floor mark.
 *
 * Read off the rendered text rather than off `searchVisibleNotes`'s return,
 * because the `+` is the whole of the claim — a floor a caller cannot tell
 * from a total is not a floor, it is a wrong number with a flag set behind it.
 */
export function reportedCount(text) {
  const match = /^(\d+)(\+?) matching notes?/m.exec(String(text));
  return match ? { count: Number(match[1]), isFloor: match[2] === "+" } : null;
}

export const utf8 = new TextEncoder();
export const byteLength = (value) => utf8.encode(value).byteLength;

export async function seedV2World(controlPlane) {
  const main = createBucket();
  const wide = createBucket();
  const spread = createBucket();

  for (const [workspace, slug, binding] of [
    ["ws_v2_main", "v2main", "V2_MAIN_BUCKET"],
    ["ws_v2_wide", "v2wide", "V2_WIDE_BUCKET"],
    ["ws_v2_spread", "v2spread", "V2_SPREAD_BUCKET"],
  ]) {
    controlPlane.addWorkspace(workspace, slug, {
      provider: "r2-binding",
      bindingName: binding,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
  }
  for (const [token, workspace, role, scopes, client, user] of [
    [
      MAIN_OWNER_TOKEN,
      "ws_v2_main",
      "owner",
      ["context:read", "context:write", "context:private"],
      "owner",
      "u_v2_owner",
    ],
    [MAIN_TEAM_TOKEN, "ws_v2_main", "editor", ["context:read"], "member", "u_v2_member"],
    [WIDE_TOKEN, "ws_v2_wide", "owner", ["context:read", "context:private"], "wide", "u_v2_wide"],
    [
      SPREAD_TOKEN,
      "ws_v2_spread",
      "owner",
      ["context:read", "context:private"],
      "spread",
      "u_v2_spread",
    ],
  ]) {
    await controlPlane.addGrant({
      accessToken: token,
      workspaceId: workspace,
      role,
      scopes,
      clientId: `mcp_client_searchv2_${client}`,
      userId: user,
    });
  }

  await controlPlane.addGrant({
    accessToken: MAIN_TEAM_CHATGPT_TOKEN,
    workspaceId: "ws_v2_main",
    role: "editor",
    scopes: ["context:read"],
    clientId: "mcp_client_searchv2_chatgpt",
    clientName: "ChatGPT",
    userId: "u_v2_member",
  });

  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace,
    GATEWAY_SECRET,
    NATIVE_BINDINGS: "V2_MAIN_BUCKET,V2_WIDE_BUCKET,V2_SPREAD_BUCKET",
    V2_MAIN_BUCKET: main,
    V2_WIDE_BUCKET: wide,
    V2_SPREAD_BUCKET: spread,
  };
  return { main, wide, spread, env };
}
