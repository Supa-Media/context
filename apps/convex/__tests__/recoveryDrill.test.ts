// @vitest-environment node
/**
 * Backup and recovery drill for managed-bucket encryption, on synthetic data.
 *
 * A security assessment asks whether encrypted customer data can actually be
 * brought back after losing the running system. Managed buckets hold note
 * bodies sealed (`apps/mcp/src/store/managedEncryption.js`); what opens them
 * is a chain of three things kept in three places:
 *
 *   1. the sealed objects, in the workspace's bucket;
 *   2. the workspace's data-key rows (`workspaceDataKeys`), in Convex, each
 *      sealed by `encryptSecret` (`functions/lib/crypto.ts`);
 *   3. `STORAGE_SECRET_ENCRYPTION_KEY`, the deployment's wrapping key, in the
 *      Convex environment with a copy kept outside it.
 *
 * This drill runs the shipping code for every step on throwaway fixtures:
 * seal notes through the real store wrapper, rotate the data key, take a
 * backup of the raw bucket bytes and the sealed rows (as a Convex export lays
 * a table out, one JSON document per line), throw everything in memory away,
 * then restore from the backup and a separately held copy of the wrapping key
 * and check every note byte for byte. It also proves the backup alone gives
 * nothing away, and that each missing link fails closed rather than serving
 * the wrong bytes.
 *
 * It is not proof that production can be restored: that needs the real
 * backups, the real key copy and a disposable deployment, which is an
 * infrastructure step (see `docs/recovery-drill.md`). It proves the chain
 * those steps rely on.
 *
 * Set `RECOVERY_DRILL_OUT` to a directory to keep the backup and a report
 * there for inspection; by default a temporary directory is used and removed.
 * Nothing written holds a key: the report has counts and SHA-256 digests of
 * synthetic content only.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Restoring with only the current data-key generation. → "every note
 *     comes back byte for byte, across a data-key rotation" fails.
 *  2. Backing up the store through the wrapper (plain bytes) instead of raw.
 *     → "the backup alone gives nothing away" fails.
 */

import { afterAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptSecret, encryptSecret, generateEncryptionKey, type Keyset } from "../functions/lib/crypto";
// The gateway's own wrapper and error, the same module `storeForBinding` uses.
import { ManagedEncryptionError, withManagedEncryption } from "../../mcp/src/store/managedEncryption.js";

const WORKSPACE = "ws_drill_synthetic";
const OTHER_WORKSPACE = "ws_drill_other";

/** A bucket: raw bytes by key, as R2 holds them. */
class MemoryBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  n = 0;
  capabilities = { conditionalWrite: true, conditionalCreate: true };
  async get(key: string) {
    const hit = this.objects.get(key);
    if (!hit) return null;
    const bytes = hit.bytes;
    return {
      etag: `e${this.n}`,
      contentType: hit.contentType,
      size: bytes.byteLength,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array, options: { contentType?: string } = {}) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: options.contentType });
    return { etag: `e${++this.n}` };
  }
  async list() {
    return { objects: [...this.objects.keys()].map((key) => ({ key })), truncated: false };
  }
}

function base64Key(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return Buffer.from(await crypto.subtle.digest("SHA-256", data)).toString("hex");
}

type Row = { workspaceId: string; generation: string; encryptedDataKey: string; retiredAt?: number; createdAt: number };

/** Synthetic notes: Markdown with non-ASCII text, and one binary attachment. */
function syntheticNotes(prefix: string, count: number): Array<{ key: string; body: Uint8Array; contentType: string }> {
  const notes = Array.from({ length: count }, (_, i) => ({
    key: `notes/${prefix}-${i}.md`,
    body: new TextEncoder().encode(`# Drill note ${prefix} ${i}\n\nSynthetic text, café ✓ ${"x".repeat(i * 37)}\n`),
    contentType: "text/markdown",
  }));
  notes.push({ key: `files/${prefix}-image.bin`, body: crypto.getRandomValues(new Uint8Array(4096)), contentType: "application/octet-stream" });
  return notes;
}

