/**
 * A WRITE THE TRAIL DOES NOT NAME IS A WRITE THAT DID NOT HAPPEN, AS FAR AS
 * ANYONE READING CAN TELL.
 *
 * Moving a note rewrites the links to it inside every other note that
 * mentioned it — `rewriteReferences` puts each of those bodies back. Those are
 * writes to notes the mover never named, and `recordChange` is called with the
 * move's own two paths and nothing else.
 *
 * Two things follow, and the second is the one with a fixed row behind it:
 *
 *  - the audit trail and `activity.md` say a note moved and say nothing about
 *    the bodies that changed, though CLAUDE.md's promise is that the trail
 *    accounts for what happened in somebody's own bucket; and
 *  - `announceWebsiteChange` fires only when one of the recorded paths is
 *    under `website/`. Rewrite a published page's body while moving a note
 *    that is not published, and the control plane is never told its route
 *    index has stopped describing the bytes — which is exactly what #941 was
 *    written to prevent.
 */

import worker from "../src/index.js";
import * as Y from "yjs";
import { commitUpdate, readDocument } from "@context/collaboration";
import { S3Store } from "../src/store/s3.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-refwrite.test";
const TOKEN_OWNER = `cat_refwrite_own_${"0".repeat(23)}`;

const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n  website: team\n\n" +
  "note_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLEAP",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAP",
    forcePathStyle: true,
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
      serverSideCopy: false,
    },
    status: "active",
  };
}

function dependentUpdateWithoutItsOrigin() {
  const source = new Y.Doc({ gc: false });
  const text = source.getText("note");
  text.insert(0, "origin");
  const afterOrigin = Y.encodeStateVector(source);
  text.insert(text.length, " dependent");
  return Buffer.from(Y.encodeStateAsUpdate(source, afterOrigin)).toString("base64");
}

async function callTool(env, name, args = {}, token = TOKEN_OWNER) {
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
    ctx,
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

export async function runReferenceRewriteAuditChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace("ws_refwrite", "refwrite", binding("ref-rewrite"));
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: "ws_refwrite",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_refwrite",
    userId: "user_refwrite",
  });

  const bucket = s3.bucketFor("ref-rewrite");
  const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

  // Count the announcements the way the resolver's freshness depends on them:
  // one POST per report, over the stub's own fetch.
  const reports = { count: 0 };
  let activeObjectReads = 0;
  let peakObjectReads = 0;
  const beneath = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const parsed = new URL(url);
    if (url.startsWith(CONTROL_PLANE_ORIGIN) && parsed.pathname === "/gateway/website") {
      reports.count += 1;
    }
    const method = String(init?.method || "GET").toUpperCase();
    const objectRead =
      url.startsWith(S3_ENDPOINT) &&
      method === "GET" &&
      parsed.searchParams.get("list-type") !== "2" &&
      /\/ref-rewrite\/(?:1-projects|website)\//.test(parsed.pathname);
    if (!objectRead) return beneath(input, init);
    activeObjectReads += 1;
    peakObjectReads = Math.max(peakObjectReads, activeObjectReads);
    try {
      // A real S3/R2 round trip is the cost that made a 596-note workspace
      // cross the connector's HTTP timeout. Keep a small delay here so the
      // test can distinguish a serial sweep from bounded overlapping reads.
      await new Promise((resolve) => setTimeout(resolve, 3));
      return await beneath(input, init);
    } finally {
      activeObjectReads -= 1;
    }
  };

  try {
    const seed = (path, body) => bucket.set(path, { body, etag: `seed-${path}` });
    seed("privacy.md", PRIVACY_MANIFEST);
    seed("1-projects/foo.md", "# Foo\n\nthe note everything points at\n");
    seed("website/about.md", "# About\n\nSee [foo](../1-projects/foo.md) for the details.\n");
    seed("1-projects/pending-collaboration.md", "# Pending collaboration\n");
    for (let index = 0; index < 12; index += 1) {
      seed(`1-projects/unrelated-${index}.md`, `# Unrelated ${index}\n`);
    }

    const collaborationStore = new S3Store(binding("ref-rewrite"));
    const pendingDocument = await readDocument(collaborationStore, "1-projects/pending-collaboration.md");
    const pending = await commitUpdate(collaborationStore, "1-projects/pending-collaboration.md", {
      documentId: pendingDocument.documentId,
      update: dependentUpdateWithoutItsOrigin(),
    });
    check(
      "the fixture contains a durable Yjs update waiting for a missing dependency",
      pending.applied === false && pending.pendingDependencies === true,
    );

    const auditRows = () =>
      [...bucket.keys()]
        .filter((key) => key.startsWith(".context/audit/"))
        .sort()
        .map((key) => {
          try {
            return JSON.parse(bucket.get(key).body);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

    const beforeRows = auditRows().length;
    const beforeReports = reports.count;

    const moveResult = await callTool(env, "move_note", {
      source: "1-projects/foo.md",
      destination: "1-projects/bar.md",
    });

    check(
      "an unrelated dependency-pending collaboration note cannot turn a completed move into a failure",
      moveResult.includes("moved: 1-projects/foo.md") &&
        moveResult.includes("references: partially rewritten (1 note could not be checked or updated)"),
    );

    const body = String(bucket.get("website/about.md")?.body || "");
    check(
      "moving a note rewrites the link inside a published page",
      body.includes("1-projects/bar.md") && !body.includes("1-projects/foo.md"),
    );

    const added = auditRows().slice(beforeRows);
    check(
      "the audit trail names the page whose body the move rewrote",
      added.some((row) => Array.isArray(row.paths) && row.paths.includes("website/about.md")),
    );

    check(
      "and the control plane is told its route index no longer describes the bytes",
      reports.count > beforeReports,
    );
    check(
      "the reference sweep overlaps remote object reads instead of timing out serially",
      peakObjectReads > 1,
    );
  } finally {
    globalThis.fetch = beneath;
    restoreControlPlane();
    restoreS3();
  }
}
