import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decryptNote,
  isEncryptedNote,
  parseEncryptedNote,
} from "../src/encryption.js";
import { isStampEligible, stampGeneration, stripGenerationStamp } from "../src/store/generationStamp.js";

const fixture = JSON.parse(
  readFileSync(new URL("./encryptionVector.fixtures.json", import.meta.url), "utf8"),
);
const FOOTER = "<!-- context-generation:v1:0123456789abcdef0123456789abcdef -->";

test("standalone encrypted-note parsing ignores the reserved generation footer", async () => {
  const stamped = `${fixture.document}\n${FOOTER}`;
  assert.equal(isEncryptedNote(stamped), true);
  assert.deepEqual(parseEncryptedNote(stamped), parseEncryptedNote(fixture.document));
  assert.equal(
    await decryptNote(stamped, { workspaceId: fixture.workspaceId, keys: { [fixture.keyId]: fixture.workspaceKey } }),
    fixture.plaintext,
  );
});

test("storage generation stamps may fence privacy metadata while CRDT paths stay excluded", () => {
  const manifest = "---\nrole: privacy-manifest\n---\n\n# Privacy Map\n";
  const stamped = stampGeneration(manifest);
  assert.equal(isStampEligible("privacy.md", stamped), true);
  assert.equal(stripGenerationStamp(stamped)?.text, manifest);
  assert.equal(isStampEligible(".context/trash/recreated/privacy.md", stamped), true);
});
