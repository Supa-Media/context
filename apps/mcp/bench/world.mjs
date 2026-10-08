/**
 * A THROWAWAY WORLD FOR ONE BENCHMARK CONVERSATION.
 *
 * The real gateway Worker, in process, over the same in-memory control plane
 * and object store its tests use. Every invented workspace becomes its own
 * bucket with a real `privacy.md`, every invented person a texting grant
 * covering exactly the workspaces `people.md` gives them, and the setup under
 * test is written where the product reads it: `assistant/production/` in a
 * pinned `@context-lc`. So a benchmark answer goes through the same tools,
 * routing and privacy decisions a texted answer does, and a setup that leaks
 * a held-back note does it here first.
 *
 * Nothing leaves the world except the model calls: writes land in the
 * throwaway buckets and are read back as a list of changes, never applied
 * anywhere.
 */

import worker from "../src/index.js";
import { PRODUCTION_TEXTING_PATH } from "../src/agent/production.js";
import { PROPOSAL_PENDING_PREFIX } from "../src/tools/proposals.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "../test/controlPlaneStub.mjs";
import { createWorkerCtx } from "../test/workerCtx.mjs";

const S3_ENDPOINT = "https://s3.bench.invalid";
const PINNED = "context-lc";

/**
 * The `privacy.md` the gateway reads. The default is always private (the engine
 * accepts nothing else), so a shared workspace shares each of its top-level
 * folders and root notes with members, and a held-back note is a private
 * override on top.
 */
