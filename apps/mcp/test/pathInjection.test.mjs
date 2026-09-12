/**
 * A path is not a place to write privacy rules.
 *
 * `privacy.md` is line-oriented and `renderPrivacyRulesBlock` interpolates a
 * path into it unescaped, so a path carrying a newline used to write its own
 * extra rules. Found by an adversarial review of the group-rules change; it
 * predates that change, and the alternation added for `@name` values is not
 * what makes it reachable — the path capture `([^:]+?)` is unchanged.
 *
 * The attack is worth stating exactly, because "an injection into a config
 * file" understates it. The note whose bytes end up readable by every team
 * connection is **not the note the call names**, and the call declares
 * `visibility: "private"` — so `isPublishing` is false, no confirmation is
 * asked for, and an agent reports to its user that it wrote a private note.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 * 1. **The control-character reject removed from `normalizePath`** — 2 checks
 *    failed, including the injected `1-projects/secret.md: team` rule appearing
 *    in the manifest over a call that declared `private`.
 * 2. **`writesOneRule` made to `return true`** — 4 checks failed. First
 *    attempt: **0**, and the reason is the useful part. With `normalizePath`
 *    rejecting control characters, nothing the tool surface can send reaches
 *    the second layer by the newline route, so a file testing only that route
 *    proved nothing about it. The colon case below is the one that still
 *    arrives — and it is what a real bucket produces constantly, since Obsidian
 *    and rclone write keys this validator never saw.
 * 3. **Both removed together** — 6 checks failed.
 *
 * The two layers are not redundant and the numbers say so: the first stops a
 * path that could never name an object, the second stops a path that names a
 * real object the rule format cannot express. Only the second needs the round
 * trip, because a character blacklist is a guess about a parser that has a
 * comment stripper, a trailing-slash tolerance and a dot-segment rule.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const OWNER_TOKEN = `cat_inject_owner_${"0".repeat(15)}`;
const TEAM_TOKEN = `cat_inject_team_${"0".repeat(16)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  "note_overrides:\n  1-projects/secret.md: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    text(key) {
      return objects.get(key)?.body;
    },
    keys() {
      return [...objects.keys()];
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
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      if (options?.onlyIf?.absent && objects.has(key)) return null;
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
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
}

async function callTool(env, token, name, args) {
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
  const body = await response.json();
  await settle();
  return body?.result?.content?.[0]?.text ?? "";
}

export async function runPathInjectionChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const bucket = createBucket();
    controlPlane.addWorkspace("ws_inject", "inject", {
      provider: "r2-binding",
      bindingName: "INJECT_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_inject",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_inject_owner",
      userId: "user_inject_owner",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_inject",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_inject_team",
      userId: "user_inject_team",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "INJECT_BUCKET",
      INJECT_BUCKET: bucket,
    };

    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# front page");
    bucket.seed("1-projects/secret.md", "SECRETWORD not for the team");

    // Non-vacuity: the note really is private, and the team connection really
    // is refused, BEFORE anything is attempted.
    const before = await callTool(env, TEAM_TOKEN, "read_note", { path: "1-projects/secret.md" });
    check(
      "the named note starts private, and a team connection cannot read it",
      !before.includes("SECRETWORD")
    );

    /* -- the attack, exactly as the review reproduced it -------------------- */

    const EVIL = "1-projects/secret.md: team\n  1-projects/junk.md";
    const injected = await callTool(env, OWNER_TOKEN, "write_note", {
      path: EVIL,
      content: "# anything",
      visibility: "private",
    });
    check(
      "a path carrying a newline is refused rather than written",
      /invalid path/i.test(injected)
    );
    check(
      "...and the manifest gained no rule from it",
      !bucket.text("privacy.md").includes("1-projects/junk.md") &&
        !bucket.text("privacy.md").includes("1-projects/secret.md: team")
    );
    check(
      "...and no object was created under the forged path",
      bucket.keys().every((key) => !key.includes("\n"))
    );

    // The consequence, which is the reason any of this matters: the note the
    // call did NOT name is still private.
    const after = await callTool(env, TEAM_TOKEN, "read_note", { path: "1-projects/secret.md" });
    check(
      "...so the note the call never named is still unreadable by the team connection",
      !after.includes("SECRETWORD")
    );

    /* -- the same trick through the folder control -------------------------- */

    const folder = await callTool(env, OWNER_TOKEN, "set_folder_visibility", {
      path: "1-projects/x: team\n  2-areas",
      visibility: "private",
      dry_run: true,
    });
    check(
      "set_folder_visibility refuses a forged folder path too",
      /invalid|not found|permission/i.test(folder) && !folder.includes("2-areas: private")
    );

    /* -- the second layer, which the first one's success hides -------------- */

    // `normalizePath` allows a colon, and the rule grammar does not: the value
    // is everything after the FIRST colon, so `1-projects/2026: notes.md`
    // renders a line the parser rejects. That is the case `writesOneRule`
    // exists for, and the only one the tool surface can still reach now that
    // control characters are refused earlier — a real bucket reaches it far
    // more often, since Obsidian's sync plugin and rclone write keys that never
    // passed through `normalizePath` at all.
    const colon = await callTool(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/2026: notes.md",
      content: "# notes",
      visibility: "private",
    });
    check(
      "a path the rule grammar cannot express is refused rather than half-written",
      /cannot be recorded in privacy.md/i.test(colon)
    );
    check(
      "...and the manifest is untouched by it",
      !bucket.text("privacy.md").includes("2026")
    );

    /* -- and the ordinary paths still work ---------------------------------- */

    const ordinary = await callTool(env, OWNER_TOKEN, "write_note", {
      path: "1-projects/ordinary.md",
      content: "# ordinary",
      visibility: "private",
    });
    check("an ordinary path is unaffected", /written/i.test(ordinary));
    check(
      "...and its rule is written exactly once, as itself",
      (bucket.text("privacy.md").match(/1-projects\/ordinary\.md: private/g) || []).length === 1
    );
    // A trailing slash is still tolerated, which is the behaviour `normalizePath`
    // documents; the reject is control characters, not tidiness.
    const slashed = await callTool(env, OWNER_TOKEN, "scope_info", { path: "1-projects/" });
    check("a trailing slash is still normalized rather than rejected", /1-projects/.test(slashed));
  } finally {
    restore?.();
  }
}
