import {
  ATTACHMENT_CONTENT_TYPE,
  MARKDOWN_CONTENT_TYPE,
} from "../../../mcp/src/store/index.js";

interface ReadableObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MigrationStore {
  get(key: string): Promise<ReadableObject | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options: { contentType: string },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

function sameBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Reconcile one listed key without ever deleting it from the source. */
export async function reconcileMigrationObject(options: {
  source: MigrationStore;
  target: MigrationStore;
  key: string;
  listedFromTarget: boolean;
  byteCap: number;
}): Promise<{ copied: number; changes: number }> {
  const sourceRead = await options.source.get(options.key);
  if (sourceRead === null) {
    if (options.listedFromTarget) {
      await options.target.delete(options.key);
      return { copied: 0, changes: 1 };
    }
    return { copied: 0, changes: 0 };
  }
  const bytes = await sourceRead.arrayBuffer();
  if (bytes.byteLength > options.byteCap) throw new Error("OBJECT_TOO_LARGE");
  const targetRead = await options.target.get(options.key);
  const matches =
    targetRead !== null && sameBytes(bytes, await targetRead.arrayBuffer());
  if (!matches) {
    await options.target.put(options.key, bytes, {
      contentType: options.key.toLowerCase().endsWith(".md")
        ? MARKDOWN_CONTENT_TYPE
        : ATTACHMENT_CONTENT_TYPE,
    });
  }
  const verified = await options.target.get(options.key);
  if (verified === null || !sameBytes(bytes, await verified.arrayBuffer())) {
    throw new Error("VERIFY_FAILED");
  }
  return { copied: 1, changes: matches ? 0 : 1 };
}
