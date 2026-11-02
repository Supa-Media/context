// @vitest-environment node
/**
 * Part 2 of the recovery drill (`docs/recovery-drill.md`): open a real
 * restore's artifacts with the shipping code.
 *
 * Skipped unless `RECOVERY_DRILL_FROM` names a directory. An operator fills it
 * from a synthetic-only drill, never from production:
 *
 *   bucket/notes/…, bucket/files/…            the drill bucket's raw objects
 *   convex/workspaceDataKeys/documents.jsonl  that table from the TARGET
 *                                             deployment's export, after the
 *                                             import (so the import is tested)
 *   digests.json                              { "<object key>": "<sha256 of the
 *                                             plain body>" } recorded at seeding
 *
 * plus `RECOVERY_DRILL_WORKSPACE` (the synthetic workspace's id) and
 * `RECOVERY_DRILL_WRAPPING_KEY` (the drill's own synthetic wrapping key, taken
 * from the copy kept outside Convex; never a production key). It writes
 * `report.json` beside the inputs: counts and pass/fail per object, no keys,
 * no bodies.
 */

import { describe, expect, test } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptSecret, type Keyset } from "../functions/lib/crypto";
import { withManagedEncryption } from "../../mcp/src/store/managedEncryption.js";

const FROM = process.env.RECOVERY_DRILL_FROM;
const WORKSPACE = process.env.RECOVERY_DRILL_WORKSPACE ?? "";
const WRAPPING_KEY = process.env.RECOVERY_DRILL_WRAPPING_KEY ?? "";
const WRAPPING_KEY_ID = process.env.RECOVERY_DRILL_WRAPPING_KEY_ID ?? "k1";

type Row = { workspaceId: string; generation: string; encryptedDataKey: string; retiredAt?: number };

async function sha256(bytes: Uint8Array): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");
}

/** A read-only bucket over the copied objects. */
async function bucketFrom(dir: string) {
  const objects = new Map<string, Uint8Array>();
  for (const folder of ["notes", "files"]) {
    const names = await readdir(join(dir, "bucket", folder)).catch(() => [] as string[]);
    for (const name of names) objects.set(`${folder}/${name}`, new Uint8Array(await readFile(join(dir, "bucket", folder, name))));
  }
  return {
    objects,
    capabilities: { conditionalWrite: true, conditionalCreate: true },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) return null;
      return { etag: "restored", size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
    },
    async put() {
      throw new Error("the drill never writes");
    },
    async list() {
      return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false };
    },
  };
}

describe.skipIf(!FROM)("recovery drill, part 2: a restore's artifacts open", () => {
  test("every seeded object opens byte for byte from the restored rows and the kept key", async () => {
    expect(WORKSPACE, "RECOVERY_DRILL_WORKSPACE").not.toBe("");
    expect(WRAPPING_KEY, "RECOVERY_DRILL_WRAPPING_KEY").not.toBe("");
    const dir = FROM!;
    const digests = JSON.parse(await readFile(join(dir, "digests.json"), "utf8")) as Record<string, string>;
    const jsonl = await readFile(join(dir, "convex", "workspaceDataKeys", "documents.jsonl"), "utf8");
    const rows = jsonl.trim().split("\n").map((line) => JSON.parse(line) as Row).filter((row) => row.workspaceId === WORKSPACE);
    expect(rows.length, "data-key rows for the workspace in the target's export").toBeGreaterThan(0);

    const keyset: Keyset = { current: { id: WRAPPING_KEY_ID, material: WRAPPING_KEY } };
    const keys: Record<string, string> = {};
    for (const row of rows) keys[row.generation] = await decryptSecret(row.encryptedDataKey, keyset, { workspaceId: WORKSPACE });
    const current = (rows.find((row) => row.retiredAt === undefined) ?? rows[rows.length - 1])!.generation;

    const bucket = await bucketFrom(dir);
    const store = withManagedEncryption(bucket as never, { workspaceId: WORKSPACE, mode: "encrypted", current, keys });
    const results: Record<string, "match" | "mismatch" | "missing" | "refused"> = {};
    for (const [key, expected] of Object.entries(digests)) {
      try {
        const object = await store.get(key);
        results[key] = object === null ? "missing" : (await sha256(new Uint8Array(await object.arrayBuffer()))) === expected ? "match" : "mismatch";
      } catch {
        results[key] = "refused";
      }
    }

    const report = {
      drill: "managed-encryption recovery, part 2 (synthetic source, isolated target)",
      objectsSeeded: Object.keys(digests).length,
      objectsInBucketCopy: bucket.objects.size,
      generations: rows.map((row) => row.generation),
      results,
      pass: Object.values(results).every((result) => result === "match"),
    };
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    expect(results).toEqual(Object.fromEntries(Object.keys(digests).map((key) => [key, "match"])));
  });
});
