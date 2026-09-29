/**
 * Managed-bucket encryption at the ContextStore seam.
 *
 * These checks use a byte-visible in-memory store: the logical caller sees
 * plaintext while the "provider" fixture sees only the physical bytes that
 * would land in S3.  That makes leakage, tampering, tenant isolation and key
 * rotation observable without a network or a real bucket.
 */

import { generateWorkspaceKey } from "../src/encryption.js";
import {
  MANAGED_ENVELOPE_MAGIC,
  ManagedStorageCryptoError,
  encryptManagedObject,
  withManagedEncryption,
} from "../src/store/managedEncryption.js";
import { LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/index.js";
import { isLogicalDeleteMarker, withLogicalDelete } from "../src/store/logicalDelete.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value) {
  if (typeof value === "string") return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("unsupported fixture value");
}

function memoryStore() {
  const objects = new Map();
  let revision = 0;
  return {
    objects,
    capabilities: {
      conditionalWrite: true,
      conditionalCreate: true,
      conditionalDelete: true,
      serverSideCopy: "same-store",
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      const body = stored.body.slice();
      return {
        etag: stored.etag,
        size: body.byteLength,
        contentType: stored.contentType,
        uploaded: stored.uploaded,
        text: async () => decoder.decode(body),
        arrayBuffer: async () => body.slice().buffer,
      };
    },
    async put(key, value, options = {}) {
      const previous = objects.get(key);
      if (options.onlyIf?.absent === true && previous) return null;
      if (options.onlyIf?.etagMatches !== undefined &&
          previous?.etag !== options.onlyIf.etagMatches) return null;
      const body = bytes(value).slice();
      const etag = `etag-${++revision}`;
      objects.set(key, {
        body,
        etag,
        contentType: options.contentType,
        uploaded: new Date(revision * 1000),
      });
      return { etag };
    },
    async copy(sourceKey, destinationKey, options = {}) {
      const source = objects.get(sourceKey);
      if (!source) return null;
      return await this.put(destinationKey, source.body, {
        ...options,
        contentType: source.contentType,
      });
    },
    async delete(key, options = {}) {
      const previous = objects.get(key);
      if (options.onlyIf?.etagMatches !== undefined &&
          previous?.etag !== options.onlyIf.etagMatches) return null;
      objects.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        objects: [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({
            key,
            size: value.body.byteLength,
            etag: value.etag,
            uploaded: value.uploaded,
          })),
        truncated: false,
      };
    },
  };
}

function context(workspaceId = "ws_managed_a", current = "g1", keys = null) {
  const material = generateWorkspaceKey();
  return {
    workspaceId,
    encryptionKey: { current, keys: keys || { [current]: material } },
  };
}

async function thrown(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
}