export function manifest({ shared, files = [], heldBack = [] }) {
  const folders = shared ? [...new Set(files.filter((path) => path.includes("/")).map((path) => path.split("/")[0]))].sort() : [];
  const rootNotes = shared ? files.filter((path) => !path.includes("/")).sort() : [];
  const lines = (entries, visibility) => entries.map((path) => `  ${path}: ${visibility}\n`).join("");
  const overrides = lines(rootNotes.filter((path) => !heldBack.includes(path)), "team") + lines(heldBack, "private");
  return (
    "---\nrole: privacy-manifest\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
    `folder_defaults:\n${lines(folders, "team") || "  # none\n"}\n` +
    `note_overrides:\n${overrides || "  # none\n"}` +
    "```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

function binding(bucket, n) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIABENCHEXAMPLE${String(n).padStart(4, "0")}`,
    secretAccessKey: `benchExampleSecretNotReal${String(n).padStart(4, "0")}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

function bodyText(object) {
  const body = object?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body ?? "");
}

function snapshot(bucket) {
  return new Map([...bucket].map(([key, object]) => [key, bodyText(object)]));
}

/**
 * Build the world for one person.
 *
 * @param {object} bench what `readBenchFolder` returned
 * @param {string} person e.g. "Maya"
 * @param {string} setupRaw the setup file's text, written as the production note
 * @param {{ ai?: object, gatewayFetch: Function }} models where model calls go
 */
export async function createWorld(bench, person, setupRaw, models) {
  const rows = bench.people.filter((row) => row.person === person);
  const own = rows.find((row) => row.personal);
  if (!own) throw new Error(`${person} has no personal workspace in people.md`);

  const s3 = createS3Backend(S3_ENDPOINT);
  const controlPlane = createControlPlaneStub();
  const restore = [s3.install(), controlPlane.install()];

  // Model calls are the only traffic that leaves the world.
  const below = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith("https://gateway.ai.cloudflare.com/")) return models.gatewayFetch(url, init);
    if (url.startsWith(S3_ENDPOINT) || url.startsWith(CONTROL_PLANE_ORIGIN)) return below(input, init);
    throw new Error("a benchmark turn tried to reach the network outside the model");
  };
  restore.push(() => {
    globalThis.fetch = below;
  });

  // Every workspace exists, whoever is asking, so a leak is a real leak.
  const ids = new Map();
  let n = 0;
  for (const [name, workspace] of Object.entries(bench.workspaces)) {
    const id = `ws_${name.replace(/-/g, "_")}`;
    const shared = !bench.people.some((row) => row.workspace === name && row.personal);
    controlPlane.addWorkspace(id, name, binding(`bench-${name}`, ++n), shared ? { kind: "shared" } : {});
    const bucket = s3.bucketFor(`bench-${name}`);
    bucket.set("privacy.md", { body: manifest({ shared, files: Object.keys(workspace.files), heldBack: workspace.heldBack }), etag: "p0" });
    for (const [path, text] of Object.entries(workspace.files)) bucket.set(path, { body: text, etag: "e0" });
    controlPlane.setBuiltinVerdict(id, { allowed: true, remaining: 1000 });
    ids.set(name, id);
  }

  controlPlane.addWorkspace("ws_pinned", PINNED, binding("bench-pinned", ++n), { kind: "shared" });
  const pinned = s3.bucketFor("bench-pinned");
  pinned.set("privacy.md", { body: manifest({ shared: true, files: [PRODUCTION_TEXTING_PATH] }), etag: "p0" });
  pinned.set(PRODUCTION_TEXTING_PATH, { body: setupRaw, etag: "s0" });

  const token = `cat_bench_${person.toLowerCase().replace(/[^a-z]/g, "")}_${"0".repeat(24)}`;
  await controlPlane.addGrant({
    workspaceId: ids.get(own.workspace),
    role: "owner",
    userId: `user_bench_${own.workspace}`,
    accessToken: token,
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "context_texts",
    alsoMemberOf: [
      ...rows.filter((row) => !row.personal).map((row) => ({ workspaceId: ids.get(row.workspace), role: row.role })),
      { workspaceId: "ws_pinned", role: "member" },
    ],
  });

  const before = new Map([...ids].map(([name]) => [name, snapshot(s3.bucketFor(`bench-${name}`))]));
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    ...(models.ai ? { AI: models.ai } : {}),
    AI_GATEWAY_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    AI_GATEWAY_ID: "bench",
    AI_GATEWAY_TOKEN: "bench-gateway-token-not-a-real-one",
  };

  return {
    /** One texted message, answered with the conversation so far. */
    async text(message) {
      const { ctx, settle } = createWorkerCtx();
      const started = Date.now();
      const response = await worker.fetch(
        new Request("https://mcp.bench.invalid/agent", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ question: message, conversation: "texts" }),
        }),
        env,
        ctx,
      );
      const ms = Date.now() - started;
      const body = await response.json().catch(() => null);
      await settle();
      const turn = controlPlane.turnReports.at(-1) ?? {};
      const usage = controlPlane.builtinReports.at(-1) ?? {};
      return {
        ok: response.status === 200 && typeof body?.answer === "string",
        answer: body?.answer ?? "",
        error: response.status === 200 ? null : String(body?.error ?? `status ${response.status}`),
        ms,
        model: usage.model ?? body?.model ?? null,
        tools: (turn.trace ?? []).filter((entry) => entry.kind === "tool").map((entry) => entry.tool),
        usage: {
          input: usage.inputTokens ?? 0,
          output: usage.outputTokens ?? 0,
          cacheRead: usage.cacheReadTokens ?? 0,
          cacheWrite: usage.cacheWriteTokens ?? 0,
        },
      };
    },

    /** What the conversation changed in the invented workspaces, as a list. */
    changes() {
      const out = [];
      for (const [name, was] of before) {
        const now = snapshot(s3.bucketFor(`bench-${name}`));
        for (const [path, text] of now) {
          if (was.get(path) === text) continue;
          if (path.startsWith(PROPOSAL_PENDING_PREFIX)) {
            // A proposal is what the person would be asked to accept.
            let proposal = null;
            try {
              proposal = JSON.parse(text);
            } catch {
              proposal = null;
            }
            out.push({
              workspace: name,
              path: String(proposal?.intended_path ?? "unreadable proposal"),
              kind: "proposed",
              detail: `${String(proposal?.reason ?? "").slice(0, 200)} | ${String(proposal?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400)}`,
            });
            continue;
          }
          // Plumbing a turn writes for itself (history, reads, audit) is not something it did.
          if (path.startsWith(".")) continue;
          out.push({ workspace: name, path, kind: "written", detail: text.replace(/\s+/g, " ").trim().slice(0, 300) });
        }
        for (const path of was.keys()) {
          if (!now.has(path) && !path.startsWith(".")) out.push({ workspace: name, path, kind: "deleted", detail: "" });
        }
      }
      return out;
    },

    close() {
      for (const undo of restore.reverse()) undo();
    },
  };
}