/** The control plane's half of opening a store: every row decrypted, the current one named. */
async function openDataKeys(rows: Row[], keyset: Keyset, workspaceId: string) {
  const keys: Record<string, string> = {};
  for (const row of rows) keys[row.generation] = await decryptSecret(row.encryptedDataKey, keyset, { workspaceId });
  const current = (rows.find((row) => row.retiredAt === undefined) ?? rows[rows.length - 1])!.generation;
  return { current, keys };
}

// One scenario, built once: two generations of notes, then a backup on disk.
const OUT = process.env.RECOVERY_DRILL_OUT;
let dir = "";
const wrappingKey = generateEncryptionKey();
const keyset: Keyset = { current: { id: "k1", material: wrappingKey } };
const manifest = new Map<string, string>();
let rows: Row[] = [];
let dataKeyMaterial: string[] = [];

async function buildAndBackUp() {
  dir = OUT ?? (await mkdtemp(join(tmpdir(), "context-recovery-drill-")));
  const bucket = new MemoryBucket();

  // Generation k1: first data key, sealed by the wrapping key, bound to the workspace.
  const k1 = base64Key();
  rows.push({ workspaceId: WORKSPACE, generation: "k1", encryptedDataKey: await encryptSecret(k1, keyset, { workspaceId: WORKSPACE }), createdAt: 1 });
  let store = withManagedEncryption(bucket as never, { workspaceId: WORKSPACE, mode: "encrypted", current: "k1", keys: { k1 } });
  for (const note of syntheticNotes("before-rotation", 6)) {
    await store.put(note.key, note.body, { contentType: note.contentType });
    manifest.set(note.key, await sha256(note.body));
  }

  // Rotation: k1 retired, k2 current. Old objects stay sealed under k1.
  const k2 = base64Key();
  rows[0]!.retiredAt = 2;
  rows.push({ workspaceId: WORKSPACE, generation: "k2", encryptedDataKey: await encryptSecret(k2, keyset, { workspaceId: WORKSPACE }), createdAt: 2 });
  store = withManagedEncryption(bucket as never, { workspaceId: WORKSPACE, mode: "encrypted", current: "k2", keys: { k1, k2 } });
  for (const note of syntheticNotes("after-rotation", 6)) {
    await store.put(note.key, note.body, { contentType: note.contentType });
    manifest.set(note.key, await sha256(note.body));
  }
  dataKeyMaterial = [k1, k2];

  // Backup: the raw bucket bytes, and the rows as a Convex export lays out a table.
  await mkdir(join(dir, "bucket", "notes"), { recursive: true });
  await mkdir(join(dir, "bucket", "files"), { recursive: true });
  for (const [key, object] of bucket.objects) await writeFile(join(dir, "bucket", key), object.bytes);
  await mkdir(join(dir, "convex", "workspaceDataKeys"), { recursive: true });
  await writeFile(join(dir, "convex", "workspaceDataKeys", "documents.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

/** Everything a restore has: the backup directory, read back from disk. */
async function readBackup() {
  const bucket = new MemoryBucket();
  for (const folder of ["notes", "files"]) {
    for (const name of await readdir(join(dir, "bucket", folder))) {
      bucket.objects.set(`${folder}/${name}`, { bytes: new Uint8Array(await readFile(join(dir, "bucket", folder, name))) });
    }
  }
  const jsonl = await readFile(join(dir, "convex", "workspaceDataKeys", "documents.jsonl"), "utf8");
  const restoredRows = jsonl.trim().split("\n").map((line) => JSON.parse(line) as Row);
  return { bucket, rows: restoredRows };
}

async function restoreAndRead(restoredRows: Row[], key: Keyset, bucket: MemoryBucket, workspaceId = WORKSPACE) {
  const opened = await openDataKeys(restoredRows, key, workspaceId);
  const store = withManagedEncryption(bucket as never, { workspaceId, mode: "encrypted", ...opened });
  const read = new Map<string, string>();
  for (const objectKey of manifest.keys()) {
    const object = await store.get(objectKey);
    read.set(objectKey, await sha256(new Uint8Array(await object!.arrayBuffer())));
  }
  return read;
}

const ready = buildAndBackUp();

afterAll(async () => {
  if (!OUT && dir) await rm(dir, { recursive: true, force: true });
});

describe("recovery drill on synthetic data", () => {
  test("the backup alone gives nothing away", async () => {
    await ready;
    const backup = await readBackup();
    expect(backup.bucket.objects.size).toBe(manifest.size);
    const plainPrefix = new TextEncoder().encode("# Drill note");
    for (const [key, object] of backup.bucket.objects) {
      // Every object is sealed: no plain Markdown, and not the bytes that were written.
      expect(Buffer.from(object.bytes).includes(Buffer.from(plainPrefix)), key).toBe(false);
      expect(await sha256(object.bytes)).not.toBe(manifest.get(key));
    }
    const everything = (await readFile(join(dir, "convex", "workspaceDataKeys", "documents.jsonl"), "utf8"))
      + [...backup.bucket.objects.values()].map((object) => Buffer.from(object.bytes).toString("latin1")).join("");
    for (const material of [wrappingKey, ...dataKeyMaterial]) {
      expect(everything.includes(material)).toBe(false);
      expect(everything.includes(Buffer.from(material, "base64").toString("latin1"))).toBe(false);
    }
  });

  test("every note comes back byte for byte, across a data-key rotation", async () => {
    await ready;
    const backup = await readBackup();
    // The only thing a restore brings from outside the backup: the wrapping key's kept copy.
    const read = await restoreAndRead(backup.rows, { current: { id: "k1", material: wrappingKey } }, backup.bucket);
    expect(read).toEqual(manifest);

    const report = {
      drill: "managed-encryption recovery, synthetic",
      objects: manifest.size,
      generations: backup.rows.map((row) => row.generation),
      restoredByteForByte: [...read].every(([key, digest]) => manifest.get(key) === digest),
      digests: Object.fromEntries(manifest),
    };
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  });

  test("a wrapping key rotated since the backup still opens it while the old key is kept as previous", async () => {
    await ready;
    const backup = await readBackup();
    const rotated: Keyset = { current: { id: "k2", material: generateEncryptionKey() }, previous: { id: "k1", material: wrappingKey } };
    expect(await restoreAndRead(backup.rows, rotated, backup.bucket)).toEqual(manifest);
  });

  test("without the kept wrapping key, nothing opens", async () => {
    await ready;
    const backup = await readBackup();
    await expect(restoreAndRead(backup.rows, { current: { id: "k1", material: generateEncryptionKey() } }, backup.bucket)).rejects.toThrow();
  });

  test("losing the retired generation's row loses exactly the notes sealed under it, and they fail closed", async () => {
    await ready;
    const backup = await readBackup();
    const opened = await openDataKeys(backup.rows.filter((row) => row.generation === "k2"), keyset, WORKSPACE);
    const store = withManagedEncryption(backup.bucket as never, { workspaceId: WORKSPACE, mode: "encrypted", ...opened });
    for (const key of manifest.keys()) {
      if (key.includes("before-rotation")) {
        await expect(store.get(key)).rejects.toBeInstanceOf(ManagedEncryptionError);
      } else {
        const object = await store.get(key);
        expect(await sha256(new Uint8Array(await object!.arrayBuffer()))).toBe(manifest.get(key));
      }
    }
  });

  test("rows restored under another workspace id do not open, and neither do its objects", async () => {
    await ready;
    const backup = await readBackup();
    await expect(restoreAndRead(backup.rows, keyset, backup.bucket, OTHER_WORKSPACE)).rejects.toThrow();
    // Even with the right data keys, objects are bound to their workspace.
    const opened = await openDataKeys(backup.rows, keyset, WORKSPACE);
    const elsewhere = withManagedEncryption(backup.bucket as never, { workspaceId: OTHER_WORKSPACE, mode: "encrypted", ...opened });
    await expect(elsewhere.get([...manifest.keys()][0]!)).rejects.toBeInstanceOf(ManagedEncryptionError);
  });

  test("a damaged object in the backup is refused, never served", async () => {
    await ready;
    const backup = await readBackup();
    const [key, object] = [...backup.bucket.objects][0]!;
    object.bytes[object.bytes.length - 1]! ^= 1;
    const opened = await openDataKeys(backup.rows, keyset, WORKSPACE);
    const store = withManagedEncryption(backup.bucket as never, { workspaceId: WORKSPACE, mode: "encrypted", ...opened });
    await expect(store.get(key)).rejects.toBeInstanceOf(ManagedEncryptionError);
  });
});
