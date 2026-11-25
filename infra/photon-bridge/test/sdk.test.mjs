/**
 * Needs the container's dependencies: `npm ci --prefix infra/photon-bridge/container`.
 * Proves the SDK still exports what runtime.mjs imports and what the ops use.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EFFECT_NAMES } from "../container/validate.mjs";

// The container's own install: this package does not depend on the SDK.
const { createGrpcClient, MessageEffect } = await import(
  new URL("../container/node_modules/@photon-ai/advanced-imessage/dist/grpc.js", import.meta.url)
);

test("the gRPC entrypoint exports the client factory and the effect ids", () => {
  assert.equal(typeof createGrpcClient, "function");
  for (const name of EFFECT_NAMES) {
    assert.equal(typeof MessageEffect[name], "string", `MessageEffect.${name}`);
  }
});

test("the runtime module loads against the installed SDK", async () => {
  const runtime = await import("../container/runtime.mjs");
  assert.equal(typeof runtime.createRuntime, "function");
});

test("the client has every SDK method the sticker op calls", () => {
  // Built without connecting: the gRPC channel opens on the first call.
  const client = createGrpcClient({ address: "localhost:1", token: "unused" });
  try {
    assert.equal(typeof client.messages.placeSticker, "function");
    assert.equal(typeof client.attachments.upload, "function");
  } finally {
    client.close?.();
  }
});
