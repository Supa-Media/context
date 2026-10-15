/**
 * Why a background read failed, in a word admin can show (`store/readFailure.js`).
 *
 * Each kind is produced by the real thing that throws it: the managed
 * encryption wrapper, the key guard, the S3 adapter's error. A classifier
 * tested only against hand-written messages would pass while the message it
 * matches drifted.
 *
 * ## Sabotage record (temporary local edits, reverted; failures measured)
 *
 *   `detail` dropped from ManagedEncryptionError                          1
 *   every ManagedEncryptionError read as `unsealed`                       1
 */

import test from "node:test";
import assert from "node:assert/strict";
import { withManagedEncryption, ManagedCipher } from "../src/store/managedEncryption.js";
import { assertSafeKey } from "../src/store/index.js";
import { S3Store } from "../src/store/s3.js";
import { commonReadFailure, readFailureKind, LASTING_READ_FAILURES } from "../src/store/readFailure.js";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

function memory(objects) {
  return {
    async get(key) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { etag: "e", size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    async put() {
      return { etag: "e" };
    },
  };
}

async function caught(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the read to throw");
}

test("a plain note in a sealed-only workspace is `unsealed`", async () => {
  const store = withManagedEncryption(memory(new Map([["4-archive/about.md", new TextEncoder().encode("# Archive\n")]])), {
    workspaceId: "ws",
    mode: "encrypted",
    current: "k1",
    keys: { k1: KEY_A },
  });
  assert.equal(readFailureKind(await caught(store.get("4-archive/about.md"))), "unsealed");
});

test("sealed bytes that will not open are `sealed`, not `unsealed`", async () => {
  const sealed = await new ManagedCipher("ws", { current: "k1", keys: { k1: KEY_B } }).seal(new TextEncoder().encode("x"));
  const store = withManagedEncryption(memory(new Map([["a.md", sealed]])), {
    workspaceId: "ws",
    mode: "encrypted",
    current: "k1",
    keys: { k1: KEY_A },
  });
  assert.equal(readFailureKind(await caught(store.get("a.md"))), "sealed");
});

test("a key the adapter refuses is `name`", () => {
  let error;
  try {
    assertSafeKey("a/../b.md");
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(readFailureKind(error), "name");
});

test("a bucket that refuses the read is `storage`", async () => {
  const store = new S3Store({
    endpoint: "https://s3.example.invalid",
    region: "auto",
    bucket: "b",
    accessKeyId: "id",
    secretAccessKey: "not-a-secret",
    fetchImpl: async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
  });
  assert.equal(readFailureKind(await caught(store.get("a.md"))), "storage");
});

test("anything else is `other`, and the common kind is the most frequent", () => {
  assert.equal(readFailureKind(new Error("boom")), "other");
  assert.equal(readFailureKind(undefined), "other");
  assert.equal(commonReadFailure(["other", "unsealed", "unsealed"]), "unsealed");
  assert.equal(commonReadFailure([]), null);
  assert.ok(LASTING_READ_FAILURES.includes("unsealed"));
  assert.ok(!LASTING_READ_FAILURES.includes("storage"));
});