export async function runManagedEncryptionStoreChecks(check) {
  const raw = memoryStore();
  const encryption = context();
  const store = withManagedEncryption(raw, encryption);
  const plaintext = "# private roadmap\n\nThe launch code is swordfish.\n";

  const first = await store.put("1-projects/roadmap.md", plaintext);
  const physical = raw.objects.get("1-projects/roadmap.md");
  check(
    "managed storage writes a versioned binary envelope instead of plaintext",
    decoder.decode(physical.body.slice(0, MANAGED_ENVELOPE_MAGIC.length)) ===
      MANAGED_ENVELOPE_MAGIC &&
      !decoder.decode(physical.body).includes("swordfish") &&
      physical.contentType === "application/octet-stream",
  );

  const migratingRaw = memoryStore();
  await migratingRaw.put("existing.md", "plaintext from before rollout");
  const migratingContext = context("ws_migrating");
  const migrating = withManagedEncryption(migratingRaw, {
    ...migratingContext,
    allowPlaintextRead: true,
  });
  check(
    "migration mode reads pre-rollout plaintext while making every new write encrypted",
    (await (await migrating.get("existing.md")).text()) === "plaintext from before rollout" &&
      (await migrating.put("new.md", "written during migration")) !== null &&
      decoder.decode(migratingRaw.objects.get("new.md").body, { stream: false })
        .startsWith(MANAGED_ENVELOPE_MAGIC),
  );
  check(
    "the backfill encrypts an existing object with a conditional in-place write",
    (await encryptManagedObject(migratingRaw, "existing.md", migratingContext)).status ===
      "encrypted" &&
      (await (await migrating.get("existing.md")).text()) === "plaintext from before rollout",
  );

  const opened = await store.get("1-projects/roadmap.md");
  check(
    "the encrypted store returns the exact logical text and content type",
    (await opened.text()) === plaintext &&
      opened.contentType === "text/markdown; charset=utf-8" &&
      opened.etag === first.etag,
  );

  const image = Uint8Array.from([0, 255, 17, 34, 51, 68]);
  await store.put("4-resources/image.png", image, { contentType: "image/png" });
  const openedImage = await store.get("4-resources/image.png");
  check(
    "binary objects round-trip byte-for-byte with their logical MIME type",
    JSON.stringify([...new Uint8Array(await openedImage.arrayBuffer())]) ===
      JSON.stringify([...image]) && openedImage.contentType === "image/png",
  );

  await store.put("same-a.md", plaintext);
  await store.put("same-b.md", plaintext);
  check(
    "equal plaintext encrypts to different physical bytes",
    JSON.stringify([...raw.objects.get("same-a.md").body]) !==
      JSON.stringify([...raw.objects.get("same-b.md").body]),
  );

  const otherWorkspace = withManagedEncryption(raw, {
    workspaceId: "ws_managed_b",
    encryptionKey: encryption.encryptionKey,
  });
  check(
    "workspace A ciphertext cannot be opened as workspace B even with the same key",
    (await thrown(() => otherWorkspace.get("1-projects/roadmap.md"))) instanceof
      ManagedStorageCryptoError,
  );

  const wrongKey = withManagedEncryption(raw, context("ws_managed_a"));
  check(
    "a different workspace key cannot open managed ciphertext",
    (await thrown(() => wrongKey.get("1-projects/roadmap.md"))) instanceof
      ManagedStorageCryptoError,
  );

  const tampered = raw.objects.get("1-projects/roadmap.md");
  tampered.body[tampered.body.length - 1] ^= 1;
  check(
    "tampered managed ciphertext fails closed",
    (await thrown(() => store.get("1-projects/roadmap.md"))) instanceof
      ManagedStorageCryptoError,
  );
  tampered.body[tampered.body.length - 1] ^= 1;

  await raw.put("legacy-plaintext.md", "must never leak through");
  check(
    "an unexpected plaintext object in a managed bucket fails closed",
    (await thrown(() => store.get("legacy-plaintext.md"))) instanceof
      ManagedStorageCryptoError,
  );

  const oldMaterial = generateWorkspaceKey();
  const newMaterial = generateWorkspaceKey();
  const oldStore = withManagedEncryption(raw, {
    workspaceId: "ws_rotation",
    encryptionKey: { current: "old", keys: { old: oldMaterial } },
  });
  await oldStore.put("before.md", "before rotation");
  const rotatingStore = withManagedEncryption(raw, {
    workspaceId: "ws_rotation",
    encryptionKey: {
      current: "new",
      keys: { old: oldMaterial, new: newMaterial },
    },
  });
  await rotatingStore.put("after.md", "after rotation");
  check(
    "old generations remain readable while new writes use the current generation",
    (await (await rotatingStore.get("before.md")).text()) === "before rotation" &&
      (await (await rotatingStore.get("after.md")).text()) === "after rotation" &&
      decoder.decode(raw.objects.get("after.md").body).includes('"keyId":"new"'),
  );

  const current = await store.get("same-a.md");
  check(
    "conditional writes are forwarded against the physical ciphertext etag",
    (await store.put("same-a.md", "refused", { onlyIf: { etagMatches: "wrong" } })) === null &&
      (await store.put("same-a.md", "accepted", {
        onlyIf: { etagMatches: current.etag },
      }))?.etag !== undefined,
  );
  check(
    "managed encryption disables unsafe server-side ciphertext copy",
    store.capabilities.serverSideCopy === false && store.copy === undefined,
  );

  const logicalRaw = memoryStore();
  const logical = withLogicalDelete(withManagedEncryption(logicalRaw, context()));
  const created = await logical.put("deleted.md", "erase me");
  await logical.delete("deleted.md", { onlyIf: { etagMatches: created.etag } });
  const marker = logicalRaw.objects.get("deleted.md");
  check(
    "content-free logical tombstones remain readable metadata and stay hidden logically",
    marker.contentType === LOGICAL_DELETE_CONTENT_TYPE &&
      isLogicalDeleteMarker(marker.body) &&
      (await logical.get("deleted.md")) === null,
  );
}
