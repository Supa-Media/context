/**
 * `report_problem`: an agent reports a problem it hit in Context.
 *
 * The tool sends a message and nothing else. The person it is filed as is
 * resolved by the control plane from the connection's own token, which is
 * forwarded verbatim (`/gateway/feedback`), never named by the agent or the
 * gateway. It changes nothing in any workspace, so a read-only connection is
 * offered it too.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-report-problem.test";
const TOKEN_OWNER = `cat_report_owner_${"0".repeat(23)}`;
const TOKEN_READ_ONLY = `cat_report_readonly_${"0".repeat(20)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, GATEWAY_SECRET };

function binding(bucket) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: "AKIAEXAMPLEEXAMPLERP",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLERP",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  };
}

async function rpc(token, method, params) {
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
  const body = JSON.parse(await response.text());
  await settle();
  return body?.result;
}

const report = async (token, args) => {
  const result = await rpc(token, "tools/call", { name: "report_problem", arguments: args });
  return { text: result?.content?.[0]?.text || "", isError: result?.isError === true };
};

let controlPlane;
let restoreS3;
let restoreControlPlane;
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restoreS3 = s3.install();
  controlPlane = createControlPlaneStub();
  restoreControlPlane = controlPlane.install();
  controlPlane.addWorkspace("ws_report", "reporter", binding("report-bucket"));
  const person = { workspaceId: "ws_report", role: "owner", userId: "user_report" };
  await controlPlane.addGrant({ ...person, accessToken: TOKEN_OWNER, scopes: ["context:read", "context:write"], clientId: "mcp_client_report" });
  await controlPlane.addGrant({ ...person, accessToken: TOKEN_READ_ONLY, scopes: ["context:read"], clientId: "mcp_client_report_ro" });
});
beforeEach(() => {
  controlPlane.feedback.length = 0;
  controlPlane.flags.feedbackRefusal = null;
});
after(() => {
  restoreControlPlane?.();
  restoreS3?.();
});

test("the tool is offered to every connection, a read-only one included", async () => {
  for (const token of [TOKEN_OWNER, TOKEN_READ_ONLY]) {
    const names = ((await rpc(token, "tools/list", {}))?.tools || []).map((tool) => tool.name);
    assert.ok(names.includes("report_problem"), `not offered to ${token}`);
  }
});

test("its description says what to send and what never to include", async () => {
  const tool = ((await rpc(TOKEN_OWNER, "tools/list", {}))?.tools || []).find((entry) => entry.name === "report_problem");
  assert.match(tool.description, /never include/i);
  assert.match(tool.description, /note/i);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.openWorldHint, true);
});

test("a report reaches the control plane with the connection's own token and the message", async () => {
  const answer = await report(TOKEN_OWNER, { message: "search_notes found nothing for a note that exists" });
  assert.equal(answer.isError, false);
  assert.match(answer.text, /sent/i);
  assert.equal(controlPlane.feedback.length, 1);
  assert.equal(controlPlane.feedback[0].accessToken, TOKEN_OWNER);
  assert.equal(controlPlane.feedback[0].message, "search_notes found nothing for a note that exists");
});

test("a read-only connection can report", async () => {
  const answer = await report(TOKEN_READ_ONLY, { message: "read_note timed out" });
  assert.equal(answer.isError, false);
  assert.equal(controlPlane.feedback.length, 1);
});

test("an empty message is refused before anything is sent", async () => {
  const answer = await report(TOKEN_OWNER, { message: "   " });
  assert.equal(answer.isError, true);
  assert.equal(controlPlane.feedback.length, 0);
});

test("the control plane's refusals come back as sentences", async () => {
  const cases = {
    rate_limited: /limit/i,
    not_configured: /not taking|does not take/i,
    invalid: /too long|empty/i,
    unavailable: /could not be sent/i,
  };
  for (const [refused, sentence] of Object.entries(cases)) {
    controlPlane.flags.feedbackRefusal = refused;
    const answer = await report(TOKEN_OWNER, { message: "x" });
    assert.equal(answer.isError, true, refused);
    assert.match(answer.text, sentence, refused);
  }
});
