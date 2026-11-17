// tex_dev's answers can be big: `set_drafts` carries every Training and Dev draft whole. The default control-plane
// response cap (256 KB) refused it once a few long conversations were drafted, and every set_* call came back as
// "could not be reached". These pin the larger cap for tex_dev only.
import test from "node:test";
import assert from "node:assert/strict";
import { createTransport, CONTROL_PLANE_RESPONSE_BYTE_CAP } from "../src/controlPlane/client.js";
import { createTexDevMethods, TEX_DEV_RESPONSE_BYTE_CAP } from "../src/controlPlane/texDev.js";

const env = { CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
const big = (bytes) => JSON.stringify({ status: "ok", drafts: [{ id: "long-chat", conv: "x".repeat(bytes) }] });
const answering = (body) => async () => new Response(body, { headers: { "content-type": "application/json" } });

test("tex_dev reads a drafts listing far over the default control-plane cap", async () => {
  const body = big(CONTROL_PLANE_RESPONSE_BYTE_CAP * 3);
  const { post } = createTransport(env, answering(body));
  const answer = await createTexDevMethods({ post }).texDev("token", "set_drafts");
  assert.equal(answer?.status, "ok");
  assert.equal(answer.drafts[0].conv.length, CONTROL_PLANE_RESPONSE_BYTE_CAP * 3);
});

test("tex_dev still has a ceiling: an answer over its own cap is unreachable, not read", async () => {
  const { post } = createTransport(env, answering(big(TEX_DEV_RESPONSE_BYTE_CAP + 10)));
  await assert.rejects(() => createTexDevMethods({ post }).texDev("token", "set_drafts"), /too large/);
});

test("every other control-plane call keeps the default cap", async () => {
  const { post } = createTransport(env, answering(big(CONTROL_PLANE_RESPONSE_BYTE_CAP * 2)));
  await assert.rejects(() => post("/gateway/anything", {}), /too large/);
});
