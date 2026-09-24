/**
 * The free managed tier's note cap, end to end through the worker.
 *
 * `noteCap.test.mjs` proves the wrapper. This proves it is *wired*: the control
 * plane's `noteCap` sibling reaches `storeForBinding`, a tool call that would
 * add a note is refused with the sentence that says what still works, and the
 * things the cap must never touch — editing, moving, deleting — still work on
 * a full context. And that a context without the sibling is not capped at all,
 * which is every context that is not on the free tier.
 *
 * Sabotage: the factory no longer applying the cap fails 4 checks here; the
 * move tools running outside the relocation window fails 3.
 */

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const CAPPED_TOKEN = `cat_notecap_full_${"0".repeat(16)}`;
const FREE_TOKEN = `cat_notecap_open_${"0".repeat(16)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  4-archive: private\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

/** R2's conditional-write semantics, the two forms R2Store sends included. */
function createBucket() {
  const objects = new Map();
  let etags = 0;
  const encoder = new TextEncoder();
  return {
    objects,
    seed(key, text) {
      objects.set(key, { bytes: encoder.encode(text), etag: `e${++etags}` });
    },
    async get(key) {
      const entry = objects.get(key);
      if (!entry) return null;
      return {
        etag: entry.etag,
        text: async () => new TextDecoder().decode(entry.bytes),
        arrayBuffer: async () => entry.bytes.slice().buffer,
      };
    },
    async head(key) {
      const entry = objects.get(key);
      return entry ? { etag: entry.etag, size: entry.bytes.byteLength } : null;
    },
    async put(key, value, options = {}) {
      const expected = options?.onlyIf?.etagMatches;
      if (expected && objects.get(key)?.etag !== expected) return null;
      const createOnly = options?.onlyIf?.absent === true || options?.onlyIf?.etagDoesNotMatch === "*";
      if (createOnly && objects.has(key)) return null;
      const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
      objects.set(key, { bytes, etag: `e${++etags}` });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const found = [];
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const split = delimiter ? rest.indexOf(delimiter) : -1;
        if (split >= 0) prefixes.add(`${prefix}${rest.slice(0, split + 1)}`);
        else found.push({ key, size: objects.get(key).bytes.byteLength, uploaded: new Date(), etag: objects.get(key).etag });
      }
      const start = cursor === undefined ? 0 : Number(cursor);
      const page = found.slice(start, start + limit);
      const truncated = start + page.length < found.length;
      return {
        objects: page,
        delimitedPrefixes: [...prefixes],
        truncated,
        ...(truncated ? { cursor: String(start + page.length) } : {}),
      };
    },
  };
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
    ctx,
  );
  const body = await response.json();
  await settle();
  return {
    text: body?.result?.content?.[0]?.text ?? "",
    isError: body?.result?.isError === true,
  };
}

export async function runNoteCapGatewayChecks(check) {
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();
  try {
    const capped = createBucket();
    const open = createBucket();
    const binding = {
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      provider: "r2-binding",
    };
    // Nested here for convenience; the stub splits it into a sibling at the
    // wire, which is the only shape the gateway may read.
    controlPlane.addWorkspace("ws_notecap_full", "notecapfull", { ...binding, bindingName: "CAPPED_BUCKET", noteCap: 4 });
    controlPlane.addWorkspace("ws_notecap_open", "notecapopen", { ...binding, bindingName: "OPEN_BUCKET" });
    for (const [token, workspaceId] of [[CAPPED_TOKEN, "ws_notecap_full"], [FREE_TOKEN, "ws_notecap_open"]]) {
      await controlPlane.addGrant({
        accessToken: token,
        workspaceId,
        role: "owner",
        scopes: ["context:read", "context:write", "context:private"],
        clientId: `mcp_client_${workspaceId}`,
        userId: `user_${workspaceId}`,
      });
    }
    for (const bucket of [capped, open]) {
      bucket.seed("privacy.md", MANIFEST);
      bucket.seed("index.md", "# front page");
      bucket.seed("1-projects/a.md", "first");
      bucket.seed("1-projects/b.md", "second");
      bucket.seed(".context/collaboration/plumbing.md", "not a note");
    }
    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "CAPPED_BUCKET,OPEN_BUCKET",
      CAPPED_BUCKET: capped,
      OPEN_BUCKET: open,
    };

    const created = await callTool(env, FREE_TOKEN, "write_note", { path: "1-projects/c.md", content: "third" });
    check("a context with no cap takes a new note", !created.isError && open.objects.has("1-projects/c.md"));

    const refused = await callTool(env, CAPPED_TOKEN, "write_note", { path: "1-projects/c.md", content: "third" });
    check("a context at its cap refuses a new note", refused.isError && !capped.objects.has("1-projects/c.md"));
    check(
      "…and says what still works and how to get more room",
      /free plan/.test(refused.text) && /exported/.test(refused.text) && /Premium/.test(refused.text),
    );
    check("…without naming the note it refused", !refused.text.includes("1-projects/c.md"));

    const read = await callTool(env, CAPPED_TOKEN, "read_note", { path: "1-projects/a.md" });
    const etag = read.text.match(/^etag: (\S+)/m)?.[1];
    const edited = await callTool(env, CAPPED_TOKEN, "write_note", {
      path: "1-projects/a.md",
      content: "first, edited",
      expected_etag: etag,
    });
    check("a full context still edits a note it has", !edited.isError && /edited/.test(new TextDecoder().decode(capped.objects.get("1-projects/a.md")?.bytes ?? new Uint8Array())));

    const moved = await callTool(env, CAPPED_TOKEN, "move_note", {
      source: "1-projects/b.md",
      destination: "2-areas/b.md",
    });
    check("a full context still moves a note", !moved.isError && capped.objects.has("2-areas/b.md"));

    const archived = await callTool(env, CAPPED_TOKEN, "archive_note", { path: "2-areas/b.md" });
    check("a full context still archives a note", !archived.isError && /^archived: 2-areas\/b\.md/.test(archived.text));

    check(
      "Context's own activity log is still written, though it was a new note at the cap",
      capped.objects.has("activity.md"),
    );

    // Deleting is the console's (through the control plane), not a tool's.
    // What matters here is that the next request counts afresh.
    // The log above is a note too, so two go to make room for one.
    capped.objects.delete("1-projects/a.md");
    for (const key of [...capped.objects.keys()].filter((key) => key.startsWith("4-archive/"))) {
      capped.objects.delete(key);
    }
    const afterDelete = await callTool(env, CAPPED_TOKEN, "write_note", { path: "1-projects/c.md", content: "third" });
    check("and a note gone makes room for the next", !afterDelete.isError && capped.objects.has("1-projects/c.md"));
  } finally {
    restore();
  }
}
