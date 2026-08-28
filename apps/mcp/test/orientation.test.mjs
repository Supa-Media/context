/**
 * Orientation: the budgeted walk, and the handshake that must not depend on it.
 *
 * `orient` is the first thing a connected agent calls and the only thing that
 * tells it what is in here, so it has two failure modes that matter and neither
 * is a privacy bug (those live in `test.mjs`, against the shared fixture):
 *
 * 1. **It lies about size.** The walk is bounded — it runs against a bucket we
 *    do not own, on the customer's request quota — so a context bigger than the
 *    budget must report a floor. A precise-looking number that is not the truth
 *    is the bug this repository has already shipped twice.
 * 2. **It takes the connection down with it.** The connect-time instructions
 *    now carry a live sketch of the context, which means a slow bucket, a
 *    revoked key, or a `privacy.md` somebody broke in Obsidian is suddenly on
 *    the path of the handshake. It must degrade to the static text, never fail.
 *
 * The shared suite's in-memory bucket returns every key in one page and ignores
 * `delimiter`, which is fine for privacy semantics and useless for both of the
 * above. This file therefore stands up its own bucket that paginates honestly
 * and collapses delimited prefixes the way R2 does.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **`listBoundedKeys` given no page cap** (walk everything, never truncate).
 *    2 checks failed: the floor markers on the folder line and on its children.
 *    The *total* stayed honest, because a second folder here cannot be walked
 *    at all — which is why the floor has two independent causes and both are
 *    asserted.
 * 2. **The per-folder `try` widened to one outer `try`**, as it was in the
 *    first draft of the note census. 9 checks failed: one folder with a
 *    backslash in its name emptied the entire survey.
 * 3. **`instructionsForSession` allowed to throw** (the `catch` removed). 2
 *    checks failed — but only after the handshake check was tightened from
 *    "HTTP 200" to "carries a result". A thrown handler is answered with a
 *    JSON-RPC error over HTTP 200, so the first version of that check called a
 *    client that could not connect a successful connection.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";

const OWNER_TOKEN = `cat_orientation_owner_${"0".repeat(14)}`;
const TEAM_TOKEN = `cat_orientation_member_${"0".repeat(13)}`;
const BROKEN_TOKEN = `cat_orientation_broken_${"0".repeat(13)}`;

const PRIVACY_MANIFEST =
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
function createBucket() {
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
function createDeadBucket() {
  const fail = async () => {
    throw new Error("storage backend is unreachable");
  };
  return { get: fail, put: fail, delete: fail, list: fail };
}

async function rpc(env, token, method, params) {
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    { waitUntil() {} }
  );
  return { status: response.status, body: await response.json() };
}

async function orientText(env, token) {
  const { body } = await rpc(env, token, "tools/call", { name: "orient", arguments: {} });
  return body?.result?.content?.[0]?.text || "";
}

export async function runOrientationChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    const dead = createDeadBucket();

    for (const [workspace, slug, binding] of [
      ["ws_large", "large", "LARGE_BUCKET"],
      ["ws_dead", "dead", "DEAD_BUCKET"],
    ]) {
      controlPlane.addWorkspace(workspace, slug, {
        provider: "r2-binding",
        bindingName: binding,
        capabilities: { conditionalWrite: true },
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
      NATIVE_BINDINGS: "LARGE_BUCKET,DEAD_BUCKET",
      LARGE_BUCKET: bucket,
      DEAD_BUCKET: dead,
    };

    bucket.seed("privacy.md", PRIVACY_MANIFEST);
    bucket.seed("index.md", "# The front page\n\nShipping the gateway.");
    // Older than everything else, so a recency list that ignores timestamps and
    // falls back to key order would put it first and be caught.
    bucket.seed("2-areas/vault/old-secret.md", "private", new Date("2020-01-01T00:00:00Z"));
    bucket.seed("2-areas/handbook.md", "team reference", new Date("2024-06-01T00:00:00Z"));
    bucket.seed(
      "1-projects/gateway/decision.md",
      "the decision",
      new Date(Date.now() - 3 * 60 * 60 * 1000)
    );
    // One folder past the walk budget: five pages of a thousand keys.
    for (let index = 0; index < 5_001; index += 1) {
      bucket.seed(
        `1-projects/bulk/note-${String(index).padStart(5, "0")}.md`,
        "bulk",
        new Date("2023-01-01T00:00:00Z")
      );
    }
    // A team-readable folder whose only note is privately overridden: visible
    // as a place, empty of anything a colleague may read.
    bucket.seed("3-resources/refs/draft.md", "not for the team", new Date("2024-01-01T00:00:00Z"));
    // A folder name the storage adapter refuses outright. Seeded straight into
    // the backing map, because `assertSafeKey` is exactly what stops it being
    // written through the adapter — and rclone or Obsidian are under no such
    // obligation.
    bucket.seed("1-projects\\legacy/note.md", "written by something else");

    const owner = await orientText(env, OWNER_TOKEN);

    check(
      "orient reports a folder past its budget as a floor",
      /^- 1-projects\/ — 5000\+ notes$/m.test(owner)
    );
    check(
      "a floor travels down to the child folders drawn from the same walk",
      /^ {2}- 1-projects\/bulk\/ — \d+\+$/m.test(owner)
    );
    check("orient's total is a floor when any folder was truncated", /^5\d{3}\+ notes visible/m.test(owner));
    check("orient explains the floor markers when it prints one", owner.includes("are floors"));
    check(
      "a folder the adapter refuses to list is named, not dropped",
      owner.includes("1-projects\\legacy/ — could not be listed")
    );
    check(
      "one unlistable folder does not suppress the rest of the survey",
      owner.includes("- 2-areas/ — 2 notes") && owner.includes("1-projects/gateway/")
    );
    // Asserted as presence *and* order. The first version of this compared two
    // `indexOf` results, and passed for the wrong reason the moment the newer
    // note stopped appearing at all: -1 sorts before everything.
    const recent = owner.split("## Recently updated")[1]?.split("---")[0] || "";
    check(
      "orient ranks recent activity by timestamp, not by key",
      recent.includes("2-areas/handbook.md — 2y ago") &&
        recent.indexOf("index.md — ") < recent.indexOf("2-areas/handbook.md —") &&
        recent.indexOf("2-areas/handbook.md —") < recent.indexOf("1-projects/bulk/")
    );
    check(
      "a sampled recency list says it is a sample",
      recent.includes("this call reached")
    );
    check("orient carries the customer's own front page", owner.includes("Shipping the gateway."));

    const member = await orientText(env, TEAM_TOKEN);
    check("a team connection is not shown a private folder's notes", !member.includes("old-secret"));
    check(
      "a team connection's folder count excludes the private subfolder",
      /^- 2-areas\/ — 1 note$/m.test(member)
    );
    // "0 notes" is a claim about the folder; all we know is that nothing in it
    // reached this connection. The folder is still named — it is somewhere a
    // colleague may file something — but it is named without a number.
    check(
      "a folder with nothing visible in it is named without a count",
      /^- 3-resources\/$/m.test(member) && !member.includes("3-resources/ — 0")
    );
    check("the owner sees the same folder counted", /^- 3-resources\/ — 1 note$/m.test(owner));

    // -- the connect-time sketch, and the handshake it must never endanger
    const connect = async (token) => {
      const { status, body } = await rpc(env, token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      });
      // `result`, not just a 200: a thrown handler is answered with a JSON-RPC
      // error object over HTTP 200, so a status check alone would call a
      // client that cannot connect a successful handshake.
      return { status, ok: Boolean(body?.result), instructions: body?.result?.instructions || "" };
    };

    const ownerConnect = await connect(OWNER_TOKEN);
    check(
      "initialize sketches the context so a client knows what is here before calling anything",
      ownerConnect.instructions.includes("WHAT IS IN HERE") &&
        ownerConnect.instructions.includes("Shipping the gateway.")
    );
    check(
      "the connect sketch names the top level",
      ownerConnect.instructions.includes("1-projects/") &&
        ownerConnect.instructions.includes("2-areas/")
    );
    check(
      "the connect sketch points at orient for the live answer",
      /snapshot taken when this connection opened/.test(ownerConnect.instructions)
    );

    const deadConnect = await connect(BROKEN_TOKEN);
    check(
      "an unreachable bucket still completes the handshake",
      deadConnect.status === 200 && deadConnect.ok
    );
    check(
      "an unreachable bucket falls back to the static instructions",
      deadConnect.instructions.includes("PARA") &&
        !deadConnect.instructions.includes("WHAT IS IN HERE")
    );

    // A privacy manifest nobody can parse must fail closed everywhere, and the
    // handshake is now one of the places that reads it.
    bucket.seed("privacy.md", "# not a manifest at all\n");
    const brokenPrivacy = await connect(OWNER_TOKEN);
    check(
      "a broken privacy manifest costs the sketch, not the connection",
      brokenPrivacy.status === 200 &&
        brokenPrivacy.ok &&
        brokenPrivacy.instructions.includes("PARA") &&
        !brokenPrivacy.instructions.includes("WHAT IS IN HERE")
    );
    bucket.seed("privacy.md", PRIVACY_MANIFEST);
  } finally {
    restore();
  }
}
