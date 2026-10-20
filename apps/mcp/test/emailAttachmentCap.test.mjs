/**
 * An email attachment comes back from the control plane whole, past the
 * 256 KB every other answer is held to (`src/controlPlane/email.js`).
 *
 * Sabotage: dropping `maxBytes` from `personMailRead` failed "an attachment
 * read may carry a file past 256 KB": the read came back unavailable, which
 * Tex told the person as "Gmail isn't answering" (2026-10-20).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createControlPlane } from "../src/controlPlane/index.js";
import { CONTROL_PLANE_RESPONSE_BYTE_CAP } from "../src/controlPlane/client.js";

const MESSAGE = { address: "seyi@example.invalid", id: "18cafe", threadId: "18beef", date: "", from: "", to: "", subject: "Agreement", body: "", attachments: [] };

function answering(body) {
  return createControlPlane(
    { CONTROL_PLANE_URL: "https://control.example", GATEWAY_SECRET: "test-secret" },
    { fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }) },
  );
}

test("an attachment read may carry a file past 256 KB", async () => {
  // A 600 KB PDF, as base64.
  const data = "A".repeat(800_000);
  assert.ok(data.length > CONTROL_PLANE_RESPONSE_BYTE_CAP);
  const read = await answering({ ok: true, message: MESSAGE, attachment: { filename: "Agreement.pdf", contentType: "application/pdf", data } })
    .personMailRead("tok", "ws_1", MESSAGE.address, MESSAGE.id, { attachment: 1 });
  assert.equal(read.ok, true);
  assert.equal(read.attachment.data.length, data.length);
});

test("an email read without an attachment keeps the small cap", async () => {
  const read = await answering({ ok: true, message: { ...MESSAGE, body: "x".repeat(CONTROL_PLANE_RESPONSE_BYTE_CAP) } })
    .personMailRead("tok", "ws_1", MESSAGE.address, MESSAGE.id)
    .catch((error) => ({ thrown: String(error) }));
  assert.match(read.thrown ?? JSON.stringify(read), /response too large|unavailable/);
});
